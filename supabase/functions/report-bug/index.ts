const ALLOWED_ORIGINS = new Set([
  'https://fundermatch.org',
  'https://www.fundermatch.org',
  'https://spikeycoder.github.io',
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
      JSON.stringify({ error: err instanceof Error ? err.message : 'Internal server error' }),
      {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json' },
      },
    );
  }
});
