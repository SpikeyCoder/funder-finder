/**
 * research.ts — Deep research for grant narratives.
 *
 * Uses Tavily Search API for real-time web data, falls back to a
 * Claude-generated research block if Tavily is unavailable or thin.
 */

export interface ResearchFinding {
  topic: string;
  summary: string;
  source: string;
  url: string;
}

export interface ResearchData {
  findings: ResearchFinding[];
  statistics: string[];
  localContext: string;
  recentTrends: string[];
  fallbackUsed: boolean;
}

// ── Tavily web search ───────────────────────────────────────────────────────

async function tavilySearch(
  query: string,
  apiKey: string,
): Promise<{ title: string; url: string; content: string }[]> {
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'advanced',
        include_answer: false,
        max_results: 4,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map((r: any) => ({
      title: r.title || '',
      url: r.url || '',
      content: r.content || '',
    }));
  } catch {
    return [];
  }
}

// ── Build search queries from mission context ───────────────────────────────

function buildSearchQueries(
  mission: string,
  geoFocus: string,
  targetPop: string,
): string[] {
  // Extract key phrases (simple keyword extraction)
  const missionLower = mission.toLowerCase();
  const geo = geoFocus || '';
  const pop = targetPop || '';

  const queries: string[] = [];

  // Issue-area statistics
  queries.push(`${mission.slice(0, 100)} statistics data 2024 2025`);

  // Local/regional need
  if (geo) {
    queries.push(`${geo} community needs assessment nonprofit 2024`);
  }

  // Target population needs
  if (pop) {
    queries.push(`"${pop}" needs research outcomes data`);
  }

  // Funding trends
  queries.push(`nonprofit funding trends ${missionLower.includes('education') ? 'education' : missionLower.includes('health') ? 'health' : 'social services'} 2024 2025`);

  return queries.slice(0, 4);
}

// ── Compile results into structured research data ───────────────────────────

function compileResearch(
  allResults: { query: string; results: { title: string; url: string; content: string }[] }[],
  geoFocus: string,
): ResearchData {
  const findings: ResearchFinding[] = [];
  const statistics: string[] = [];
  const trends: string[] = [];
  let localContext = '';

  for (const { query, results } of allResults) {
    for (const r of results) {
      // Add as finding
      findings.push({
        topic: query.slice(0, 60),
        summary: r.content.slice(0, 300),
        source: r.title,
        url: r.url,
      });

      // Extract numeric facts (sentences with numbers/percentages)
      const sentences = r.content.split(/[.!?]+/);
      for (const s of sentences) {
        if (/\d+%|\$[\d,]+|\d+\s*(million|billion|thousand)/i.test(s) && s.trim().length > 20) {
          statistics.push(s.trim());
        }
      }

      // Geographic context
      if (geoFocus && r.content.toLowerCase().includes(geoFocus.toLowerCase().split(',')[0])) {
        localContext += r.content.slice(0, 200) + ' ';
      }

      // Trends (sentences with trend keywords)
      for (const s of sentences) {
        if (/trend|growing|increasing|rising|declining|emerging|shift/i.test(s) && s.trim().length > 20) {
          trends.push(s.trim());
        }
      }
    }
  }

  return {
    findings: findings.slice(0, 12),
    statistics: [...new Set(statistics)].slice(0, 10),
    localContext: localContext.trim().slice(0, 500) || 'No location-specific data found.',
    recentTrends: [...new Set(trends)].slice(0, 6),
    fallbackUsed: false,
  };
}

// ── Claude fallback research ────────────────────────────────────────────────

async function claudeFallbackResearch(
  mission: string,
  geoFocus: string,
  targetPop: string,
  anthropicApiKey: string,
): Promise<ResearchData> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250514',
        max_tokens: 1500,
        temperature: 0.4,
        system: `You are a nonprofit research assistant. Provide factual context to support a grant proposal. Return ONLY valid JSON.`,
        messages: [
          {
            role: 'user',
            content: `Provide research context for a grant proposal with this mission: "${mission}"
Geographic focus: ${geoFocus || 'not specified'}
Target population: ${targetPop || 'not specified'}

Return JSON:
{
  "statistics": ["5-8 relevant statistics with approximate numbers"],
  "localContext": "2-3 sentences about the local/regional context",
  "recentTrends": ["3-5 recent trends in this issue area"],
  "caveat": "Based on available knowledge; verify specific figures before submitting."
}`,
          },
        ],
      }),
    });

    if (!res.ok) throw new Error(`Claude API ${res.status}`);
    const data = await res.json();
    const text = data.content?.[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch?.[0] || '{}');

    return {
      findings: [],
      statistics: parsed.statistics || [],
      localContext: parsed.localContext || '',
      recentTrends: parsed.recentTrends || [],
      fallbackUsed: true,
    };
  } catch (err) {
    console.error('Claude fallback research failed:', err);
    return {
      findings: [],
      statistics: [],
      localContext: '',
      recentTrends: [],
      fallbackUsed: true,
    };
  }
}

// ── Main export ─────────────────────────────────────────────────────────────

export async function performResearch(
  mission: string,
  geoFocus: string,
  targetPop: string,
  tavilyApiKey: string | undefined,
  anthropicApiKey: string,
): Promise<ResearchData> {
  // Try Tavily first
  if (tavilyApiKey) {
    const queries = buildSearchQueries(mission, geoFocus, targetPop);
    const allResults = await Promise.all(
      queries.map(async (query) => ({
        query,
        results: await tavilySearch(query, tavilyApiKey),
      })),
    );

    const totalResults = allResults.reduce((sum, r) => sum + r.results.length, 0);

    if (totalResults >= 3) {
      return compileResearch(allResults, geoFocus);
    }

    console.log(`Tavily returned only ${totalResults} results, falling back to Claude`);
  }

  // Fallback to Claude knowledge
  return claudeFallbackResearch(mission, geoFocus, targetPop, anthropicApiKey);
}
