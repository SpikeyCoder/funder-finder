import { sanitiseError } from '../_shared/errors.ts';
// Phase 4: Compliance requirement CRUD
// MIGRATED TO LOCAL JWT AUTH: Uses auth.ts (local JWT decode + service-role client)
import { authFromRequest, adminClient } from "../_shared/auth.ts";

import { corsHeaders as _corsHeaders } from "../_shared/cors.ts";

const CORS_OPTS = { methods: "GET, POST, PUT, DELETE, OPTIONS" } as const;
function CORS(req: Request | null = null): Record<string, string> {
  return _corsHeaders(req?.headers.get("origin") ?? null, CORS_OPTS);
}

function json(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS(req), 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS(req) });

  try {
    const { userId } = await authFromRequest(req);
    const supabase = adminClient();

    const url = new URL(req.url);

    if (req.method === 'GET') {
      const grantId = url.searchParams.get('grant_id');
      const projectId = url.searchParams.get('project_id');

      let query = supabase.from('compliance_requirements').select('*').eq('user_id', userId);
      if (grantId) query = query.eq('tracked_grant_id', grantId);
      if (projectId) query = query.eq('project_id', projectId);

      const { data, error } = await query.order('due_date', { ascending: true });
      if (error) throw error;

      // Mark overdue items
      const now = new Date();
      const enriched = (data || []).map(r => ({
        ...r,
        is_overdue: r.due_date && new Date(r.due_date) < now && !['submitted', 'approved'].includes(r.status),
      }));

      return json(req, enriched);
    }

    if (req.method === 'POST') {
      const body = await req.json();
      // WA-2026-05-23-12: explicit column allowlist on insert. Previously
      // `{ ...body, user_id: userId }` let callers set any column that
      // exists today or is added tomorrow (audit columns, internal flags,
      // org_id, etc.). user_id was correctly hardcoded but other restricted
      // fields were attacker-controllable on schema drift.
      const allowed = pickAllowedInsert(body);
      if (!allowed.requirement_text) {
        return json(req, { error: 'requirement_text required' }, 400);
      }
      const { data, error } = await supabase
        .from('compliance_requirements')
        .insert({ ...allowed, user_id: userId })
        .select()
        .single();
      if (error) throw error;
      return json(req, data, 201);
    }

    if (req.method === 'PUT') {
      const { id, ...updates } = await req.json();
      if (!id) return json(req, { error: 'id required' }, 400);

      // WA-2026-05-23-12: explicit column allowlist on update.
      const safeUpdates = pickAllowedUpdate(updates);
      if (safeUpdates.status === 'submitted' || safeUpdates.status === 'approved') {
        safeUpdates.completed_at = new Date().toISOString();
      }
      safeUpdates.updated_at = new Date().toISOString();

      const { data, error } = await supabase
        .from('compliance_requirements')
        .update(safeUpdates)
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
      await supabase.from('compliance_requirements').delete().eq('id', id).eq('user_id', userId);
      return json(req, { success: true });
    }

    return json(req, { error: 'Method not allowed' }, 405);
  } catch (err: any) {
    const status = err.message?.includes('Unauthorized') || err.message?.includes('JWT') ? 401 : 500;
    if (status === 401) return json(req, { error: err.message }, status);
    return json(req, { error: sanitiseError(err, 'Internal server error') }, status);
  }
});

// WA-2026-05-23-12: column allowlists for compliance_requirements.
type ComplianceInsert = {
  grant_id?: string | null;
  project_id?: string | null;
  requirement_text?: string;
  category?: string | null;
  due_date?: string | null;
  status?: string | null;
  priority?: string | null;
  notes?: string | null;
};
type ComplianceUpdate = ComplianceInsert & { completed_at?: string; updated_at?: string };

const INSERT_KEYS: (keyof ComplianceInsert)[] = [
  'grant_id', 'project_id', 'requirement_text', 'category',
  'due_date', 'status', 'priority', 'notes',
];
const UPDATE_KEYS: (keyof ComplianceUpdate)[] = [
  ...INSERT_KEYS, 'completed_at', 'updated_at',
];

function pickAllowedInsert(body: Record<string, unknown>): ComplianceInsert {
  const out: ComplianceInsert = {};
  for (const k of INSERT_KEYS) {
    if (k in body) (out as any)[k] = (body as any)[k];
  }
  return out;
}

function pickAllowedUpdate(body: Record<string, unknown>): ComplianceUpdate {
  const out: ComplianceUpdate = {};
  for (const k of UPDATE_KEYS) {
    if (k in body) (out as any)[k] = (body as any)[k];
  }
  return out;
}
