/**
 * prompt-builder.ts — Assemble the three-layer Claude prompt for grant generation.
 *
 * Layers:
 *   1. Style Guide  — tone, structure, phrasing from past grants (optional)
 *   2. Research Data — web-sourced statistics, trends, local context
 *   3. Funder + Org  — funder priorities, org details, mission
 */

import { StyleGuide } from './style-analysis.ts';
import { ResearchData } from './research.ts';

interface Funder {
  name: string;
  type: string;
  description: string | null;
  focus_areas: string[];
  city: string | null;
  state: string | null;
  grant_range_min: number | null;
  grant_range_max: number | null;
  total_giving: number | null;
  website: string | null;
}

interface OrgDetails {
  orgName: string;
  orgDesc: string;
  budget: string;
  targetPop: string;
  geoFocus: string;
  programName: string;
  programDesc: string;
  programBudget: string;
  outcomes: string;
  timeline: string;
}

function formatCurrency(n: number | null | undefined): string {
  if (!n) return 'N/A';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n}`;
}

// ── System prompt ───────────────────────────────────────────────────────────

function buildSystemPrompt(styleGuide: StyleGuide | null): string {
  let system = `You are an expert grant writer with 20+ years of experience securing foundation funding for nonprofits. You write compelling, data-backed grant narratives that align organizational strengths with funder priorities.

Your task: Generate a complete, ready-to-customize grant proposal draft.

Guidelines:
- Write in a professional yet warm tone
- Integrate statistics and research naturally into the narrative
- Be specific and avoid vague language
- Where research data or statistics are provided, use them to REPLACE bracketed placeholders with real numbers and cite sources in MLA format (Author Last, First. "Title." Publisher, Date. URL.)
- Only use [BRACKETS] for truly unknown org-specific data that the user has not provided and that research cannot fill (e.g. [YOUR EIN NUMBER], [EXACT NUMBER OF STAFF])
- Include section headers using ## for major sections
- End with a Works Cited section listing all sources referenced in MLA format
- End with a compliance checklist of items to verify before submission
- Target 2000-3000 words for a thorough draft

CRITICAL WRITING STYLE RULES — HUMAN-SOUNDING PROSE:
You must write like an experienced human grant writer, NOT like an AI. Strictly follow every rule below:

1. NEVER use em dashes (—). Use commas, periods, semicolons, colons, or parentheses instead.
2. NEVER use the construction "It's not X; it's Y" or "This isn't just X; it's Y" or any variation. Rephrase completely.
3. NEVER end a sentence with an isolated abstract noun used as a dramatic closer (e.g. "...and that means impact." or "...which drives change." or "...we deliver results."). Always follow abstract nouns with concrete details.
4. NEVER use "In today's [noun]" or "In an era of [noun]" as openers.
5. NEVER use "importantly" as a sentence adverb.
6. NEVER use "straightforward", "straightforwardly", or "notably" or "noteworthy".
7. NEVER use "landscape" as a metaphor (e.g. "the funding landscape", "the educational landscape").
8. NEVER use "navigate" metaphorically (e.g. "navigate challenges", "navigate complexity").
9. NEVER use "holistic" or "holistically" or "comprehensive" without specifying what is included.
10. NEVER use "foster" as a verb. Use "support", "build", "develop", "strengthen", or "grow" instead.
11. NEVER use "leverage" as a verb. Use "use", "apply", "draw on", or "build on" instead.
12. NEVER use "transform" or "transformative" without concrete before/after evidence.
13. NEVER begin consecutive paragraphs with the same sentence structure.
14. Vary sentence length. Mix short declarative sentences (8-12 words) with longer ones (20-30 words). Never use more than two long sentences in a row.
15. Use concrete numbers, names, and places instead of vague language like "many", "significant", "various", or "numerous".
16. Prefer active voice. Passive voice should be less than 15% of sentences.
17. NEVER use "delve", "dive deep", "unpack", "at the heart of", "moving forward", or "circle back".
18. Write section transitions that reference specific content from the previous section rather than using generic transitions like "Building on this foundation" or "With this in mind".`;

  if (styleGuide) {
    system += `

IMPORTANT — WRITING STYLE INSTRUCTIONS:
The organization has provided past successful grant proposals. Match their established writing style:
- Section structure: ${styleGuide.sectionOrder.join(' → ')}
- Average section length: ~${styleGuide.avgSectionWordCount} words per section
- Tone: ${styleGuide.toneDescription}
- Formatting: ${styleGuide.formattingPatterns.join('; ')}
- Opening approach: ${styleGuide.openingPattern}
- Data integration: ${styleGuide.dataIntegrationStyle}
- Echo these characteristic phrases where natural: ${styleGuide.samplePhrases.slice(0, 5).map(p => `"${p}"`).join(', ')}

Mirror this style closely — the organization's voice should be recognizable in the output.`;
  }

  return system;
}

// ── User message ────────────────────────────────────────────────────────────

