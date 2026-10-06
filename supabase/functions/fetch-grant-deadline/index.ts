/**
 * fetch-grant-deadline: scrape a funder's grant page and extract the deadline using Claude.
 *
 * POST body: { url: string, funder_name?: string }
 * Response:  { deadline: string | null, confidence: "high"|"medium"|"low"|"none", notes: string }
 */

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';

import { safeFetch, SSRFBlockedError } from '../_shared/safe_fetch.ts';
import { ipRateLimit } from '../_shared/rate_limit.ts';
import { corsHeaders } from '../_shared/cors.ts';

// FM-2026-07-04-01: migrate this endpoint off the hardcoded
// `Access-Control-Allow-Origin: *` and onto the shared allowlist helper
// (`_shared/cors.ts`), matching the 30 other Edge Functions. This was the
// last function still returning wildcard CORS. The FunderMatch app calls this
// endpoint from an allowlisted origin (see src/pages/ProjectWorkspace.tsx), so
// browser callers are unaffected; the deadline-sync cron uses a service-role
// token with no Origin header and is CORS-exempt. `corsHeaders` also adds
// `Vary: Origin` for correct cross-origin caching.

// Strip HTML tags and collapse whitespace for a readable plain-text excerpt
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req.headers.get('origin'), { methods: 'POST, OPTIONS' });

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // FM-2026-06-07-01: per-IP rate limit for LLM-backed endpoint.
  // This endpoint fans out to (a) safeFetch against a user-supplied
  // grant URL and (b) Claude Haiku. The SSRF guard in safe_fetch.ts
  // already prevents internal targets; this rate limit caps the
  // cost of high-volume legitimate-looking calls (Denial-of-Wallet,
  // CWE-770). 10/min is comfortably above the check-deadlines cron
  // pattern (the cron passes a service-role token; the limiter
  // never sees cron traffic because the cron runs inside the same
  // Edge isolate without an IP header).
  const limited = await ipRateLimit(req, {
    namespace: 'fetch-grant-deadline',
    limit: 10,
    windowMs: 60_000,
    extraHeaders: cors,
  });
  if (!limited.allow) return limited.response!;

  if (!ANTHROPIC_API_KEY) {
    return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  }

  let body: { url?: string; funder_name?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { url, funder_name = '' } = body;
  if (!url || typeof url !== 'string') {
    return json({ error: 'url is required' }, 400);
  }

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return json({ error: 'URL must use http or https' }, 400);
    }
  } catch {
    return json({ error: 'Invalid URL' }, 400);
  }

  // Fetch the grant page via SSRF-aware wrapper.
  //
  // FM-2026-06-05-01: `safeFetch` enforces:
  //   - http(s) scheme only,
  //   - resolved IP is not in any private / loopback / link-local /
  //     reserved / cloud-metadata range (covers AWS / GCP / Azure IMDS),
  //   - redirects are re-validated per hop (defeats DNS rebinding /
  //     redirect pivot to internal endpoints).
  // SSRF rejections are returned to the caller as 400 so a misconfigured
  // grant URL surfaces visibly instead of silently failing as 'no
  // deadline found' — the latter would let an attacker side-channel the
  // SSRF guard by inferring 'no fetch happened' vs 'fetch happened'.
  let pageText = '';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const resp = await safeFetch(parsedUrl.toString(), {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 FunderMatch-Bot/1.0',
        'Accept': 'text/html',
      },
    });
    clearTimeout(timeout);
    if (resp.ok) {
      const raw = await resp.text();
      pageText = htmlToText(raw).slice(0, 6000); // limit to ~6k chars for context
    }
  } catch (err) {
    if (err instanceof SSRFBlockedError) {
      console.warn(`fetch-grant-deadline SSRF blocked: ${err.message}`);
      return json({ error: 'URL refers to a private, reserved, or cloud-metadata address.' }, 400);
    }
    // Any other transport failure — fall through to Claude with no body.
    pageText = '';
  }

  // Ask Claude to extract the deadline
  const systemPrompt = `You are a grant research assistant. Extract the application deadline from the provided webpage text. Return ONLY valid JSON with these fields:
- "deadline": the deadline date in YYYY-MM-DD format, or null if not found
- "confidence": "high" if the date is explicit and unambiguous, "medium" if inferred, "low" if uncertain, "none" if no deadline found
- "notes": a brief one-sentence explanation (e.g. "Found 'Applications due March 15, 2026' in body text")

Today's date is ${new Date().toISOString().split('T')[0]}.
If the deadline has already passed, still return it. Return only the JSON object, no markdown.`;

  const userPrompt = `Funder: ${funder_name || 'Unknown'}
URL: ${url}

Page content:
${pageText || '(page could not be fetched — use only the URL as context)'}`;

  let deadline: string | null = null;
  let confidence: string = 'none';
  let notes = 'Could not extract deadline';

  try {
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (claudeResp.ok) {
      const claudeData = await claudeResp.json();
      const text = claudeData.content?.[0]?.text?.trim() || '';
      // Strip markdown code fences if present
      const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      const parsed = JSON.parse(cleaned);
      deadline = parsed.deadline || null;
      confidence = parsed.confidence || 'none';
      notes = parsed.notes || '';

      // Validate date format
      if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
        deadline = null;
        confidence = 'none';
        notes = 'Extracted date was not in YYYY-MM-DD format';
      }
    }
  } catch {
    // Return gracefully with no deadline
  }

  return json({ deadline, confidence, notes });
});
