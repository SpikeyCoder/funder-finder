// Phase 4: AI-assisted grant proposal draft generation
// MIGRATED TO USER-SCOPED AUTH: Uses authenticated user context instead of SERVICE_ROLE_KEY
// Enhanced: reference doc style matching, deep research, MLA citations
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { createUserScopedClient } from "../_shared/user-client.ts";

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') || '';

import { corsHeaders as _corsHeaders } from "../_shared/cors.ts";

const CORS_OPTS = { methods: "POST, OPTIONS" } as const;
function CORS(req: Request | null = null): Record<string, string> {
  return _corsHeaders(req?.headers.get("origin") ?? null, CORS_OPTS);
}

function json(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS(req), 'Content-Type': 'application/json' } });
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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS(req) });
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405);

  try {
    // Phase 4: Use user-scoped client with JWT validation
    const { supabase, user } = await createUserScopedClient(req);

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
    } = await req.json();

    // Load grant, project, and user profile in parallel
    const [grantInfo, project, userProfile] = await Promise.all([
      grant_id
        ? supabase.from('tracked_grants').select('*').eq('id', grant_id).single()
        : Promise.resolve({ data: null, error: null }),
      project_id
        ? supabase.from('projects').select('*').eq('id', project_id).single()
        : Promise.resolve({ data: null, error: null }),
      supabase.from('user_profiles').select('*').eq('id', user.id).single(),
    ]);

    if ((grantInfo.error && grant_id) || (project.error && project_id) || userProfile.error) {
      return json(req, { error: 'Could not load required data' }, 400);
    }

    // ── Load reference documents ──────────────────────────────────────────

    let referenceDocContent = '';
    const reference_doc_ids = Array.isArray(prompt) ? [] : [];
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

    const orgName = userProfile.data?.organization_name || project.data?.name || 'the organization';
    const orgLocation = userProfile.data?.city && userProfile.data?.state
      ? `${userProfile.data.city}, ${userProfile.data.state}` : '';
    const grantTopic = grantInfo.data?.grant_title || project.data?.description || '';
    const funderName = grantInfo.data?.funder_name || '';
    const fieldsOfWork = (project.data?.fields_of_work || []).join(', ');
    const keywords = (project.data?.keywords || []).join(', ');

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
You MUST include recent, relevant, credible data and statistics to support the proposal. For each factual claim or statistic, include an MLA-style inline citation. At the end of the proposal, include a "Works Cited" section in proper MLA 9th edition format.

Focus your research context on:
- Recent statistics about the issue area (${grantTopic || fieldsOfWork})
- Relevant government reports, academic studies, or reputable nonprofit data
- Geographic-specific data if applicable (${orgLocation})
- Sector-specific trends and needs assessments

Use realistic, plausible data points based on your training knowledge. When citing, use the format: (Author/Org, "Title," Year) for inline citations.

PROPOSAL STRUCTURE:
Generate a complete, well-structured grant proposal with these sections:
1. Executive Summary / Introduction
2. Statement of Need (with data and citations)
3. Project Description & Goals
4. Implementation Plan & Timeline
5. Evaluation Methods
6. Budget Overview
7. Organizational Capacity
8. Works Cited

${referenceDocContent ? `\n\nREFERENCE DOCUMENTS (study the style carefully):\n${referenceDocContent}` : ''}
${kbContext ? `\n\nORGANIZATIONAL KNOWLEDGE BASE:\n${kbContext}` : ''}
`;

    const userPrompt = prompt || `Write a comprehensive grant proposal for ${orgName} to submit to ${funderName} for: ${grantTopic}`;

    // ── Call OpenAI ───────────────────────────────────────────────────────

    let draft = '';
    if (OPENAI_API_KEY) {
      try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'gpt-4',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            temperature: 0.7,
            max_tokens: 3000,
          }),
        });

        if (response.ok) {
          const result = await response.json();
          draft = result.choices?.[0]?.message?.content || '';
        }
      } catch (err) {
        console.error('[ai-draft] OpenAI error:', err);
      }
    }

    // Fallback template if OpenAI unavailable
    if (!draft) {
      let citedSources: string[] = [];
      try {
        const sources = kbEntries?.map((e: any) => e.title) || [];
        citedSources = Array.from(new Set(sources));
      } catch {}
      draft = `# Grant Proposal Draft\n\n## Executive Summary\n${orgName} ${userProfile.data?.mission_statement ? `is dedicated to: ${userProfile.data.mission_statement}` : 'is committed to making a meaningful impact in our community.'}\n\n## Statement of Need\n${grantInfo.data?.grant_title ? `This proposal seeks funding from ${funderName} for ${grantInfo.data.grant_title}.` : 'This proposal outlines our plan for community impact.'}\n\n[Include relevant statistics and citations here]\n\n## Project Description\n- Goal 1: [Specific, measurable outcome]\n- Goal 2: [Specific, measurable outcome]\n\n## Implementation Plan\n[Describe methods and timeline]\n\n## Expected Outcomes\n[Describe evaluation metrics]\n\n## Budget Overview\n${grantInfo.data?.amount ? `Requested amount: $${grantInfo.data.amount.toLocaleString()}` : 'Budget to be determined.'}\n\n## Timeline\n${grantInfo.data?.deadline ? `Grant deadline: ${grantInfo.data.deadline}` : 'Timeline to be established.'}\n\n---\n*Note: Configure OPENAI_API_KEY in Supabase secrets for AI-powered draft generation with research and citations.*`;
    }

    return json(req, { draft });
  } catch (err: any) {
    const status = err.message?.includes('Unauthorized') || err.message?.includes('JWT') ? 401 : 500;
    return json(req, { error: err.message || 'Internal server error' }, status);
  }
});
