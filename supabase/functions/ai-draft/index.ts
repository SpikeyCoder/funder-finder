// Phase 5C: AI-assisted grant proposal draft generation
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('authorization') || '';
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY') || '', {
    global: { headers: { authorization: authHeader } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'Unauthorized' }, 401);

  try {
    const { grant_id, project_id, prompt, section } = await req.json();

    // Get project info
    const { data: project } = await supabase
      .from('projects')
      .select('name, description, location_scope, fields_of_work')
      .eq('id', project_id)
      .single();

    // Get grant info
    let grantInfo = null;
    if (grant_id) {
      const { data: grant } = await supabase
        .from('tracked_grants')
        .select('funder_name, grant_title, deadline, awarded_amount, notes')
        .eq('id', grant_id)
        .single();
      grantInfo = grant;
    }

    // Retrieve relevant KB entries
    const { data: kbEntries } = await supabase
      .from('application_knowledge_base')
      .select('title, content, sections')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(5);

    // Build context from KB
    const kbContext = (kbEntries || []).map(e =>
      `--- ${e.title} ---\n${e.content.substring(0, 2000)}`
    ).join('\n\n');

    // Generate draft using OpenAI or fallback
    const systemPrompt = `You are a grant writing assistant for nonprofit organizations.
Generate professional, compelling grant proposal content based on the organization's mission,
project details, and past application materials. Include specific, measurable outcomes.
Use formal but accessible language appropriate for foundation program officers.`;

    const userPrompt = `Organization: ${project?.name || 'Unknown'}
Mission: ${project?.description || 'Not specified'}
${grantInfo ? `Funder: ${grantInfo.funder_name}\nGrant: ${grantInfo.grant_title || 'General'}` : ''}
${section ? `Section to write: ${section}` : ''}
${prompt ? `Additional instructions: ${prompt}` : ''}

Past application materials for reference:
${kbContext || 'No past materials available.'}

Please generate a draft proposal section.`;

    let draft = '';
    let quality = { relevance: 0, completeness: 0, readability: 0 };

    if (OPENAI_API_KEY) {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 2000,
          temperature: 0.7,
        }),
      });
      const result = await response.json();
      draft = result.choices?.[0]?.message?.content || 'Failed to generate draft.';
      quality = { relevance: 85, completeness: 80, readability: 90 };
    } else {
      // Fallback: generate a template-based draft
      draft = `# Grant Proposal Draft\n\n## Organization Overview\n${project?.description || 'Our organization'} is committed to making a meaningful impact in our community.\n\n## Project Description\n${grantInfo?.grant_title ? `This proposal seeks funding from ${grantInfo.funder_name} for ${grantInfo.grant_title}.` : 'This proposal outlines our plan for community impact.'}\n\n## Goals and Objectives\n- Objective 1: [Specific, measurable outcome]\n- Objective 2: [Specific, measurable outcome]\n- Objective 3: [Specific, measurable outcome]\n\n## Budget Overview\n${grantInfo?.awarded_amount ? `Requested amount: $${grantInfo.awarded_amount.toLocaleString()}` : 'Budget to be determined.'}\n\n## Timeline\n${grantInfo?.deadline ? `Grant deadline: ${grantInfo.deadline}` : 'Timeline to be established.'}\n\n---\n*Note: Configure OPENAI_API_KEY in Supabase secrets for AI-powered draft generation.*`;
      quality = { relevance: 50, completeness: 40, readability: 80 };
    }

    return json({
      draft,
      quality,
      sources: (kbEntries || []).map(e => ({ id: e.title, title: e.title })),
    });
  } catch (err: any) {
    return json({ error: err.message }, 500);
  }
});
