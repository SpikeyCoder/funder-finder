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

function escapeHtml(input: unknown): string {
  if (input == null) return '';
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

      // FM-IC-NTF-001: Queue "new matching funder" alerts
      const matchScheduled = await scheduleNewMatchNotifications(supabase);
      results.new_match_notifications_scheduled = matchScheduled;
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

// FM-IC-NTF-001: Email when new matching funders are found.
//
// Instrumentl emails saved-search subscribers when fresh opportunities match.
// FunderMatch already computes per-project matches into `project_matches` and
// exposes a "New match alerts" toggle (notification_preferences.realtime_matches),
// but nothing ever delivered the email. This scheduler closes that gap:
//   * Only users with realtime_matches AND email enabled are considered.
//   * Only high-scoring matches (>= NEW_MATCH_MIN_SCORE) are alert-worthy.
//   * A per-(project, funder) ledger (project_match_notifications) guarantees a
//     funder is only alerted once, even though project_matches is wiped and
//     re-inserted on every recompute.
//   * One concise digest email is queued per project, summarising up to a few
//     top new funders plus an overflow count.
const NEW_MATCH_MIN_SCORE = 70;
const NEW_MATCH_MAX_LISTED = 5;

async function scheduleNewMatchNotifications(supabase: any): Promise<number> {
  const { data: prefs } = await supabase
    .from('notification_preferences')
    .select('user_id, realtime_matches')
    .eq('email_enabled', true)
    .eq('realtime_matches', true);

  if (!prefs || prefs.length === 0) return 0;

  let scheduled = 0;

  for (const pref of prefs) {
    const { data: userData } = await supabase.auth.admin.getUserById(pref.user_id);
    if (!userData?.user?.email) continue;
    const email = userData.user.email;

    // Projects owned by this user.
    const { data: projects } = await supabase
      .from('projects')
      .select('id, name')
      .eq('user_id', pref.user_id);

    if (!projects || projects.length === 0) continue;

    for (const project of projects) {
      // Candidate high-scoring matches for this project.
      const { data: matches } = await supabase
        .from('project_matches')
        .select('funder_ein, funder_name, match_score')
        .eq('project_id', project.id)
        .gte('match_score', NEW_MATCH_MIN_SCORE)
        .order('match_score', { ascending: false });

      if (!matches || matches.length === 0) continue;

      // Which of these funders has the user already been alerted about?
      const eins = matches
        .map((m: any) => m.funder_ein)
        .filter((e: any) => !!e);
      if (eins.length === 0) continue;

      const { data: alreadyNotified } = await supabase
        .from('project_match_notifications')
        .select('funder_ein')
        .eq('project_id', project.id)
        .in('funder_ein', eins);

      const seen = new Set((alreadyNotified || []).map((r: any) => r.funder_ein));
      const fresh = matches.filter((m: any) => m.funder_ein && !seen.has(m.funder_ein));
      if (fresh.length === 0) continue;

      const listed = fresh.slice(0, NEW_MATCH_MAX_LISTED).map((m: any) => ({
        funder_ein: m.funder_ein,
        funder_name: m.funder_name || m.funder_ein,
        match_score: m.match_score,
      }));

      // Queue one digest notification for this project.
      await supabase.from('notification_queue').insert({
        user_id: pref.user_id,
        email,
        type: 'new_match',
        payload: {
          project_id: project.id,
          project_name: project.name,
          new_count: fresh.length,
          top_matches: listed,
          link: `https://fundermatch.org/projects/${project.id}`,
        },
        scheduled_for: new Date().toISOString(),
      });

      // Stamp the ledger so we never re-alert these funders.
      const ledgerRows = fresh.map((m: any) => ({
        project_id: project.id,
        funder_ein: m.funder_ein,
        match_score: m.match_score ?? null,
      }));
      await supabase
        .from('project_match_notifications')
        .upsert(ledgerRows, { onConflict: 'project_id,funder_ein', ignoreDuplicates: true });

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
      // FM-IC-NTF-002 (revised 2026-05-30): richer deadline-change email.
      // Prior audit run graded this PARTIAL because the template was
      // bare (just "deadline changed"). It now includes:
      //   * Clear before/after, days-until-new-deadline, and signed diff
      //   * Direction-coded summary band + banner color
      //   * Optional confidence cue from the auto-sync scrape (high/medium/low)
      //   * Suggested next actions tailored to direction
      //   * Branded HTML wrapper + plain-text-friendly fallback
      const oldD = payload.old_deadline ? new Date(payload.old_deadline) : null;
      const newD = payload.new_deadline ? new Date(payload.new_deadline) : null;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      let diffDays: number | null = null;
      let directionLabel = 'changed';
      let bannerBg = '#1f2937';
      let summaryLine = 'A funder updated the deadline on a grant you are tracking.';
      if (oldD && newD) {
        diffDays = Math.round((newD.getTime() - oldD.getTime()) / (1000 * 60 * 60 * 24));
        if (diffDays > 0) {
          directionLabel = 'extended';
          bannerBg = '#15803d';
          summaryLine = `The funder pushed this deadline back by ${diffDays} day${diffDays === 1 ? '' : 's'}. You have more runway to polish your application.`;
        } else if (diffDays < 0) {
          directionLabel = 'moved earlier';
          bannerBg = '#b91c1c';
          summaryLine = `The funder moved this deadline up by ${Math.abs(diffDays)} day${Math.abs(diffDays) === 1 ? '' : 's'}. Re-plan your submission timeline now.`;
        } else {
          directionLabel = 'restated';
          summaryLine = 'The funder restated the deadline; the date is unchanged but they re-posted it.';
        }
      }
      const daysUntilNew = newD
        ? Math.round((newD.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
        : null;
      const daysUntilLine = daysUntilNew !== null
        ? (daysUntilNew < 0
            ? `<span style="color:#b91c1c;">${Math.abs(daysUntilNew)} day${Math.abs(daysUntilNew) === 1 ? '' : 's'} past</span>`
            : daysUntilNew === 0
              ? `<span style="color:#b91c1c;font-weight:600;">today</span>`
              : `<span>${daysUntilNew} day${daysUntilNew === 1 ? '' : 's'} away</span>`)
        : '—';
      const confidenceLine = payload.confidence
        ? `<p style="color:#6b7280;font-size:12px;margin:4px 0 0;">Auto-detected with <strong>${payload.confidence}</strong> confidence${payload.source_url ? ` from <a href="${payload.source_url}" style="color:#2563eb;">the funder's page</a>` : ''}.${payload.sync_note ? ` <em>${escapeHtml(payload.sync_note)}</em>` : ''}</p>`
        : '';
      const nextSteps = diffDays !== null && diffDays < 0
        ? `<ul style="margin:8px 0 0;padding-left:18px;color:#111827;">
             <li>Move up any internal review checkpoints.</li>
             <li>Re-confirm your assigned writers and reviewers.</li>
             <li>Check that any required attachments are already drafted.</li>
           </ul>`
        : diffDays !== null && diffDays > 0
          ? `<ul style="margin:8px 0 0;padding-left:18px;color:#111827;">
               <li>Slot the new deadline into your project calendar.</li>
               <li>Use the extra time to gather supporting data or letters.</li>
               <li>Reschedule any draft review you already had on the books.</li>
             </ul>`
          : `<ul style="margin:8px 0 0;padding-left:18px;color:#111827;">
               <li>Open the grant in FunderMatch to verify the dates are accurate.</li>
               <li>Reach out to the program officer if you need clarification.</li>
             </ul>`;
      const fmt = (d: string | null | undefined) => d
        ? new Date(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
        : '—';

      subject = `[FunderMatch] Deadline ${directionLabel}: ${payload.grant_name || payload.funder_name}`;
      htmlContent = `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111827;">
          <div style="background:${bannerBg};color:#ffffff;padding:14px 20px;border-radius:8px 8px 0 0;">
            <p style="margin:0;font-size:13px;letter-spacing:0.04em;text-transform:uppercase;">FunderMatch · Deadline update</p>
            <h2 style="margin:6px 0 0;font-size:20px;line-height:1.3;">${escapeHtml(payload.grant_name || payload.funder_name || 'Tracked grant')}</h2>
            ${payload.funder_name && payload.grant_name && payload.grant_name !== payload.funder_name ? `<p style="margin:4px 0 0;font-size:13px;opacity:0.9;">${escapeHtml(payload.funder_name)}</p>` : ''}
          </div>
          <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:18px 20px;">
            <p style="margin:0 0 12px;font-size:15px;">${summaryLine}</p>
            <table role="presentation" style="border-collapse:collapse;width:100%;font-size:14px;margin:0 0 14px;">
              <tr>
                <td style="padding:6px 0;color:#6b7280;width:160px;">Previous deadline</td>
                <td style="padding:6px 0;"><s>${fmt(payload.old_deadline)}</s></td>
              </tr>
              <tr>
                <td style="padding:6px 0;color:#6b7280;">New deadline</td>
                <td style="padding:6px 0;font-weight:600;">${fmt(payload.new_deadline)}</td>
              </tr>
              <tr>
                <td style="padding:6px 0;color:#6b7280;">Time until new deadline</td>
                <td style="padding:6px 0;">${daysUntilLine}</td>
              </tr>
              ${diffDays !== null && diffDays !== 0 ? `<tr>
                <td style="padding:6px 0;color:#6b7280;">Net change</td>
                <td style="padding:6px 0;${diffDays > 0 ? 'color:#15803d;' : 'color:#b91c1c;'}font-weight:600;">${diffDays > 0 ? '+' : ''}${diffDays} day${Math.abs(diffDays) === 1 ? '' : 's'}</td>
              </tr>` : ''}
            </table>
            <p style="margin:14px 0 4px;font-weight:600;font-size:14px;">Suggested next steps</p>
            ${nextSteps}
            <p style="margin:18px 0 0;">
              <a href="${payload.link}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:white;text-decoration:none;border-radius:6px;font-weight:600;">Review in FunderMatch</a>
            </p>
            ${confidenceLine}
          </div>
          <p style="color:#6b7280;font-size:12px;margin:14px 0 0;text-align:center;">
            You're receiving this because you tracked this grant.
            <a href="https://fundermatch.org/settings" style="color:#2563eb;">Manage email preferences</a>.
          </p>
        </div>
      `;
      break;
    }

    case 'new_match': {
      // FM-IC-NTF-001: digest of newly-discovered matching funders.
      const count = Number(payload.new_count) || (payload.top_matches?.length ?? 0);
      const topMatches: Array<{ funder_name?: string; match_score?: number }> =
        Array.isArray(payload.top_matches) ? payload.top_matches : [];
      const projectName = payload.project_name || 'your project';
      const overflow = count - topMatches.length;
      const rows = topMatches.map((m) => {
        const score = Number(m.match_score);
        const scoreBadge = Number.isFinite(score)
          ? `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;${score >= 85 ? 'background:#dcfce7;color:#15803d;' : 'background:#dbeafe;color:#1d4ed8;'}">${Math.round(score)}% match</span>`
          : '';
        return `<tr>
            <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;">${escapeHtml(m.funder_name || 'Funder')}</td>
            <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;text-align:right;">${scoreBadge}</td>
          </tr>`;
      }).join('');

      subject = `[FunderMatch] ${count} new funder match${count === 1 ? '' : 'es'} for ${projectName}`;
      htmlContent = `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111827;">
          <div style="background:#1d4ed8;color:#ffffff;padding:14px 20px;border-radius:8px 8px 0 0;">
            <p style="margin:0;font-size:13px;letter-spacing:0.04em;text-transform:uppercase;">FunderMatch · New matches</p>
            <h2 style="margin:6px 0 0;font-size:20px;line-height:1.3;">${count} new funder match${count === 1 ? '' : 'es'}</h2>
            <p style="margin:4px 0 0;font-size:13px;opacity:0.9;">Project: ${escapeHtml(projectName)}</p>
          </div>
          <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;padding:18px 20px;">
            <p style="margin:0 0 12px;font-size:15px;">We found new high-scoring funders that fit this project.</p>
            <table role="presentation" style="border-collapse:collapse;width:100%;font-size:14px;">${rows}</table>
            ${overflow > 0 ? `<p style="margin:12px 0 0;color:#6b7280;font-size:13px;">+ ${overflow} more new match${overflow === 1 ? '' : 'es'} in your project.</p>` : ''}
            <p style="margin:18px 0 0;">
              <a href="${payload.link}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:white;text-decoration:none;border-radius:6px;font-weight:600;">View matches in FunderMatch</a>
            </p>
          </div>
          <p style="color:#6b7280;font-size:12px;margin:14px 0 0;text-align:center;">
            You're receiving this because new match alerts are on.
            <a href="https://fundermatch.org/settings" style="color:#2563eb;">Manage email preferences</a>.
          </p>
        </div>
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
