import { sanitiseError } from '../_shared/errors.ts';
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


// FM-2026-06-17-03: defense-in-depth cron-only auth gate. This endpoint is
// designed to be invoked by pg_cron / the Supabase scheduler -- it uses
// the service-role key internally and has no per-user authorization.
// The Supabase gateway already requires a valid project apikey, but
// that key is also embedded in the public SPA bundle, so without an
// additional shared secret any authenticated session could trigger the
// job. When CRON_SECRET is configured we require the caller to present
// it via either `X-Cron-Secret: <value>` or
// `Authorization: Bearer cron:<value>`. When CRON_SECRET is unset
// (e.g. local dev) we fall through unchanged so behaviour is
// backward-compatible.
function _cronSecretAllowed(request: Request): boolean {
  const expected = Deno.env.get('CRON_SECRET') || '';
  if (!expected) return true; // not configured -> no enforcement
  const header = request.headers.get('x-cron-secret') || '';
  if (header && _ctEq(header, expected)) return true;
  const auth = request.headers.get('authorization') || '';
  if (auth.startsWith('Bearer cron:')) {
    const presented = auth.slice('Bearer cron:'.length).trim();
    if (presented && _ctEq(presented, expected)) return true;
  }
  return false;
}

function _ctEq(a: string, b: string): boolean {
  // Length-independent comparison so the gate does not leak the
  // configured secret length via timing.
  if (a.length !== b.length) {
    // Constant-time over the longer string to keep work uniform.
    let acc = 1;
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      acc &= (a.charCodeAt(i % Math.max(a.length, 1)) ^ b.charCodeAt(i % Math.max(b.length, 1))) === 0 ? 1 : 0;
    }
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS(req) });
  }

  if (req.method !== 'POST') {
    return jsonResponse(req, { error: 'Method not allowed' }, 405);
  }

// FM-2026-06-17-03: enforce CRON_SECRET if configured.
if (!_cronSecretAllowed(req)) {
  return new Response(JSON.stringify({ error: 'forbidden' }), {
    status: 403,
    headers: { ...CORS_HEADERS(req), 'Content-Type': 'application/json' },
  });
}


  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const deadlineReminders = await scheduleDeadlineReminders(supabase);
    const taskReminders = await scheduleTaskReminders(supabase);
    const externalReminders = await scheduleExternalAssigneeReminders(supabase);
    // FM-IC-NTF-002 (consolidated from PR #21): re-scrape funder URLs first
    // so any deadline changes get written to tracked_grants. The track_deadline
    // _change DB trigger captures previous_deadline, and the existing
    // detectDeadlineChanges() routine then queues the alert email.
    const deadlinesSynced = await syncDeadlinesFromUrls(supabase);
    const deadlineChanges = await detectDeadlineChanges(supabase);

    return jsonResponse(req, {
      deadline_reminders_scheduled: deadlineReminders,
      task_reminders_scheduled: taskReminders,
      external_assignee_reminders: externalReminders,
      deadlines_synced_from_urls: deadlinesSynced,
      deadline_changes_detected: deadlineChanges,
    });
  } catch (err: any) {
    console.error('check-deadlines error:', err);
    return jsonResponse(req, { error: sanitiseError(err, 'Internal server error') }, 500);
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
// FM-IC-NTF-002: broadened lookback to 7d so a missed cron run doesn't drop
// alerts, and the queued payload now carries days_diff + direction so the
// email template can render a richer message.
async function detectDeadlineChanges(supabase: any): Promise<number> {
  let detected = 0;
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: grants } = await supabase
    .from('tracked_grants')
    .select('id, user_id, funder_name, grant_title, deadline, project_id, previous_deadline, updated_at')
    .not('deadline', 'is', null)
    .gt('updated_at', sevenDaysAgo);

  if (!grants) return 0;

  for (const grant of grants) {
    if (!grant.previous_deadline || grant.previous_deadline === grant.deadline) continue;

    const { data: userData } = await supabase.auth.admin.getUserById(grant.user_id);
    if (!userData?.user?.email) continue;

    // Dedupe: same (grant_id, new_deadline) — never alert twice for same change.
    const { data: existing } = await supabase
      .from('notification_queue')
      .select('id')
      .eq('user_id', grant.user_id)
      .eq('type', 'deadline_changed')
      .filter('payload->>grant_id', 'eq', grant.id)
      .filter('payload->>new_deadline', 'eq', grant.deadline)
      .limit(1);

    if (existing && existing.length > 0) continue;

    const oldMs = Date.parse(grant.previous_deadline);
    const newMs = Date.parse(grant.deadline);
    const daysDiff = Number.isFinite(oldMs) && Number.isFinite(newMs)
      ? Math.round((newMs - oldMs) / (1000 * 60 * 60 * 24))
      : null;
    const direction = daysDiff == null
      ? 'changed'
      : daysDiff > 0 ? 'extended'
      : daysDiff < 0 ? 'moved_earlier'
      : 'unchanged';

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
        days_diff: daysDiff,
        direction,
        detected_at: new Date().toISOString(),
        link: `https://fundermatch.org/projects/${grant.project_id}/tracker`,
      },
      scheduled_for: new Date().toISOString(),
    });
    detected++;
  }
  return detected;
}

