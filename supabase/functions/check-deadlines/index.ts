// check-deadlines: Scan tracked grants and tasks for upcoming deadlines,
// then queue reminder notifications based on user preferences.
// Designed to be called by pg_cron or manually.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

import { corsHeaders as _corsHeaders } from "../_shared/cors.ts";

const CORS_HEADERS_OPTS = { methods: "POST, OPTIONS" } as const;
function CORS_HEADERS(req: Request | null = null): Record<string, string> {
  return _corsHeaders(req?.headers.get("origin") ?? null, CORS_HEADERS_OPTS);
}

function jsonResponse(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS(req), 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS(req) });
  }

  if (req.method !== 'POST') {
    return jsonResponse(req, { error: 'Method not allowed' }, 405);
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const deadlineReminders = await scheduleDeadlineReminders(supabase);
    const taskReminders = await scheduleTaskReminders(supabase);
    const externalReminders = await scheduleExternalAssigneeReminders(supabase);
    const deadlineChanges = await detectDeadlineChanges(supabase);

    return jsonResponse(req, {
      deadline_reminders_scheduled: deadlineReminders,
      task_reminders_scheduled: taskReminders,
      external_assignee_reminders: externalReminders,
      deadline_changes_detected: deadlineChanges,
    });
  } catch (err: any) {
    console.error('check-deadlines error:', err);
    return jsonResponse(req, { error: err.message }, 500);
  }
});

