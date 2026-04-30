// Phase 5D: Guided onboarding flow management
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

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
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, OPTIONS';
  }
  return headers;
}

function json(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });

  const authHeader = req.headers.get('authorization') || '';
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const jwt = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
  if (!user) return json(req, { error: 'Unauthorized' }, 401);

  try {
    if (req.method === 'GET') {
      const { data: progress } = await supabase
        .from('onboarding_progress')
        .select('*')
        .eq('user_id', user.id)
        .single();

      if (!progress) {
        // New user — create onboarding record
        const { data: newProgress } = await supabase
          .from('onboarding_progress')
          .insert({ user_id: user.id, current_step: 1 })
          .select()
          .single();
        return json(req, newProgress);
      }

      return json(req, progress);
    }

    if (req.method === 'PUT') {
      const updates = await req.json();
      const { current_step, completed_steps, skipped, profile_complete, first_project_id, first_match_saved } = updates;

      const updateData: any = { updated_at: new Date().toISOString() };
      if (current_step !== undefined) updateData.current_step = current_step;
      if (completed_steps !== undefined) updateData.completed_steps = completed_steps;
      if (skipped !== undefined) updateData.skipped = skipped;
      if (profile_complete !== undefined) updateData.profile_complete = profile_complete;
      if (first_project_id !== undefined) updateData.first_project_id = first_project_id;
      if (first_match_saved !== undefined) updateData.first_match_saved = first_match_saved;

      // Mark completed if all 5 steps done
      if (completed_steps && completed_steps.length >= 5) {
        updateData.completed_at = new Date().toISOString();
      }

      const { data, error } = await supabase
        .from('onboarding_progress')
        .update(updateData)
        .eq('user_id', user.id)
        .select()
        .single();

      if (error) throw error;
      return json(req, data);
    }

    if (req.method === 'POST') {
      // Skip onboarding
      const { action } = await req.json();
      if (action === 'skip') {
        const { data } = await supabase
          .from('onboarding_progress')
          .upsert({ user_id: user.id, skipped: true, completed_at: new Date().toISOString() })
          .select()
          .single();
        return json(req, data);
      }
      return json(req, { error: 'Unknown action' }, 400);
    }

    return json(req, { error: 'Method not allowed' }, 405);
  } catch (err: any) {
    return json(req, { error: err.message }, 500);
  }
});
