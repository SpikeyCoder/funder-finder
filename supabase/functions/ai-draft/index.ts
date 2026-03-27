// Phase 5C: AI-assisted grant proposal draft generation
// Enhanced: reference doc style matching, deep research, MLA citations
// Optimized: parallel DB queries, in-memory caching, per-model timeouts
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

// ── In-memory cache (persists across warm invocations) ─────────────────────
// Supabase edge functions stay warm for ~5 min; cache user profile & KB
// so "Regenerate" clicks skip redundant DB round-trips.
const cache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function cacheGet(key: string): any | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key: string, data: any) {
  cache.set(key, { data, ts: Date.now() });
}

// Extract text from uploaded file in storage
async function extractFileText(supabase: any, storagePath: string): Promise<string> {
  try {
    const { data, error } = await supabase.storage
      .from('grant-uploads')
      .download(storagePath);
    if (error || !data) return '';
    const text = await data.text();
    return text.substring(0, 4000);
  } catch {
    return '';
  }
}

// Wrap a promise with a timeout (ms). Returns null on timeout instead of hanging.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
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
      word_limit = 500,
    } = await req.json();

    // ── Gather context (all queries in parallel) ──────────────────────────

    // Fire all independent DB queries at once instead of sequentially
    const [projectResult, grantResult, userProfile, refDocsResult, kbEntries] = await Promise.all([
      // 1. Project info
      supabase.from('projects')
        .select('name, description, location_scope, fields_of_work, keywords')
        .eq('id', project_id).single(),

      // 2. Grant info (conditional but cheap to fire as no-op)
      grant_id
        ? supabase.from('tracked_grants')
            .select('funder_name, funder_ein, grant_title, deadline, amount, awarded_amount, notes')
            .eq('id', grant_id).single()
        : Promise.resolve({ data: null }),

      // 3. User profile (cached across warm invocations)
      (async () => {
        const cached = cacheGet(`profile:${user.id}`);
        if (cached) return cached;
        const { data } = await supabase.from('user_profiles')
          .select('organization_name, mission_statement, city, state, budget_range, ntee_codes')
          .eq('id', user.id).single();
        if (data) cacheSet(`profile:${user.id}`, data);
        return data;
      })(),

      // 4. Reference documents
      reference_doc_ids.length > 0
        ? supabase.from('application_knowledge_base')
            .select('title, content, storage_path, source_type')
            .in('id', reference_doc_ids)
        : Promise.resolve({ data: [] }),

      // 5. KB entries (cached across warm invocations)
      (async () => {
        const cached = cacheGet(`kb:${user.id}`);
        if (cached) return cached;
        const { data } = await supabase.from('application_knowledge_base')
          .select('title, content')
          .eq('user_id', user.id)
          .neq('source_type', 'reference_doc')
          .order('created_at', { ascending: false })
          .limit(3);
        if (data) cacheSet(`kb:${user.id}`, data);
        return data;
      })(),
    ]);

    const project = projectResult.data;
    const grantInfo = grantResult.data;

    // ── Load reference document text (file extractions in parallel) ──────

    let referenceDocContent = '';
    const refDocs = refDocsResult.data || [];
    if (refDocs.length > 0) {
      // Fire all file extractions in parallel instead of sequential for-loop
      const docTexts = await Promise.all(
        refDocs.map(async (doc: any) => {
          let text = doc.content || '';
          if (doc.storage_path && text.startsWith('[Uploaded file:')) {
            const extracted = await extractFileText(supabase, doc.storage_path);
            if (extracted) text = extracted;
          }
          return text ? `--- Reference: ${doc.title} ---\n${text.substring(0, 3000)}` : '';
        })
      );
      referenceDocContent = docTexts.filter(Boolean).join('\n\n');
    }

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

WORD LIMIT:
The proposal MUST be approximately ${word_limit} words. Be concise and impactful. Every sentence should earn its place. Do not pad with filler.

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
${include_research ? '9. Works Cited (MLA format)' : ''}

IMPORTANT: Do NOT include any checklist, compliance checklist, or submission checklist in the proposal text. The checklist is handled separately.`;

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

Please generate a complete, professional grant proposal in approximately ${word_limit} words. ${include_research ? 'Include recent data with MLA citations and a Works Cited section.' : ''}

After the proposal, on a new line, output a JSON block wrapped in <checklist> tags containing an array of submission checklist items relevant to this grant. Each item should have "text" (the checklist item) and "source" (where the requirement comes from, e.g. "funder guidelines", "reference doc", "standard practice"). Example:
<checklist>[{"text":"Letter of determination (501c3 status)","source":"standard practice"},{"text":"Board of directors list","source":"funder guidelines"}]</checklist>`;

    // ── Generate with AI (multi-model fallback chain) ──────────────────────

    let draft = '';
    let citedSources: string[] = [];
    let modelUsed = 'template';

    // Helper: try an OpenAI-compatible model (with 45s timeout)
    const AI_TIMEOUT = 45_000;

    async function tryOpenAI(model: string): Promise<string | null> {
      if (!OPENAI_API_KEY) return null;
      try {
        const response = await withTimeout(
          fetch('https://api.openai.com/v1/chat/completions', {
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
          }),
          AI_TIMEOUT,
        );
        if (!response) { console.warn(`OpenAI ${model} timed out`); return null; }
        const result = await response.json();
        if (!response.ok) {
          console.warn(`OpenAI ${model} failed (${response.status}):`, result.error?.message);
          return null;
        }
        return result.choices?.[0]?.message?.content || null;
      } catch (err) {
        console.warn(`OpenAI ${model} network error:`, err);
        return null;
      }
    }

    // Helper: try Anthropic Claude (with 45s timeout)
    async function tryAnthropic(): Promise<string | null> {
      if (!ANTHROPIC_API_KEY) return null;
      try {
        const response = await withTimeout(
          fetch('https://api.anthropic.com/v1/messages', {
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
          }),
          AI_TIMEOUT,
        );
        if (!response) { console.warn('Anthropic timed out'); return null; }
        const result = await response.json();
        if (!response.ok) {
          console.warn(`Anthropic failed (${response.status}):`, result.error?.message);
          return null;
        }
        return result.content?.[0]?.text || null;
      } catch (err) {
        console.warn('Anthropic network error:', err);
        return null;
      }
    }

    // Fallback chain: try models in order until one succeeds
    // Each model has a 45s timeout so we don't hang on a slow provider
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

    // Extract checklist from AI response (returned inside <checklist> tags)
    let checklist: Array<{ text: string; checked: boolean; source?: string }> = [];
    if (modelUsed !== 'template') {
      const checklistMatch = draft.match(/<checklist>([\s\S]*?)<\/checklist>/i);
      if (checklistMatch) {
        try {
          const items = JSON.parse(checklistMatch[1]);
          if (Array.isArray(items)) {
            checklist = items.map((item: any) => ({
              text: typeof item === 'string' ? item : (item.text || ''),
              checked: false,
              source: item.source || undefined,
            }));
          }
        } catch { /* ignore parse errors */ }
        // Remove the checklist block from the draft
        draft = draft.replace(/<checklist>[\s\S]*?<\/checklist>/i, '').trimEnd();
      }
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
      checklist,
      sources: allSources,
      citedSources,
      referenceDocsUsed: reference_doc_ids.length,
      researchIncluded: include_research,
      wordLimit: word_limit,
      modelUsed,
    });
  } catch (err: any) {
    console.error('AI draft error:', err);
    return json({ error: err.message }, 500);
  }
});