async function scheduleDeadlineReminders(supabase: any): Promise<number> {
  const { data: prefs } = await supabase
    .from('notification_preferences')
    .select('user_id, deadline_reminders')
    .eq('email_enabled', true);

  if (!prefs || prefs.length === 0) return 0;

  let scheduled = 0;
  const today = new Date();

  for (const pref of prefs) {
    const reminderDays: number[] = pref.deadline_reminders || [30, 14, 7, 3, 1];

    const { data: userData } = await supabase.auth.admin.getUserById(pref.user_id);
    if (!userData?.user?.email) continue;
    const email = userData.user.email;

    const { data: grants } = await supabase
      .from('tracked_grants')
      .select('id, funder_name, grant_title, deadline, project_id, pipeline_statuses(name, is_terminal)')
      .eq('user_id', pref.user_id)
      .not('deadline', 'is', null);

    if (!grants) continue;

    for (const grant of grants) {
      if ((grant as any).pipeline_statuses?.is_terminal) continue;

      const deadline = new Date(grant.deadline);
      const daysUntil = Math.ceil((deadline.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

      if (daysUntil < 0 || !reminderDays.includes(daysUntil)) continue;

      // Check for duplicate
      const { data: existing } = await supabase
        .from('notification_queue')
        .select('id')
        .eq('user_id', pref.user_id)
        .eq('type', 'deadline_reminder')
        .containedBy('payload', { grant_id: grant.id, days_until: daysUntil })
        .limit(1);

      if (existing && existing.length > 0) continue;

      await supabase.from('notification_queue').insert({
        user_id: pref.user_id,
        email,
        type: 'deadline_reminder',
        payload: {
          grant_id: grant.id,
          grant_name: grant.grant_title || grant.funder_name,
          funder_name: grant.funder_name,
          deadline: grant.deadline,
          days_until: daysUntil,
          project_id: grant.project_id,
          link: `https://fundermatch.org/projects/${grant.project_id}/tracker`,
        },
        scheduled_for: new Date().toISOString(),
      });
      scheduled++;
    }
  }

  return scheduled;
}

async function scheduleTaskReminders(supabase: any): Promise<number> {
  const { data: prefs } = await supabase
    .from('notification_preferences')
    .select('user_id, task_reminders')
    .eq('email_enabled', true);

  if (!prefs || prefs.length === 0) return 0;

  let scheduled = 0;
  const today = new Date();

  for (const pref of prefs) {
    const reminderDays: number[] = pref.task_reminders || [1];

    const { data: userData } = await supabase.auth.admin.getUserById(pref.user_id);
    if (!userData?.user?.email) continue;
    const email = userData.user.email;

    const { data: tasks } = await supabase
      .from('tasks')
      .select('id, title, due_date, tracked_grant_id, project_id, tracked_grants(funder_name)')
      .or(`user_id.eq.${pref.user_id},assignee_user_id.eq.${pref.user_id}`)
      .neq('status', 'done')
      .not('due_date', 'is', null);

    if (!tasks) continue;

    for (const task of tasks) {
      const dueDate = new Date(task.due_date);
      const daysUntil = Math.ceil((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

      if (daysUntil < 0 || !reminderDays.includes(daysUntil)) continue;

      const { data: existing } = await supabase
        .from('notification_queue')
        .select('id')
        .eq('user_id', pref.user_id)
        .eq('type', 'task_reminder')
        .containedBy('payload', { task_id: task.id, days_until: daysUntil })
        .limit(1);

      if (existing && existing.length > 0) continue;

      await supabase.from('notification_queue').insert({
        user_id: pref.user_id,
        email,
        type: 'task_reminder',
        payload: {
          task_id: task.id,
          task_title: task.title,
          grant_name: (task as any).tracked_grants?.funder_name,
          due_date: task.due_date,
          days_until: daysUntil,
          link: `https://fundermatch.org/projects/${task.project_id}/tracker`,
        },
        scheduled_for: new Date().toISOString(),
      });
      scheduled++;
    }
  }

  return scheduled;
}

// Send task reminders to non-platform assignees (external emails)
async function scheduleExternalAssigneeReminders(supabase: any): Promise<number> {
  let scheduled = 0;
  const today = new Date();

  const { data: tasks } = await supabase
    .from('tasks')
    .select('id, title, due_date, assignee_email, project_id, tracked_grant_id, tracked_grants(funder_name)')
    .neq('status', 'done')
    .not('due_date', 'is', null)
    .not('assignee_email', 'is', null);

  if (!tasks) return 0;

  for (const task of tasks) {
    if (!task.assignee_email) continue;
    const dueDate = new Date(task.due_date);
    const daysUntil = Math.ceil((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    if (daysUntil < 0 || ![3, 1].includes(daysUntil)) continue;

    const { data: existing } = await supabase
      .from('notification_queue')
      .select('id')
      .eq('email', task.assignee_email)
      .eq('type', 'task_reminder')
      .filter('payload->task_id', 'eq', task.id)
      .filter('payload->days_until', 'eq', daysUntil)
      .limit(1);

    if (existing && existing.length > 0) continue;

    await supabase.from('notification_queue').insert({
      user_id: null,
      email: task.assignee_email,
      type: 'task_reminder',
      payload: {
        task_id: task.id,
        task_title: task.title,
        grant_name: (task as any).tracked_grants?.funder_name,
        due_date: task.due_date,
        days_until: daysUntil,
        link: `https://fundermatch.org/projects/${task.project_id}/tracker`,
      },
      scheduled_for: new Date().toISOString(),
    });
    scheduled++;
  }
  return scheduled;
}

// Detect deadline changes on tracked grants and alert users
async function detectDeadlineChanges(supabase: any): Promise<number> {
  let detected = 0;
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: grants } = await supabase
    .from('tracked_grants')
    .select('id, user_id, funder_name, grant_title, deadline, project_id, previous_deadline')
    .not('deadline', 'is', null)
    .gt('updated_at', oneDayAgo);

  if (!grants) return 0;

  for (const grant of grants) {
    if (!grant.previous_deadline || grant.previous_deadline === grant.deadline) continue;

    const { data: userData } = await supabase.auth.admin.getUserById(grant.user_id);
    if (!userData?.user?.email) continue;

    const { data: existing } = await supabase
      .from('notification_queue')
      .select('id')
      .eq('user_id', grant.user_id)
      .eq('type', 'deadline_changed')
      .filter('payload->grant_id', 'eq', grant.id)
      .filter('payload->new_deadline', 'eq', grant.deadline)
      .limit(1);

    if (existing && existing.length > 0) continue;

    await supabase.from('notification_queue').insert({
      user_id: grant.user_id,
      email: userData.user.email,
      type: 'deadline_changed',
      payload: {
        grant_id: grant.id,
        grant_name: grant.grant_title || grant.funder_name,
        funder_name: grant.funder_name,
        old_deadline: grant.previous_deadline,
        new_deadline: grant.deadline,
        link: `https://fundermatch.org/projects/${grant.project_id}/tracker`,
      },
      scheduled_for: new Date().toISOString(),
    });
    detected++;
  }
  return detected;
}
