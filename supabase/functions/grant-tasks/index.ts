// Phase 3B: Task Management CRUD Edge Function
// Handles tasks on tracked grants + My Tasks view

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
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
  }
  return headers;
}

function jsonResponse(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });
}

function errorResponse(req: Request, message: string, status = 400) {
  return jsonResponse(req, { error: message }, status);
}

async function getUserFromRequest(req: Request) {
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return null;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders(req) });
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) return errorResponse(req, 'Unauthorized', 401);

    const url = new URL(req.url);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    if (req.method === 'GET') {
      const grantId = url.searchParams.get('grant_id');
      const myTasks = url.searchParams.get('my_tasks') === 'true';

      if (myTasks) {
        // My Tasks: all tasks assigned to or owned by current user
        const { data: tasks, error } = await supabase
          .from('tasks')
          .select('*, tracked_grants(funder_name, grant_title, deadline), projects(name)')
          .or(`user_id.eq.${user.id},assignee_user_id.eq.${user.id}`)
          .order('due_date', { ascending: true, nullsFirst: false });

        if (error) return errorResponse(req, error.message, 500);

        // Group by category
        const now = new Date();
        const today = now.toISOString().split('T')[0];
        const weekEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        const grouped = {
          overdue: (tasks || []).filter((t: any) => t.is_overdue && t.status !== 'done'),
          today: (tasks || []).filter((t: any) => t.due_date === today && t.status !== 'done' && !t.is_overdue),
          this_week: (tasks || []).filter((t: any) => t.due_date && t.due_date > today && t.due_date <= weekEnd && t.status !== 'done'),
          later: (tasks || []).filter((t: any) => t.due_date && t.due_date > weekEnd && t.status !== 'done'),
          no_date: (tasks || []).filter((t: any) => !t.due_date && t.status !== 'done'),
          completed: (tasks || []).filter((t: any) => t.status === 'done'),
        };

        return jsonResponse(req, grouped);
      }

      if (grantId) {
        const { data: tasks, error } = await supabase
          .from('tasks')
          .select('*')
          .eq('tracked_grant_id', grantId)
          .order('is_overdue', { ascending: false })
          .order('due_date', { ascending: true, nullsFirst: false });

        if (error) return errorResponse(req, error.message, 500);
        return jsonResponse(req, tasks || []);
      }

      return errorResponse(req, 'grant_id or my_tasks=true required');
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const { tracked_grant_id, project_id, title, description, assignee_email, due_date } = body;

      if (!tracked_grant_id || !title) {
        return errorResponse(req, 'tracked_grant_id and title are required');
      }

      // Resolve assignee_user_id from email
      let assigneeUserId = null;
      if (assignee_email) {
        const { data: assigneeUser } = await supabase
          .from('user_profiles')
          .select('user_id')
          .eq('email', assignee_email)
          .single();
        if (assigneeUser) assigneeUserId = assigneeUser.user_id;
      }

      // Get project_id from grant if not provided
      let resolvedProjectId = project_id;
      if (!resolvedProjectId) {
        const { data: grant } = await supabase
          .from('tracked_grants')
          .select('project_id')
          .eq('id', tracked_grant_id)
          .single();
        resolvedProjectId = grant?.project_id;
      }

      const { data: task, error } = await supabase.from('tasks').insert({
        tracked_grant_id,
        project_id: resolvedProjectId,
        user_id: user.id,
        title,
        description: description || null,
        assignee_email: assignee_email || null,
        assignee_user_id: assigneeUserId,
        due_date: due_date || null,
        status: 'todo',
      }).select().single();

      if (error) return errorResponse(req, error.message, 500);
      return jsonResponse(req, task, 201);
    }

    if (req.method === 'PUT') {
      const body = await req.json();
      const taskId = body.id || url.searchParams.get('task_id');
      if (!taskId) return errorResponse(req, 'Task ID required');

      const updates: any = {};
      if (body.title !== undefined) updates.title = body.title;
      if (body.description !== undefined) updates.description = body.description;
      if (body.assignee_email !== undefined) {
        updates.assignee_email = body.assignee_email || null;
        // Resolve user id
        if (body.assignee_email) {
          const { data: assigneeUser } = await supabase
            .from('user_profiles')
            .select('user_id')
            .eq('email', body.assignee_email)
            .single();
          updates.assignee_user_id = assigneeUser?.user_id || null;
        } else {
          updates.assignee_user_id = null;
        }
      }
      if (body.due_date !== undefined) updates.due_date = body.due_date || null;
      if (body.status !== undefined) updates.status = body.status;

      const { data: task, error } = await supabase
        .from('tasks')
        .update(updates)
        .eq('id', taskId)
        .or(`user_id.eq.${user.id},assignee_user_id.eq.${user.id}`)
        .select()
        .single();

      if (error) return errorResponse(req, error.message, 500);
      if (!task) return errorResponse(req, 'Task not found', 404);
      return jsonResponse(req, task);
    }

    if (req.method === 'DELETE') {
      const taskId = url.searchParams.get('task_id');
      if (!taskId) return errorResponse(req, 'Task ID required');

      const { error } = await supabase
        .from('tasks')
        .delete()
        .eq('id', taskId)
        .eq('user_id', user.id);

      if (error) return errorResponse(req, error.message, 500);
      return jsonResponse(req, { success: true });
    }

    return errorResponse(req, 'Method not allowed', 405);
  } catch (err: any) {
    console.error('grant-tasks error:', err);
    return errorResponse(req, err.message || 'Internal server error', 500);
  }
});
