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
- Be specific — avoid vague language
- Use [BRACKETS] ONLY for data the user hasn't provided (e.g. [SPECIFIC NUMBER OF PARTICIPANTS])
- Include section headers using ## for major sections
- End with a compliance checklist of items to verify before submission
- Target 2000-3000 words for a thorough draft`;

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
  parts.push(`Generate a complete grant proposal for ${funder.name} based on the above context. Structure the proposal with clear sections, integrate the research data naturally, and align the narrative with the funder's priorities and focus areas.`);

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
