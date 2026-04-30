// send-reminders: Process pending notifications from the queue and send emails
// This is a convenience wrapper around process-notifications with action=process

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY') || '';

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
    headers['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS';
  }
  return headers;
}

function jsonResponse(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders(req) });
  }

  if (req.method !== 'POST') {
    return jsonResponse(req, { error: 'Method not allowed' }, 405);
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Get pending notifications
    const { data: pending } = await supabase
      .from('notification_queue')
      .select('*')
      .is('sent_at', null)
      .lte('scheduled_for', new Date().toISOString())
      .lt('retry_count', 3)
      .order('scheduled_for')
      .limit(100);

    if (!pending || pending.length === 0) {
      return jsonResponse(req, { sent: 0, message: 'No pending notifications' });
    }

    let sent = 0;
    let failed = 0;

    for (const notification of pending) {
      try {
        await sendEmail(notification);
        await supabase
          .from('notification_queue')
          .update({ sent_at: new Date().toISOString() })
          .eq('id', notification.id);
        sent++;
      } catch (err: any) {
        console.error(`Failed to send notification ${notification.id}:`, err.message);
        await supabase
          .from('notification_queue')
          .update({
            error: err.message,
            retry_count: notification.retry_count + 1,
          })
          .eq('id', notification.id);
        failed++;
      }
    }

    return jsonResponse(req, { sent, failed, total: pending.length });
  } catch (err: any) {
    console.error('send-reminders error:', err);
    return jsonResponse(req, { error: err.message }, 500);
  }
});

async function sendEmail(notification: any): Promise<void> {
  if (!SENDGRID_API_KEY) {
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

    case 'deadline_changed':
      subject = `[FunderMatch] Deadline changed: ${payload.grant_name}`;
      htmlContent = `
        <h2>Grant Deadline Changed</h2>
        <p><strong>${payload.grant_name}</strong></p>
        <p>Previous deadline: <strong>${payload.old_deadline}</strong></p>
        <p>New deadline: <strong>${payload.new_deadline}</strong></p>
        <p><a href="${payload.link}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:white;text-decoration:none;border-radius:6px;">View in FunderMatch</a></p>
      `;
      break;

    case 'compliance_reminder':
      subject = `[FunderMatch] Compliance due: ${payload.title}`;
      htmlContent = `
        <h2>Compliance Deadline Reminder</h2>
        <p><strong>${payload.title}</strong></p>
        <p>Due: <strong>${payload.due_date}</strong> (${payload.days_until} day${payload.days_until !== 1 ? 's' : ''} away)</p>
        <p><a href="${payload.link}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:white;text-decoration:none;border-radius:6px;">View in FunderMatch</a></p>
      `;
      break;

    case 'status_changed':
      subject = `[FunderMatch] Status updated: ${payload.grant_name}`;
      htmlContent = `
        <h2>Grant Status Changed</h2>
        <p><strong>${payload.grant_name}</strong></p>
        <p>Status: <strong>${payload.old_status}</strong> → <strong>${payload.new_status}</strong></p>
        <p><a href="${payload.link}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:white;text-decoration:none;border-radius:6px;">View in FunderMatch</a></p>
      `;
      break;

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