// ──────────────────────────────────────────────────────────────────────
// FM-IC-NTF-002 / PR #21 consolidation:
// Auto-sync grant deadlines from funder websites.
//
// For each tracked grant that:
//   (a) has a grant_url
//   (b) is NOT in a terminal pipeline status (awarded/rejected)
//   (c) was last synced > 24h ago (or never)
// we call the fetch-grant-deadline edge function (Claude-Haiku-backed
// scraper). When the extractor returns a high/medium-confidence date
// that differs from the current deadline, we write it; the
// track_deadline_change DB trigger then snapshots previous_deadline so
// detectDeadlineChanges() will queue an alert in the same cron tick.
//
// The batch is capped (BATCH_LIMIT) so a single cron run stays bounded
// even when the funder portfolio grows. deadline_synced_at is updated
// regardless of outcome to throttle.
// ──────────────────────────────────────────────────────────────────────
const BATCH_LIMIT = 25;
const STALE_HOURS = 24;
const FETCH_DEADLINE_URL = `${SUPABASE_URL}/functions/v1/fetch-grant-deadline`;

async function syncDeadlinesFromUrls(supabase: any): Promise<number> {
  const staleCutoff = new Date(Date.now() - STALE_HOURS * 60 * 60 * 1000).toISOString();

  // Skip grants in terminal pipeline statuses (awarded/rejected).
  const { data: terminalStatuses } = await supabase
    .from('pipeline_statuses')
    .select('id')
    .eq('is_terminal', true);
  const terminalIds = (terminalStatuses || []).map((p: any) => p.id);

  let query = supabase
    .from('tracked_grants')
    .select('id, user_id, funder_name, grant_url, deadline, deadline_synced_at, status_id')
    .not('grant_url', 'is', null)
    .or(`deadline_synced_at.is.null,deadline_synced_at.lt.${staleCutoff}`)
    .limit(BATCH_LIMIT);

  if (terminalIds.length > 0) {
    query = query.not('status_id', 'in', `(${terminalIds.join(',')})`);
  }

  const { data: grants, error } = await query;
  if (error) {
    console.error('[syncDeadlinesFromUrls] select error:', error);
    return 0;
  }
  if (!grants || grants.length === 0) return 0;

  let synced = 0;

  for (const grant of grants) {
    let extracted: { deadline: string | null; confidence: string; notes: string } = {
      deadline: null, confidence: 'error', notes: '',
    };

    try {
      const resp = await fetch(FETCH_DEADLINE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
        body: JSON.stringify({
          url: grant.grant_url,
          funder_name: grant.funder_name || '',
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        extracted = {
          deadline: typeof data.deadline === 'string' ? data.deadline : null,
          confidence: typeof data.confidence === 'string' ? data.confidence : 'none',
          notes: typeof data.notes === 'string' ? data.notes : '',
        };
      } else {
        extracted.notes = `Extractor returned HTTP ${resp.status}`;
      }
    } catch (err: any) {
      console.error('[syncDeadlinesFromUrls] fetch error for grant', grant.id, err?.message);
      extracted.notes = 'Could not reach extractor';
    }

    const updates: Record<string, unknown> = {
      deadline_synced_at: new Date().toISOString(),
      deadline_sync_status: extracted.confidence,
      deadline_sync_note: extracted.notes?.slice(0, 500) || null,
    };

    // Only write deadline when high/medium confidence and it actually differs.
    // Low/none confidence is recorded as a sync attempt but we don't overwrite
    // a user-curated date with a speculative one.
    if (
      extracted.deadline &&
      /^\d{4}-\d{2}-\d{2}$/.test(extracted.deadline) &&
      ['high', 'medium'].includes(extracted.confidence) &&
      extracted.deadline !== grant.deadline
    ) {
      updates.deadline = extracted.deadline;
      synced++;
    }

    const { error: upErr } = await supabase
      .from('tracked_grants')
      .update(updates)
      .eq('id', grant.id);
    if (upErr) {
      console.error('[syncDeadlinesFromUrls] update error for grant', grant.id, upErr.message);
    }
  }

  return synced;
}
