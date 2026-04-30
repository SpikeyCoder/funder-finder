// Phase 5C: AI-assisted grant proposal draft generation
// Enhanced: reference doc style matching, deep research, MLA citations
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') || '';

const ALLOWED_ORIGINS = [
  'https://fundermatch.org',
  'https://spikeycoder.github.io',
];

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') || '';
  const headers: Record<string, string> = { 'Vary': 'Origin' };
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'authorization, x-client-info, apikey, content-type';
    headers['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS';
  }
  return headers;
}

function json(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } });
}

// Extract text from uploaded file in storage
async function extractFileText(supabase: any, storagePath: string): Promise<string> {
  try {
    const { data, error } = await supabase.storage
      .from('grant-uploads')
      .download(storagePath);
    if (error || !data) return '';
    // For text-based files, read directly
    const text = await data.text();
    // Return first 4000 chars to stay within context limits
    return text.substring(0, 4000);
  } catch {
    return '';
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('authorization') || '';
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const jwt = authHeader.replace('Bearer ', '');
  const { data: { user } } = await supabase.auth.getUser(jwt);
  if (!user) return json(req, { error: 'Unauthorized' }, 401);

  try {
    const {
      grant_id,
      project_id,
      prompt,
      section,
      include_research = false,
      reference_doc_ids = [],
    } = await req.json();

    // ── Gather context ────────────────────────────────────────────────────

    // Get project info
    const { data: project } = await supabase
      .from('projects')
      .select('name, description, location_scope, fields_of_work, keywords')
      .eq('id', project_id)
      .single();

    // Get grant info
    let grantInfo: any = null;
    if (grant_id) {
      const { data: grant } = await supabase
        .from('tracked_grants')
        .select('funder_name, funder_ein, grant_title, deadline, amount, awarded_amount, notes')
        .eq('id', grant_id)
        .single();
      grantInfo = grant;
    }

    // Get user profile for org context
    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('organization_name, mission_statement, city, state, budget_range, ntee_codes')
      .eq('id', user.id)
      .single();

    // ── Load reference documents ──────────────────────────────────────────

    let referenceDocContent = '';
    if (reference_doc_ids.length > 0) {
      const { data: refDocs } = await supabase
        .from('application_knowledge_base')
        .select('title, content, storage_path, source_type')
        .in('id', reference_doc_ids);

      const docTexts: string[] = [];
      for (const doc of refDocs || []) {
        let text = doc.content || '';
        // If there's a storage file and content is just a placeholder, try to extract
        if (doc.storage_path && text.startsWith('[Uploaded file:')) {
          const extracted = await extractFileText(supabase, doc.storage_path);
          if (extracted) text = extracted;
        }
        if (text) {
          docTexts.push(`--- Reference: ${doc.title} ---\n${text.substring(0, 3000)}`);
        }
      }
      referenceDocContent = docTexts.join('\n\n');
    }

    // Also load general KB entries (not tied to specific grant)
    const { data: kbEntries } = await supabase
      .from('application_knowledge_base')
      .select('title, content')
      .eq('user_id', user.id)
      .neq('source_type', 'reference_doc')
      .order('created_at', { ascending: false })
      .limit(3);

    const kbContext = (kbEntries || []).map((e: any) =>
      `--- ${e.title} ---\n${e.content.substring(0, 1500)}`
    ).join('\n\n');

    // ── Build research context ────────────────────────────────────────────

    const orgName = userProfile?.organization_name || project?.name || 'the organization';
    const orgLocation = userProfile?.city && userProfile?.state
      ? `${userProfile.city}, ${userProfile.state}` : '';
    const grantTopic = grantInfo?.grant_title || project?.description || '';
    const funderName = grantInfo?.funder_name || '';
    const fieldsOfWork = (project?.fields_of_work || []).join(', ');
    const keywords = (project?.keywords || []).join(', ');

    // ── Construct prompts ─────────────────────────────────────────────────

    const systemPrompt = `You are a senior grant writer who has decades of experience writing compelling, funded grant proposals for nonprofit organizations. You produce professional, evidence-based proposals that program officers find persuasive.

WRITING STYLE INSTRUCTIONS:
${referenceDocContent ? `
The user has provided reference documents from their organization's past proposals. You MUST carefully study these documents and mimic:
- Their sentence structure and paragraph length
- Their tone (formal, warm, data-driven, narrative, etc.)
- Their formatting patterns (how they structure sections, use headers, present data)
- Their vocabulary and phrasing preferences
- How they describe their organization and impact
Do NOT copy text verbatim. Instead, internalize the style and generate original content that reads as if the same author wrote it.
` : 'Use formal but accessible language appropriate for foundation program officers. Write in clear, compelling prose with specific measurable outcomes.'}

RESEARCH AND CITATIONS:
${include_research ? `
You MUST include recent, relevant, credible data and statistics to support the proposal. For each factual claim or statistic, include an MLA-style inline citation. At the end of the proposal, include a "Works Cited" section in proper MLA 9th edition format.

Focus your research context on:
- Recent statistics about the issue area (${grantTopic || fieldsOfWork})
- Relevant government reports, academic studies, or reputable nonprofit data
- Geographic-specific data if applicable (${orgLocation})
- Sector-specific trends and needs assessments

Use realistic, plausible data points based on your training knowledge. When citing, use the format: (Author/Org, "Title," Year) for inline citations.
` : 'Include inline citations [Source: entry_title] when referencing the knowledge base materials.'}

PROPOSAL STRUCTURE:
Generate a complete, well-structured grant proposal with these sections:
1. Executive Summary / Introduction
2. Statement of Need (with cited research and data)
3. Project Description and Goals
4. Methods / Implementation Plan
5. Expected Outcomes and Evaluation
6. Organizational Capacity
7. Budget Justification (brief overview)
8. Timeline
${include_research ? '9. Works Cited (MLA format)' : ''}`;

    const userPrompt = `ORGANIZATION CONTEXT:
Organization: ${orgName}
${userProfile?.mission_statement ? `Mission: ${userProfile.mission_statement}` : project?.description ? `Mission: ${project.description}` : ''}
${orgLocation ? `Location: ${orgLocation}` : ''}
${userProfile?.budget_range ? `Budget Range: ${userProfile.budget_range}` : ''}
${fieldsOfWork ? `Fields of Work: ${fieldsOfWork}` : ''}
${keywords ? `Keywords: ${keywords}` : ''}

GRANT DETAILS:
${funderName ? `Funder: ${funderName}` : ''}
${grantInfo?.grant_title ? `Grant Title: ${grantInfo.grant_title}` : ''}
${grantInfo?.amount ? `Grant Amount: $${grantInfo.amount.toLocaleString()}` : ''}
${grantInfo?.deadline ? `Deadline: ${grantInfo.deadline}` : ''}
${grantInfo?.notes ? `Notes: ${grantInfo.notes}` : ''}
${section ? `Section to write: ${section}` : ''}
${prompt ? `Additional instructions: ${prompt}` : ''}

${referenceDocContent ? `REFERENCE DOCUMENTS (study these for writing style):
${referenceDocContent}` : ''}

${kbContext ? `PAST APPLICATION MATERIALS:
${kbContext}` : ''}

Please generate a complete, professional grant proposal. ${include_research ? 'Include recent data with MLA citations and a Works Cited section.' : ''}`;

    // ── Generate with OpenAI ──────────────────────────────────────────────

    let draft = '';
    let citedSources: string[] = [];

    if (OPENAI_API_KEY) {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 4000,
          temperature: 0.65,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        console.error('OpenAI API error:', response.status, JSON.stringify(result));
        draft = `AI generation failed: ${result.error?.message || response.statusText}. Please verify your OPENAI_API_KEY is valid.`;
      } else {
        draft = result.choices?.[0]?.message?.content || 'Failed to parse AI response.';
      }

      // Extract cited sources
      const sourcePattern = /\[Source:\s*([^\]]+)\]/g;
      let match;
      const foundSources = new Set<string>();
      while ((match = sourcePattern.exec(draft)) !== null) {
        foundSources.add(match[1].trim());
      }
      // Also extract MLA-style inline citations
      const mlaPattern = /\(([^)]{5,80},\s*(?:"|')[^"']+(?:"|'),?\s*\d{4})\)/g;
      while ((match = mlaPattern.exec(draft)) !== null) {
        foundSources.add(match[1].trim());
      }
      citedSources = Array.from(foundSources);
    } else {
      // Fallback template
      draft = `# Grant Proposal Draft\n\n## Executive Summary\n${orgName} ${userProfile?.mission_statement ? `is dedicated to: ${userProfile.mission_statement}` : 'is committed to making a meaningful impact in our community.'}\n\n## Statement of Need\n${grantInfo?.grant_title ? `This proposal seeks funding from ${funderName} for ${grantInfo.grant_title}.` : 'This proposal outlines our plan for community impact.'}\n\n[Include relevant statistics and citations here]\n\n## Project Description\n- Goal 1: [Specific, measurable outcome]\n- Goal 2: [Specific, measurable outcome]\n\n## Implementation Plan\n[Describe methods and timeline]\n\n## Expected Outcomes\n[Describe evaluation metrics]\n\n## Budget Overview\n${grantInfo?.amount ? `Requested amount: $${grantInfo.amount.toLocaleString()}` : 'Budget to be determined.'}\n\n## Timeline\n${grantInfo?.deadline ? `Grant deadline: ${grantInfo.deadline}` : 'Timeline to be established.'}\n\n---\n*Note: Configure OPENAI_API_KEY in Supabase secrets for AI-powered draft generation with research and citations.*`;
    }

    // Build sources list
    const allSources = [
      ...(kbEntries || []).map((e: any) => ({
        id: e.title,
        title: e.title,
        type: 'knowledge_base',
        cited: citedSources.includes(e.title),
      })),
    ];

    return json(req, {
      draft,
      sources: allSources,
      citedSources,
      referenceDocsUsed: reference_doc_ids.length,
      researchIncluded: include_research,
    });
  } catch (err: any) {
    console.error('AI draft error:', err);
    return json(req, { error: err.message }, 500);
  }
});
