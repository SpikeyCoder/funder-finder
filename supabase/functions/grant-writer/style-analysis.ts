/**
 * style-analysis.ts — Analyze past grant texts to extract a StyleGuide.
 *
 * Uses a small Claude call to analyze 1-3 extracted grant texts and return
 * structured style information (tone, structure, formatting patterns).
 */

export interface StyleGuide {
  sectionOrder: string[];
  avgSectionWordCount: number;
  toneDescription: string;
  formattingPatterns: string[];
  openingPattern: string;
  dataIntegrationStyle: string;
  samplePhrases: string[];
}

const STYLE_ANALYSIS_PROMPT = `You are an expert grant writing analyst. Analyze the following past successful grant proposal(s) and extract a concise style guide.

Return ONLY valid JSON matching this exact schema — no markdown, no explanation:
{
  "sectionOrder": ["string array of section headers in order, e.g. Executive Summary, Statement of Need, ..."],
  "avgSectionWordCount": number,
  "toneDescription": "1-2 sentence description of writing tone and voice",
  "formattingPatterns": ["array of formatting observations, e.g. Uses bullet lists for outcomes, Paragraph-heavy narrative"],
  "openingPattern": "How the proposal typically opens — 1 sentence",
  "dataIntegrationStyle": "How data/statistics are woven in — 1 sentence",
  "samplePhrases": ["5-10 characteristic phrases that define the writing style"]
}`;

export async function analyzeStyle(
  grantTexts: string[],
  anthropicApiKey: string,
): Promise<StyleGuide | null> {
  if (!grantTexts.length) return null;

  // Build user message with all grant texts
  const userContent = grantTexts
    .map(
      (text, i) =>
        `<GRANT_${i + 1}>\n${text.slice(0, 20_000)}\n</GRANT_${i + 1}>`,
    )
    .join('\n\n');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1024,
        temperature: 0.3,
        system: STYLE_ANALYSIS_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Analyze ${grantTexts.length} past grant proposal(s):\n\n${userContent}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      console.error('Style analysis API error:', response.status);
      return null;
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';

    // Extract JSON (Claude may wrap in ```json blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('Style analysis: no JSON found in response');
      return null;
    }

    return JSON.parse(jsonMatch[0]) as StyleGuide;
  } catch (err) {
    console.error('Style analysis failed:', err);
    return null;
  }
}
