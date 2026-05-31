import { sanitiseError } from '../_shared/errors.ts';
// Phase 3C: Process notification queue
// Called by pg_cron or manually to send pending email notifications
// Also handles deadline reminder scheduling

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY') || '';

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
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'process';

    let results: any = {};

    if (action === 'schedule_reminders' || action === 'all') {
      // Schedule deadline reminders
      const scheduled = await scheduleDeadlineReminders(supabase);
      results.deadline_reminders_scheduled = scheduled;

      // Schedule task reminders
      const taskScheduled = await scheduleTaskReminders(supabase);
      results.task_reminders_scheduled = taskScheduled;
    }

    if (action === 'process' || action === 'all') {
      // Process pending notifications
      const processed = await processQueue(supabase);
      results.notifications_processed = processed;
    }

    return jsonResponse(req, results);
  } catch (err: any) {
    console.error('process-notifications error:', err);
    return jsonResponse(req, { error: sanitiseError(err, 'Internal server error') }, 500);
  }
});

async function scheduleDeadlineReminders(supabase: any): Promise<number> {
  // Get all users with email enabled
  const { data: prefs } = await supabase
    .from('notification_preferences')
    .select('user_id, deadline_reminders')
    .eq('email_enabled', true);

  if (!prefs || prefs.length === 0) return 0;

  let scheduled = 0;
  const today = new Date();

  for (const pref of prefs) {
    const reminderDays: number[] = pref.deadline_reminders || [30, 14, 7, 3, 1];

    // Get user's email
    const { data: userData } = await supabase.auth.admin.getUserById(pref.user_id);
    if (!userData?.user?.email) continue;
    const email = userData.user.email;

    // Get tracked grants with upcoming deadlines
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

      // Check if already queued
      const { data: existing } = await supabase
        .from('notification_queue')
        .select('id')
        .eq('user_id', pref.user_id)
        .eq('type', 'deadline_reminder')
        .containedBy('payload', { grant_id: grant.id, days_until: daysUntil })
        .limit(1);

      if (existing && existing.length > 0) continue;

      // Queue the notification
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

async function processQueue(supabase: any): Promise<number> {
  // Get pending notifications
  const { data: pending } = await supabase
    .from('notification_queue')
    .select('*')
    .is('sent_at', null)
    .lte('scheduled_for', new Date().toISOString())
    .lt('retry_count', 3)
    .order('scheduled_for')
    .limit(100);

  if (!pending || pending.length === 0) return 0;

  let processed = 0;

  for (const notification of pending) {
    try {
      await sendEmail(notification);
      await supabase
        .from('notification_queue')
        .update({ sent_at: new Date().toISOString() })
        .eq('id', notification.id);
      processed++;
    } catch (err: any) {
      console.error(`Failed to send notification ${notification.id}:`, err.message);
      await supabase
        .from('notification_queue')
        .update({
          error: err.message,
          retry_count: notification.retry_count + 1,
        })
        .eq('id', notification.id);
    }
  }

  return processed;
}

async function sendEmail(notification: any): Promise<void> {
  if (!SENDGRID_API_KEY) {
    // Log instead of sending if no API key configured
    console.log(`[EMAIL] To: ${notification.email}, Type: ${notification.type}, Payload:`, notification.payload);
    return;
  }

  const { type, email, payload } = notification;
  let subject = '';
  let htmlContent = '';

  switch (type) {
    case 'deadline_reminder':
      subject = `[FunderMatch] ${payload.funder_name} deadline in ${payload.days_until} day${payload.days_until !== 1 ? 's' : ''}`;
      htmlContent = `
        <h2>Grant Deadline Reminder</h2>
        <p><strong>${payload.grant_name || payload.funder_name}</strong></p>
        <p>Deadline: <strong>${payload.deadline}</strong> (${payload.days_until} day${payload.days_until !== 1 ? 's' : ''} away)</p>
        <p><a href="${payload.link}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:white;text-decoration:none;border-radius:6px;">View in FunderMatch</a></p>
      `;
      break;

    case 'task_reminder':
      subject = `[FunderMatch] Task due ${payload.days_until === 0 ? 'today' : payload.days_until === 1 ? 'tomorrow' : `in ${payload.days_until} days`}: ${payload.task_title}`;
      htmlContent = `
        <h2>Task Due Date Reminder</h2>
        <p><strong>${payload.task_title}</strong></p>
        ${payload.grant_name ? `<p>Grant: ${payload.grant_name}</p>` : ''}
        <p>Due: <strong>${payload.due_date}</strong></p>
        <p><a href="${payload.link}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:white;text-decoration:none;border-radius:6px;">View in FunderMatch</a></p>
      `;
      break;

    case 'task_assignment':
      subject = `[FunderMatch] Task assigned: ${payload.task_title}`;
      htmlContent = `
        <h2>New Task Assigned</h2>
        <p><strong>${payload.task_title}</strong></p>
        ${payload.grant_name ? `<p>Grant: ${payload.grant_name}</p>` : ''}
        ${payload.due_date ? `<p>Due: ${payload.due_date}</p>` : ''}
        <p><a href="${payload.link}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:white;text-decoration:none;border-radius:6px;">View in FunderMatch</a></p>
      `;
      break;

    case 'deadline_changed': {
      // FM-IC-NTF-002: Alerts when funder changes a grant deadline
      const oldD = payload.old_deadline ? new Date(payload.old_deadline) : null;
      const newD = payload.new_deadline ? new Date(payload.new_deadline) : null;
      let diffLine = '';
      let directionLabel = 'changed';
      if (oldD && newD) {
        const diffMs = newD.getTime() - oldD.getTime();
        const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
        if (diffDays > 0) {
          directionLabel = 'extended';
          diffLine = `<p style="color:#15803d;">Deadline pushed back <strong>${diffDays} day${diffDays === 1 ? '' : 's'}</strong> — more time to prepare.</p>`;
        } else if (diffDays < 0) {
          directionLabel = 'moved earlier';
          diffLine = `<p style="color:#b91c1c;"><strong>Heads up:</strong> deadline moved up by <strong>${Math.abs(diffDays)} day${Math.abs(diffDays) === 1 ? '' : 's'}</strong> — please re-plan.</p>`;
        }
      }
      subject = `[FunderMatch] Deadline ${directionLabel}: ${payload.grant_name || payload.funder_name}`;
      htmlContent = `
        <h2>Grant deadline ${directionLabel}</h2>
        <p><strong>${payload.grant_name || payload.funder_name}</strong>${payload.grant_name && payload.funder_name && payload.grant_name !== payload.funder_name ? ` &mdash; ${payload.funder_name}` : ''}</p>
        <table style="border-collapse:collapse;margin:12px 0;">
          <tr><td style="padding:4px 16px 4px 0;color:#6b7280;">Previous deadline</td><td style="padding:4px 0;"><s>${payload.old_deadline || '—'}</s></td></tr>
          <tr><td style="padding:4px 16px 4px 0;color:#6b7280;">New deadline</td><td style="padding:4px 0;font-weight:600;color:#111827;">${payload.new_deadline || '—'}</td></tr>
        </table>
        ${diffLine}
        <p><a href="${payload.link}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:white;text-decoration:none;border-radius:6px;">Review in FunderMatch</a></p>
        <p style="color:#6b7280;font-size:12px;margin-top:24px;">You're receiving this because you tracked this grant. Manage notification preferences in your <a href="https://fundermatch.org/settings">Settings</a>.</p>
      `;
      break;
    }

    default:
      subject = `[FunderMatch] Notification`;
      htmlContent = `<p>You have a new notification. <a href="https://fundermatch.org/dashboard">View Dashboard</a></p>`;
  }

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SENDGRID_API_KEY}`,
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email }] }],
      from: { email: 'notifications@fundermatch.org', name: 'FunderMatch' },
      subject,
      content: [{ type: 'text/html', value: htmlContent }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SendGrid error: ${response.status} ${text}`);
  }
}
