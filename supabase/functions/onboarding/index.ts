// Phase 5D: Guided onboarding flow management
import { createUserScopedClient } from "../_shared/user-client.ts";
import { corsHeaders as _corsHeaders } from "../_shared/cors.ts";

const CORS_OPTS = { methods: "GET, POST, PUT, OPTIONS" } as const;
function CORS(req: Request | null = null): Record<string, string> {
  return _corsHeaders(req?.headers.get("origin") ?? null, CORS_OPTS);
}

function json(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS(req), 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS(req) });

  try {
    const { supabase, user } = await createUserScopedClient(req);

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
    return json(req, { error: err.message }, 401);
  }
});
