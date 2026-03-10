/**
 * suggest-peers - Supabase Edge Function
 *
 * Receives { mission, locationServed, budgetBand }.
 * Uses OpenAI to semantically identify real peer nonprofits that share
 * a similar mission focus, geographic footprint, and budget range.
 *
 * Returns { peers: string[] } — an array of 5-8 real nonprofit names.
 */

const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') || '';

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

type BudgetBand =
  | 'under_250k'
  | '250k_1m'
  | '1m_5m'
  | 'over_5m'
  | 'prefer_not_to_say';

const BUDGET_DESCRIPTIONS: Record<BudgetBand, string> = {
  under_250k: 'under $250K annual budget',
  '250k_1m': '$250K–$1M annual budget',
  '1m_5m': '$1M–$5M annual budget',
  over_5m: 'over $5M annual budget',
  prefer_not_to_say: 'unknown budget size',
};

Deno.serve(async (req: Request) => {
  const requestOrigin = req.headers.get('origin');
  const headers = corsHeaders(requestOrigin);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers });
  }

  try {
    const body = await req.json();

    const mission =
      typeof body?.mission === 'string' ? body.mission.trim() : '';
    const locationServed =
      typeof body?.locationServed === 'string'
        ? body.locationServed.trim()
        : '';
    const budgetBand: BudgetBand =
      body?.budgetBand &&
      [
        'under_250k',
        '250k_1m',
        '1m_5m',
        'over_5m',
        'prefer_not_to_say',
      ].includes(body.budgetBand)
        ? body.budgetBand
        : 'prefer_not_to_say';

    if (!mission) {
      return new Response(
        JSON.stringify({ error: 'mission is required' }),
        {
          status: 400,
          headers: { ...headers, 'Content-Type': 'application/json' },
        },
      );
    }

    if (!OPENAI_API_KEY) {
      return new Response(
        JSON.stringify({ error: 'OpenAI API key not configured' }),
        {
          status: 500,
          headers: { ...headers, 'Content-Type': 'application/json' },
        },
      );
    }

    const budgetDesc = BUDGET_DESCRIPTIONS[budgetBand];
    const locationContext = locationServed
      ? `The nonprofit is based in or serves ${locationServed}.`
      : '';

    const systemPrompt = `You are a nonprofit sector expert. Given a nonprofit's mission statement, location, and budget size, suggest 5 to 8 REAL peer nonprofit organizations that are semantically similar. Peer nonprofits should share similar characteristics across these dimensions:

1. **Mission alignment**: Similar programmatic focus, target population, or service delivery model
2. **Geographic proximity**: Same metropolitan area, state, or region when possible
3. **Budget comparability**: Similar organizational size and budget range

Important rules:
- Only suggest REAL, currently operating U.S. nonprofit organizations
- Use the official legal name or widely-known operating name
- Prioritize organizations in the same geographic area
- Include a mix of very similar peers and slightly broader peers
- Do NOT include the nonprofit itself if identifiable from the mission
- Return ONLY the JSON array of names, no other text`;

    const userPrompt = `Mission statement: "${mission}"
${locationContext}
Budget: ${budgetDesc}

Return a JSON array of 5-8 real peer nonprofit names. Example format:
["Organization A", "Organization B", "Organization C"]`;

    const openaiRes = await fetch(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.4,
          max_tokens: 500,
        }),
      },
    );

    if (!openaiRes.ok) {
      const errBody = await openaiRes.text();
      console.error('OpenAI error:', openaiRes.status, errBody);
      return new Response(
        JSON.stringify({
          error: 'Failed to generate peer suggestions',
        }),
        {
          status: 502,
          headers: { ...headers, 'Content-Type': 'application/json' },
        },
      );
    }

    const openaiData = await openaiRes.json();
    const rawContent =
      openaiData?.choices?.[0]?.message?.content?.trim() || '[]';

    // Parse the JSON array from the response
    let peers: string[] = [];
    try {
      // Strip markdown code fences if present
      const cleaned = rawContent
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        peers = parsed
          .filter(
            (item: unknown) =>
              typeof item === 'string' && item.trim().length >= 3,
          )
          .map((item: string) => item.trim())
          .slice(0, 8);
      }
    } catch {
      console.error('Failed to parse OpenAI response as JSON:', rawContent);
      peers = [];
    }

    return new Response(JSON.stringify({ peers }), {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('suggest-peers error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      {
        status: 500,
        headers: {
          ...corsHeaders(req.headers.get('origin')),
          'Content-Type': 'application/json',
        },
      },
    );
  }
});
