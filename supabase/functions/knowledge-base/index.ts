// Phase 5C: Application knowledge base management
// Auth: local JWT decode via authFromRequest + adminClient (service-role for
// user-filtered queries). Replaces the createUserScopedClient flow that was
// unreliable in the Edge runtime.
import { authFromRequest, adminClient, statusForAuthError } from "../_shared/auth.ts";
import { ipRateLimit } from "../_shared/rate_limit.ts";
import { corsHeaders as _corsHeaders } from "../_shared/cors.ts";
import { sanitiseError } from "../_shared/errors.ts";

const CORS_OPTS = { methods: "GET, POST, PUT, DELETE, OPTIONS" } as const;
function CORS(req: Request | null = null): Record<string, string> {
  return _corsHeaders(req?.headers.get("origin") ?? null, CORS_OPTS);
}

function json(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS(req), 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS(req) });

  // Per-IP rate limit (FM-2026-06-10-03): authenticated denial-of-wallet
  // protection for the knowledge-base endpoint.
  const _ipLimit = await ipRateLimit(req, {
    namespace: 'knowledge-base',
    limit: 30,
  });
  if (!_ipLimit.allow && _ipLimit.response) return _ipLimit.response;

  try {
    const { userId } = await authFromRequest(req);
    const supabase = adminClient();
    const url = new URL(req.url);

    if (req.method === 'GET') {
      const projectId = url.searchParams.get('project_id');
      let query = supabase.from('application_knowledge_base').select('*').eq('user_id', userId);
      if (projectId) query = query.eq('project_id', projectId);

      const { data, error } = await query.order('created_at', { ascending: false });
      if (error) throw error;
      return json(req, data || []);
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const { title, content, project_id, source_type = 'manual', file_name, file_type, sections, outcome, use_for_learning } = body;

      // FM-IC-AI-002: outcome drives which past applications the grant-writer
      // learns from. Reject unknown values rather than silently storing them.
      const ALLOWED_OUTCOMES = ['awarded', 'submitted', 'rejected', 'draft', 'unknown'];
      if (outcome !== undefined && !ALLOWED_OUTCOMES.includes(outcome)) {
        return json(req, { error: 'invalid outcome' }, 400);
      }

      if (!title || !content) return json(req, { error: 'title and content required' }, 400);

      const { data, error } = await supabase
        .from('application_knowledge_base')
        .insert({
          user_id: userId,
          project_id: project_id || null,
          title,
          content,
          source_type,
          file_name,
          file_type,
          sections: sections || [],
          outcome: outcome ?? 'unknown',
          use_for_learning: use_for_learning !== false,
          embedding_status: 'pending',
        })
        .select()
        .single();

      if (error) throw error;

      // Generate embeddings in background
      if (data?.id) {
        generateEmbedding(req, data.id, content, userId, supabase).catch(err => {
          console.error('Embedding generation error:', err);
        });
      }

      return json(req, data, 201);
    }

    if (req.method === 'PUT') {
      // FM-IC-AI-002: update an entry's learning metadata (outcome, opt-in)
      // and/or its title/content. Scoped to the caller's own rows.
      const body = await req.json();
      const id = body.id || url.searchParams.get('id');
      if (!id) return json(req, { error: 'id required' }, 400);

      const ALLOWED_OUTCOMES = ['awarded', 'submitted', 'rejected', 'draft', 'unknown'];
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (body.outcome !== undefined) {
        if (!ALLOWED_OUTCOMES.includes(body.outcome)) {
          return json(req, { error: 'invalid outcome' }, 400);
        }
        updates.outcome = body.outcome;
      }
      if (body.use_for_learning !== undefined) updates.use_for_learning = !!body.use_for_learning;
      if (typeof body.title === 'string' && body.title.trim()) updates.title = body.title.trim();
      if (typeof body.content === 'string' && body.content.trim()) updates.content = body.content;

      const { data, error } = await supabase
        .from('application_knowledge_base')
        .update(updates)
        .eq('id', id)
        .eq('user_id', userId)
        .select()
        .single();

      if (error) throw error;
      return json(req, data);
    }

    if (req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) return json(req, { error: 'id required' }, 400);
      await supabase.from('application_knowledge_base').delete().eq('id', id).eq('user_id', userId);
      return json(req, { success: true });
    }

    return json(req, { error: 'Method not allowed' }, 405);
  } catch (err: any) {
    // Classify auth errors (descriptive, schema-free) vs everything else
    // (sanitised). Mirrors the share-link / ai-draft pattern.
    // Finding WA-2026-05-23-02.
    const msg = err instanceof Error ? err.message : String(err);
    const status = statusForAuthError(msg);
    if (status === 401 || status === 403) {
      return json(req, { error: msg }, status);
    }
    return json(req, { error: sanitiseError(err, 'Internal server error') }, 500);
  }
});

async function generateEmbedding(_req: Request,
  kbId: string,
  content: string,
  userId: string,
  supabase: any
) {
  const openaiKey = Deno.env.get('OPENAI_API_KEY');
  if (!openaiKey) {
    // Update status to failed if no API key
    await supabase
      .from('application_knowledge_base')
      .update({ embedding_status: 'failed' })
      .eq('id', kbId)
      .eq('user_id', userId);
    return;
  }

  try {
    // Call OpenAI embeddings API
    const embeddingRes = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: content.substring(0, 8000),
      }),
    });

    if (!embeddingRes.ok) {
      const errorData = await embeddingRes.json();
      console.error('OpenAI API error:', errorData);
      await supabase
        .from('application_knowledge_base')
        .update({ embedding_status: 'failed' })
        .eq('id', kbId)
        .eq('user_id', userId);
      return;
    }

    const embeddingData = await embeddingRes.json();
    const embedding = embeddingData.data?.[0]?.embedding;

    if (!embedding) {
      throw new Error('No embedding data returned from OpenAI');
    }

    // Update the KB entry with the embedding and status
    await supabase
      .from('application_knowledge_base')
      .update({
        embedding,
        embedding_status: 'complete',
      })
      .eq('id', kbId)
      .eq('user_id', userId);
  } catch (err: any) {
    console.error('Error generating embedding:', err);
    await supabase
      .from('application_knowledge_base')
      .update({ embedding_status: 'failed' })
      .eq('id', kbId)
      .eq('user_id', userId);
  }
}
