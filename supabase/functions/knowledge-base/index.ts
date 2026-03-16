// Phase 5C: Application knowledge base management
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const authHeader = req.headers.get('authorization') || '';
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const jwt = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const url = new URL(req.url);

  try {
    if (req.method === 'GET') {
      const projectId = url.searchParams.get('project_id');
      let query = supabase.from('application_knowledge_base').select('*').eq('user_id', user.id);
      if (projectId) query = query.eq('project_id', projectId);

      const { data, error } = await query.order('created_at', { ascending: false });
      if (error) throw error;
      return json(data || []);
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const { title, content, project_id, source_type = 'manual', file_name, file_type, sections } = body;

      if (!title || !content) return json({ error: 'title and content required' }, 400);

      const { data, error } = await supabase
        .from('application_knowledge_base')
        .insert({
          user_id: user.id,
          project_id: project_id || null,
          title,
          content,
          source_type,
          file_name,
          file_type,
          sections: sections || [],
        })
        .select()
        .single();

      if (error) throw error;
      return json(data, 201);
    }

    if (req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) return json({ error: 'id required' }, 400);
      await supabase.from('application_knowledge_base').delete().eq('id', id).eq('user_id', user.id);
      return json({ success: true });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (err: any) {
    return json({ error: err.message }, 500);
  }
});