function buildUserMessage(
  funder: Funder,
  mission: string,
  orgDetails: OrgDetails,
  research: ResearchData | null,
): string {
  const parts: string[] = [];

  // Funder context
  parts.push(`<FUNDER_CONTEXT>
Funder: ${funder.name}
Type: ${funder.type}
Location: ${[funder.city, funder.state].filter(Boolean).join(', ') || 'N/A'}
Focus Areas: ${funder.focus_areas?.join(', ') || 'General'}
Grant Range: ${formatCurrency(funder.grant_range_min)} – ${formatCurrency(funder.grant_range_max)}
Total Annual Giving: ${formatCurrency(funder.total_giving)}
Description: ${funder.description || 'Not available'}
Website: ${funder.website || 'N/A'}
</FUNDER_CONTEXT>`);

  // Research context
  if (research && (research.findings.length > 0 || research.statistics.length > 0)) {
    let researchBlock = '<RESEARCH_CONTEXT>\n';
    researchBlock += 'Use these verified facts and statistics to strengthen the narrative. Integrate them naturally throughout — do not dump all data in one section.\n\n';

    if (research.statistics.length > 0) {
      researchBlock += 'Key Statistics:\n';
      for (const stat of research.statistics) {
        researchBlock += `- ${stat}\n`;
      }
      researchBlock += '\n';
    }

    if (research.localContext && research.localContext !== 'No location-specific data found.') {
      researchBlock += `Local/Regional Context:\n${research.localContext}\n\n`;
    }

    if (research.recentTrends.length > 0) {
      researchBlock += 'Recent Trends:\n';
      for (const trend of research.recentTrends) {
        researchBlock += `- ${trend}\n`;
      }
      researchBlock += '\n';
    }

    if (research.findings.length > 0) {
      researchBlock += 'Supporting Sources:\n';
      for (const f of research.findings.slice(0, 6)) {
        researchBlock += `- ${f.source}: ${f.summary.slice(0, 150)}${f.url ? ` (${f.url})` : ''}\n`;
      }
    }

    if (research.mlaSources && research.mlaSources.length > 0) {
      researchBlock += 'MLA Source Citations (use these in Works Cited and inline citations):\n';
      for (const src of research.mlaSources) {
        researchBlock += `- ${src}\n`;
      }
      researchBlock += '\n';
    }

    if (research.fallbackUsed) {
      researchBlock += '\nNote: Research is based on general knowledge. The organization should verify specific figures before submission.\n';
    }

    researchBlock += '</RESEARCH_CONTEXT>';
    parts.push(researchBlock);
  }

  // Organization + mission context
  let orgBlock = '<ORG_CONTEXT>\n';
  orgBlock += `Mission: ${mission}\n`;
  if (orgDetails.orgName) orgBlock += `Organization: ${orgDetails.orgName}\n`;
  if (orgDetails.orgDesc) orgBlock += `About: ${orgDetails.orgDesc}\n`;
  if (orgDetails.budget) orgBlock += `Annual Budget: ${orgDetails.budget}\n`;
  if (orgDetails.targetPop) orgBlock += `Target Population: ${orgDetails.targetPop}\n`;
  if (orgDetails.geoFocus) orgBlock += `Geographic Focus: ${orgDetails.geoFocus}\n`;
  if (orgDetails.programName) orgBlock += `Program: ${orgDetails.programName}\n`;
  if (orgDetails.programDesc) orgBlock += `Program Description: ${orgDetails.programDesc}\n`;
  if (orgDetails.programBudget) orgBlock += `Amount Requested: ${orgDetails.programBudget}\n`;
  if (orgDetails.outcomes) orgBlock += `Expected Outcomes: ${orgDetails.outcomes}\n`;
  if (orgDetails.timeline) orgBlock += `Timeline: ${orgDetails.timeline}\n`;
  orgBlock += '</ORG_CONTEXT>';
  parts.push(orgBlock);

  // Final instruction
  parts.push(`Generate a complete grant proposal for ${funder.name} based on the above context.

IMPORTANT INSTRUCTIONS:
1. Structure the proposal with clear ## sections.
2. Use research statistics and findings to REPLACE generic [BRACKET] placeholders wherever possible. For example, instead of writing "[NUMBER OF PEOPLE AFFECTED]", write the actual number from the research data with an inline citation.
3. For every statistic or fact from the research, include a parenthetical MLA citation, e.g. ("Title" publisher.com).
4. Only leave [BRACKETS] for org-specific data the user has not provided and that cannot be found in research (like internal staff counts, specific EIN, board member names).
5. End with a ## Works Cited section listing all sources in MLA format.
6. Align the narrative with the funder's priorities and focus areas.
7. Follow ALL writing style rules in the system prompt. No em dashes, no AI-tell phrases.`);

  return parts.join('\n\n');
}

// ── Main export ─────────────────────────────────────────────────────────────

export function buildPrompt(
  funder: Funder,
  mission: string,
  orgDetails: OrgDetails,
  styleGuide: StyleGuide | null,
  research: ResearchData | null,
): { system: string; userMessage: string } {
  return {
    system: buildSystemPrompt(styleGuide),
    userMessage: buildUserMessage(funder, mission, orgDetails, research),
  };
}
