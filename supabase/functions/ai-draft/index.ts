// Phase 5C: AI-assisted grant proposal draft generation
// Enhanced: reference doc style matching, deep research, MLA citations
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') || '';
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('authorization') || '';
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const jwt = authHeader.replace('Bearer ', '');
  const { data: { user } } = await supabase.auth.getUser(jwt);
  if (!user) return json({ error: 'Unauthorized' }, 401);

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

    // ── Generate with AI (multi-model fallback chain) ──────────────────────

    let draft = '';
    let citedSources: string[] = [];
    let modelUsed = 'template';

    // Helper: try an OpenAI-compatible model
    async function tryOpenAI(model: string): Promise<string | null> {
      if (!OPENAI_API_KEY) return null;
      try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model,
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
          console.warn(`OpenAI ${model} failed (${response.status}):`, result.error?.message);
          return null;
        }
        const text = result.choices?.[0]?.message?.content;
        return text || null;
      } catch (err) {
        console.warn(`OpenAI ${model} network error:`, err);
        return null;
      }
    }

    // Helper: try Anthropic Claude
    async function tryAnthropic(): Promise<string | null> {
      if (!ANTHROPIC_API_KEY) return null;
      try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4000,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
          }),
        });
        const result = await response.json();
        if (!response.ok) {
          console.warn(`Anthropic failed (${response.status}):`, result.error?.message);
          return null;
        }
        const text = result.content?.[0]?.text;
        return text || null;
      } catch (err) {
        console.warn('Anthropic network error:', err);
        return null;
      }
    }

    // Fallback chain: try models in order until one succeeds
    const fallbackChain: Array<{ name: string; fn: () => Promise<string | null> }> = [
      { name: 'gpt-4o-mini', fn: () => tryOpenAI('gpt-4o-mini') },
      { name: 'gpt-3.5-turbo', fn: () => tryOpenAI('gpt-3.5-turbo') },
      { name: 'claude-sonnet', fn: () => tryAnthropic() },
    ];

    for (const { name, fn } of fallbackChain) {
      const result = await fn();
      if (result) {
        draft = result;
        modelUsed = name;
        break;
      }
    }

    // Ultimate fallback: generate a structured template (never show raw errors)
    if (!draft) {
      const mission = userProfile?.mission_statement || project?.description || 'making a meaningful impact in our community';
      const locationStr = orgLocation ? ` based in ${orgLocation}` : '';
      const budgetStr = grantInfo?.amount ? `$${Number(grantInfo.amount).toLocaleString()}` : '[amount to be determined]';
      const deadlineStr = grantInfo?.deadline || '[deadline to be established]';

      draft = `# Grant Proposal: ${grantInfo?.grant_title || orgName}\n\n` +
        `## Executive Summary\n\n` +
        `${orgName}${locationStr} respectfully requests funding${funderName ? ` from ${funderName}` : ''} to advance our mission of ${mission}. ` +
        `This proposal outlines our evidence-based approach, organizational capacity, and measurable outcomes for the proposed project.\n\n` +
        `## Statement of Need\n\n` +
        `[This section should include recent, locally-relevant statistics about the issue your project addresses. ` +
        `Cite reputable sources such as Census data, CDC reports, or peer-reviewed studies to establish the urgency and scale of the need.]\n\n` +
        `${fieldsOfWork ? `Our work spans ${fieldsOfWork}, where we have identified significant unmet needs in the communities we serve.\n\n` : ''}` +
        `## Project Description and Goals\n\n` +
        `**Goal 1:** [Specific, measurable outcome — e.g., "Serve 500 individuals in Year 1"]\n\n` +
        `**Goal 2:** [Specific, measurable outcome — e.g., "Achieve 80% participant completion rate"]\n\n` +
        `**Goal 3:** [Specific, measurable outcome]\n\n` +
        `## Methods and Implementation Plan\n\n` +
        `| Phase | Timeline | Activities | Deliverables |\n` +
        `|-------|----------|------------|--------------|\n` +
        `| Planning | Months 1-2 | Hire staff, establish partnerships | Staffing plan, MOUs |\n` +
        `| Launch | Months 3-4 | Begin program delivery | Enrollment targets met |\n` +
        `| Full Operations | Months 5-10 | Ongoing service delivery | Quarterly reports |\n` +
        `| Evaluation | Months 11-12 | Data analysis, final reporting | Final report, outcomes data |\n\n` +
        `## Expected Outcomes and Evaluation\n\n` +
        `We will measure success through:\n\n` +
        `- **Output metrics:** Number of participants served, services delivered\n` +
        `- **Outcome metrics:** Changes in knowledge, behavior, or conditions\n` +
        `- **Impact metrics:** Long-term community-level changes\n\n` +
        `## Organizational Capacity\n\n` +
        `${orgName} has the experience, staffing, and infrastructure to execute this project successfully. ` +
        `[Add details about your organization's track record, key staff qualifications, and relevant past projects.]\n\n` +
        `## Budget Overview\n\n` +
        `**Total Request:** ${budgetStr}\n\n` +
        `| Category | Amount | % of Total |\n` +
        `|----------|--------|------------|\n` +
        `| Personnel | [amount] | [%] |\n` +
        `| Program Supplies | [amount] | [%] |\n` +
        `| Travel | [amount] | [%] |\n` +
        `| Indirect Costs | [amount] | [%] |\n\n` +
        `## Timeline\n\n` +
        `**Submission Deadline:** ${deadlineStr}\n\n` +
        `---\n` +
        `*This is a structured template. To generate a fully written AI-powered draft, please ensure your OpenAI or Anthropic API key is configured and has available credits.*`;
      modelUsed = 'template';
    }

    // Extract cited sources from AI-generated drafts
    if (modelUsed !== 'template') {
      const sourcePattern = /\[Source:\s*([^\]]+)\]/g;
      let match;
      const foundSources = new Set<string>();
      while ((match = sourcePattern.exec(draft)) !== null) {
        foundSources.add(match[1].trim());
      }
      const mlaPattern = /\(([^)]{5,80},\s*(?:"|')[^"']+(?:"|'),?\s*\d{4})\)/g;
      while ((match = mlaPattern.exec(draft)) !== null) {
        foundSources.add(match[1].trim());
      }
      citedSources = Array.from(foundSources);
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

    return json({
      draft,
      sources: allSources,
      citedSources,
      referenceDocsUsed: reference_doc_ids.length,
      researchIncluded: include_research,
      modelUsed,
    });
  } catch (err: any) {
    console.error('AI draft error:', err);
    return json({ error: err.message }, 500);
  }
});
