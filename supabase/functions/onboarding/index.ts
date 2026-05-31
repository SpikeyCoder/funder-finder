// Phase 5D: Guided onboarding flow management
import { createUserScopedClient } from "../_shared/user-client.ts";
import { corsHeaders as _corsHeaders } from "../_shared/cors.ts";
import { sanitiseError } from "../_shared/errors.ts";
import { statusForAuthError } from "../_shared/auth.ts";

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
      const body = await req.json();
      const { action } = body;
      if (action === 'skip') {
        const { data } = await supabase
          .from('onboarding_progress')
          .upsert({ user_id: user.id, skipped: true, completed_at: new Date().toISOString() })
          .select()
          .single();
        return json(req, data);
      }

      // FM-IC-ONB-003: persist the org-profile fields captured in
      // OnboardingPage Step 2 — including county-level location and
      // plain-language fields_of_work. Previously the Step 2 inputs
      // were not wired to anything; the audit graded ONB-003 PARTIAL
      // because county granularity was advertised but never collected
      // through the in-app onboarding flow.
      if (action === 'save_profile') {
        const profile = body.profile || {};
        // Allowlist exactly the columns we expect to receive from Step 2.
        const allowed: Record<string, unknown> = {};
        const stringFields = [
          'organization_name', 'mission_statement', 'city', 'state',
          'county', 'org_type', 'budget_range',
        ];
        for (const k of stringFields) {
          if (typeof profile[k] === 'string') {
            const v = profile[k].trim();
            if (v.length > 0) allowed[k] = v;
          }
        }
        if (Array.isArray(profile.fields_of_work)) {
          allowed.fields_of_work = (profile.fields_of_work as unknown[])
            .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
            .map((v) => v.trim())
            .slice(0, 12);
        }
        allowed.id = user.id;
        allowed.updated_at = new Date().toISOString();

        const { error: upErr } = await supabase
          .from('user_profiles')
          .upsert(allowed, { onConflict: 'id' });
        if (upErr) throw upErr;

        // Best-effort flag onboarding profile step complete
        await supabase
          .from('onboarding_progress')
          .upsert({
            user_id: user.id,
            profile_complete: true,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'user_id' });

        return json(req, { ok: true, fields_saved: Object.keys(allowed).filter((k) => k !== 'id' && k !== 'updated_at') });
      }

      return json(req, { error: 'Unknown action' }, 400);
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
