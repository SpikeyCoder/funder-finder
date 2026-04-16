/**
 * fetch-grant-deadline: scrape a funder's grant page and extract the deadline using Claude.
 *
 * POST body: { url: string, funder_name?: string }
 * Response:  { deadline: string | null, confidence: "high"|"medium"|"low"|"none", notes: string }
 */

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

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

  // Fetch the grant page
  let pageText = '';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const resp = await fetch(parsedUrl.toString(), {
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
    // If fetch fails, still try Claude with just the URL context
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
