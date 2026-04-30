// Phase 3D: Calendar feed (.ics) generation
// Public endpoint authenticated by token in URL

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

import { corsHeaders as _corsHeaders } from "../_shared/cors.ts";

const CORS_HEADERS_OPTS = { allowAny: true, methods: "GET, POST, DELETE, OPTIONS" } as const;
function CORS_HEADERS(req: Request | null = null): Record<string, string> {
  return _corsHeaders(req?.headers.get("origin") ?? null, CORS_HEADERS_OPTS);
}

function jsonResponse(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS(req), 'Content-Type': 'application/json' },
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

function formatDate(dateStr: string): string {
  return dateStr.replace(/-/g, '');
}

function escapeIcs(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS(req) });
  }

  const url = new URL(req.url);
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // GET with token parameter = serve .ics feed (public, no auth needed)
  const feedToken = url.searchParams.get('token');
  if (req.method === 'GET' && feedToken) {
    // Look up feed by token
    const { data: feed, error: feedError } = await supabase
      .from('calendar_feeds')
      .select('*')
      .eq('token', feedToken)
      .single();

    if (feedError || !feed) {
      return new Response('Not Found', { status: 404 });
    }

    // Update last_accessed
    await supabase
      .from('calendar_feeds')
      .update({ last_accessed: new Date().toISOString() })
      .eq('id', feed.id);

    // Get tracked grants with deadlines
    let grantsQuery = supabase
      .from('tracked_grants')
      .select('*, pipeline_statuses(name, slug)')
      .eq('user_id', feed.user_id)
      .not('deadline', 'is', null);

    if (feed.project_id) {
      grantsQuery = grantsQuery.eq('project_id', feed.project_id);
    }

    const { data: grants } = await grantsQuery;

    // Get project name for calendar title
    let calName = 'FunderMatch Deadlines';
    if (feed.project_id) {
      const { data: project } = await supabase
        .from('projects')
        .select('name')
        .eq('id', feed.project_id)
        .single();
      if (project) calName = `FunderMatch - ${project.name}`;
    }

    // Build .ics content
    const events: string[] = [];

    for (const g of grants || []) {
      const status = (g as any).pipeline_statuses?.name || '';
      const summary = escapeIcs(`DEADLINE: ${g.funder_name}${g.grant_title ? ' - ' + g.grant_title : ''}`);
      const description = escapeIcs(
        `Status: ${status}` +
        (g.amount ? `\\nAmount: $${parseFloat(g.amount).toLocaleString()}` : '') +
        `\\nView: https://fundermatch.org/projects/${g.project_id}`
      );

      events.push(
        `BEGIN:VEVENT\r\n` +
        `UID:grant-${g.id}@fundermatch.org\r\n` +
        `DTSTART;VALUE=DATE:${formatDate(g.deadline)}\r\n` +
        `SUMMARY:${summary}\r\n` +
        `DESCRIPTION:${description}\r\n` +
        `BEGIN:VALARM\r\nTRIGGER:-P7D\r\nACTION:DISPLAY\r\nDESCRIPTION:Grant deadline in 7 days\r\nEND:VALARM\r\n` +
        `BEGIN:VALARM\r\nTRIGGER:-P1D\r\nACTION:DISPLAY\r\nDESCRIPTION:Grant deadline tomorrow\r\nEND:VALARM\r\n` +
        `END:VEVENT`
      );
    }

    // Include tasks if enabled
    if (feed.include_tasks) {
      let tasksQuery = supabase
        .from('tasks')
        .select('*, tracked_grants(funder_name, grant_title)')
        .eq('user_id', feed.user_id)
        .not('due_date', 'is', null)
        .neq('status', 'done');

      if (feed.project_id) {
        tasksQuery = tasksQuery.eq('project_id', feed.project_id);
      }

      const { data: tasks } = await tasksQuery;

      for (const t of tasks || []) {
        const grantInfo = (t as any).tracked_grants;
        const summary = escapeIcs(`TASK: ${t.title}`);
        const description = escapeIcs(
          (grantInfo ? `Grant: ${grantInfo.funder_name}${grantInfo.grant_title ? ' - ' + grantInfo.grant_title : ''}` : '') +
          (t.description ? `\\n${t.description}` : '')
        );

        events.push(
          `BEGIN:VEVENT\r\n` +
          `UID:task-${t.id}@fundermatch.org\r\n` +
          `DTSTART;VALUE=DATE:${formatDate(t.due_date)}\r\n` +
          `SUMMARY:${summary}\r\n` +
          `DESCRIPTION:${description}\r\n` +
          `BEGIN:VALARM\r\nTRIGGER:-P1D\r\nACTION:DISPLAY\r\nDESCRIPTION:Task due tomorrow\r\nEND:VALARM\r\n` +
          `END:VEVENT`
        );
      }
    }

    const icsContent =
      `BEGIN:VCALENDAR\r\n` +
      `VERSION:2.0\r\n` +
      `PRODID:-//FunderMatch//Calendar//EN\r\n` +
      `X-WR-CALNAME:${escapeIcs(calName)}\r\n` +
      `CALSCALE:GREGORIAN\r\n` +
      `METHOD:PUBLISH\r\n` +
      events.join('\r\n') + '\r\n' +
      `END:VCALENDAR\r\n`;

    return new Response(icsContent, {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'attachment; filename="fundermatch.ics"',
        'Cache-Control': 'max-age=3600',
        ...CORS_HEADERS(req),
      },
    });
  }

  // Authenticated endpoints for managing feeds
  const user = await getUserFromRequest(req);
  if (!user) return errorResponse(req, 'Unauthorized', 401);

  if (req.method === 'GET') {
    // List user's feeds
    const { data: feeds, error } = await supabase
      .from('calendar_feeds')
      .select('*, projects(name)')
      .eq('user_id', user.id);

    if (error) return errorResponse(req, error.message, 500);
    return jsonResponse(req, feeds || []);
  }

  if (req.method === 'POST') {
    const body = await req.json();
    const projectId = body.project_id || null;
    const includeTasks = body.include_tasks !== false;

    // Generate a secure random token
    const token = crypto.randomUUID() + '-' + crypto.randomUUID();

    const { data: feed, error } = await supabase.from('calendar_feeds').insert({
      user_id: user.id,
      project_id: projectId,
      token,
      include_tasks: includeTasks,
    }).select().single();

    if (error) return errorResponse(req, error.message, 500);

    const feedUrl = `${SUPABASE_URL}/functions/v1/calendar-feed?token=${token}`;
    return jsonResponse(req, { ...feed, feed_url: feedUrl }, 201);
  }

  if (req.method === 'DELETE') {
    const feedId = url.searchParams.get('id');
    if (!feedId) return errorResponse(req, 'Feed ID required');

    const { error } = await supabase
      .from('calendar_feeds')
      .delete()
      .eq('id', feedId)
      .eq('user_id', user.id);

    if (error) return errorResponse(req, error.message, 500);
    return jsonResponse(req, { success: true });
  }

  return errorResponse(req, 'Method not allowed', 405);
});
