import { ipRateLimit } from "../_shared/rate_limit.ts";
const ALLOWED_ORIGINS = new Set([
  'https://fundermatch.org',
  'https://www.fundermatch.org',
  'http://localhost:5173',
]);

function corsHeaders(requestOrigin: string | null): Record<string, string> {
  const origin =
    requestOrigin && ALLOWED_ORIGINS.has(requestOrigin)
      ? requestOrigin
      : 'https://fundermatch.org';

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    Vary: 'Origin',
  };
}

interface TechnicalContext {
  url: string;
  pageName: string;
  deviceType: string;
  userAgent: string;
  platform: string;
  viewportSize: string;
  screenSize: string;
  timestamp: string;
  recentErrors: string[];
}

interface BugReportPayload {
  description: string;
  isFeatureRequest: boolean;
  screenshotUrl: string | null;
  technicalContext: TechnicalContext;
}

const SUPABASE_STORAGE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co/storage/v1/object/public/bug-screenshots/';

// Pre-parsed reference so we can compare hostname + path-prefix structurally
// instead of via brittle string-prefix matching. Pen-test 2026-05-11
// (FM-2026-05-11-02): a `startsWith` check accepts crafted paths like
// `…/bug-screenshots/../something/foo.png` because the literal characters
// match, but the resolved URL points elsewhere. Using URL parsing forces
// the runtime to normalise the path before we compare.
const STORAGE_REFERENCE = new URL(SUPABASE_STORAGE_URL);
const STORAGE_PATH_PREFIX = STORAGE_REFERENCE.pathname; // "/storage/v1/object/public/bug-screenshots/"

const MAX_DESCRIPTION_LENGTH = 2000;

function isValidScreenshotUrl(url: string): boolean {
  // Only allow URLs pointing to our own Supabase storage bucket.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.hostname !== STORAGE_REFERENCE.hostname) return false;
  // The normalised pathname must start with the bucket prefix AND not
  // escape it via traversal segments. URL parsing already resolves `..`,
  // so an attempt like ".../bug-screenshots/../other" comes through with
  // a pathname of "/storage/v1/object/public/other" and fails here.
  if (!parsed.pathname.startsWith(STORAGE_PATH_PREFIX)) return false;
  // Defence-in-depth: reject any residual traversal markers.
  const tail = parsed.pathname.slice(STORAGE_PATH_PREFIX.length);
  if (tail.split('/').some((seg) => seg === '..' || seg === '.')) return false;
  return true;
}

function buildCardDescription(payload: BugReportPayload): string {
  const { description, technicalContext: ctx } = payload;
  const lines: string[] = [description, '', '---'];

  lines.push('📋 **Technical Context**');
  lines.push(`- **URL:** ${ctx.url}`);
  lines.push(`- **Page:** ${ctx.pageName}`);
  lines.push(`- **Device:** ${ctx.deviceType}`);
  lines.push(`- **Browser / OS:** ${ctx.userAgent}`);
  lines.push(`- **Platform:** ${ctx.platform}`);
  lines.push(`- **Viewport:** ${ctx.viewportSize}`);
  lines.push(`- **Screen:** ${ctx.screenSize}`);
  lines.push(`- **Timestamp:** ${ctx.timestamp}`);

  if (ctx.recentErrors && ctx.recentErrors.length > 0) {
    lines.push('');
    lines.push('⚠️ **Recent Console Errors**');
    for (const err of ctx.recentErrors) {
      lines.push(`- ${err}`);
    }
  }

  return lines.join('\n');
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const cors = corsHeaders(origin);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }

  // FM-2026-05-28-01: defence-in-depth per-IP rate limit on the public,
  // unauthenticated POST endpoint. Without this, anyone able to reach the
  // function URL (or any allowed origin) can flood Trello with cards and
  // exhaust the Trello API quota / pollute the bug-triage board.
  // Mirrors share-link / calendar-feed (FM-2026-05-09-01, FM-2026-05-10-02).
  // 20 req/min/IP is well above any plausible legitimate per-user
  // reporting cadence and short-circuits abuse before Trello is touched.
  const limited = await ipRateLimit(req, {
    namespace: "report-bug",
    limit: 20,
    windowMs: 60_000,
    extraHeaders: cors,
  });
  if (!limited.allow && limited.response) return limited.response;

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  try {
    const payload: BugReportPayload = await req.json();

    if (!payload.description || typeof payload.description !== 'string' || !payload.description.trim()) {
      return new Response(JSON.stringify({ error: 'Description is required' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Server-side length cap
    if (payload.description.length > MAX_DESCRIPTION_LENGTH) {
      return new Response(JSON.stringify({ error: 'Description too long' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Validate screenshotUrl — only allow our own Supabase storage URLs (prevents SSRF)
    if (payload.screenshotUrl && !isValidScreenshotUrl(payload.screenshotUrl)) {
      console.warn('Rejected invalid screenshotUrl:', payload.screenshotUrl);
      payload.screenshotUrl = null; // Silently drop invalid URL, still create the card
    }

    // Build Trello card
    const prefix = payload.isFeatureRequest ? '[FEATURE REQUEST]' : '[BUG]';
    const titleText = payload.description.trim().slice(0, 60);
    const cardName = `${prefix} ${titleText}${payload.description.trim().length > 60 ? '...' : ''}`;
    const cardDesc = buildCardDescription(payload);

    const TRELLO_API_KEY = Deno.env.get('TRELLO_API_KEY');
    const TRELLO_TOKEN = Deno.env.get('TRELLO_TOKEN');
    const TRELLO_LIST_ID = Deno.env.get('TRELLO_LIST_ID');

    if (!TRELLO_API_KEY || !TRELLO_TOKEN || !TRELLO_LIST_ID) {
      console.error('Missing Trello configuration — check edge function secrets');
      return new Response(JSON.stringify({ error: 'Server configuration error' }), {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Create the Trello card
    const cardParams = new URLSearchParams({
      key: TRELLO_API_KEY,
      token: TRELLO_TOKEN,
      idList: TRELLO_LIST_ID,
      name: cardName,
      desc: cardDesc,
      pos: 'top',
    });

    const cardResp = await fetch(`https://api.trello.com/1/cards?${cardParams.toString()}`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });

    if (!cardResp.ok) {
      const errBody = await cardResp.text();
      console.error('Trello card creation failed:', cardResp.status, errBody);
      return new Response(JSON.stringify({ error: 'Failed to create report card' }), {
        status: 502,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const card = await cardResp.json();

    // Attach screenshot if provided
    if (payload.screenshotUrl) {
      const attachParams = new URLSearchParams({
        key: TRELLO_API_KEY,
        token: TRELLO_TOKEN,
        url: payload.screenshotUrl,
        name: 'screenshot.png',
      });

      const attachResp = await fetch(
        `https://api.trello.com/1/cards/${card.id}/attachments?${attachParams.toString()}`,
        {
          method: 'POST',
          headers: { Accept: 'application/json' },
        },
      );

      if (!attachResp.ok) {
        console.warn('Screenshot attachment failed:', attachResp.status);
        // Non-blocking — card was still created
      }
    }

    return new Response(JSON.stringify({ ok: true, cardId: card.id }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('report-bug error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json' },
      },
    );
  }
});
