-- Enable pg_cron extension for job scheduling
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- Function to schedule deadline reminders
-- This function processes tracked grants and tasks to queue up notification reminders
-- based on user preferences and upcoming deadlines
CREATE OR REPLACE FUNCTION public.schedule_deadline_reminders()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $function$
DECLARE
  v_now timestamptz := now();
  v_today date := current_date;
BEGIN
  -- For each user with email notifications enabled,
  -- find tracked grants with deadlines matching their reminder intervals
  INSERT INTO notification_queue (id, user_id, email, type, payload, scheduled_for, created_at)
  SELECT
    gen_random_uuid(),
    np.user_id,
    au.email,
    'deadline_reminder',
    jsonb_build_object(
      'grant_id', tg.id,
      'funder_name', tg.funder_name,
      'grant_title', tg.grant_title,
      'deadline', tg.deadline,
      'days_until', (tg.deadline - v_today),
      'project_id', tg.project_id,
      'link', 'https://fundermatch.org/projects/' || tg.project_id || '/tracker'
    ),
    v_now,
    v_now
  FROM notification_preferences np
  JOIN auth.users au ON au.id = np.user_id
  JOIN tracked_grants tg ON tg.user_id = np.user_id
  JOIN pipeline_statuses ps ON ps.id = tg.status_id
  WHERE np.email_enabled = true
    AND tg.deadline IS NOT NULL
    AND tg.deadline >= v_today
    AND ps.is_terminal = false
    AND (tg.deadline - v_today) = ANY(np.deadline_reminders)
    -- Don't duplicate: skip if already queued for this grant+day combo
    AND NOT EXISTS (
      SELECT 1 FROM notification_queue nq
      WHERE nq.user_id = np.user_id
        AND nq.type = 'deadline_reminder'
        AND nq.payload->>'grant_id' = tg.id::text
        AND nq.payload->>'days_until' = ((tg.deadline - v_today))::text
    );

  -- Also schedule task reminders
  INSERT INTO notification_queue (id, user_id, email, type, payload, scheduled_for, created_at)
  SELECT
    gen_random_uuid(),
    np.user_id,
    au.email,
    'task_reminder',
    jsonb_build_object(
      'task_id', t.id,
      'task_title', t.title,
      'due_date', t.due_date,
      'days_until', (t.due_date - v_today),
      'grant_id', t.tracked_grant_id,
      'project_id', t.project_id,
      'link', 'https://fundermatch.org/tasks'
    ),
    v_now,
    v_now
  FROM notification_preferences np
  JOIN auth.users au ON au.id = np.user_id
  JOIN tasks t ON t.user_id = np.user_id
  WHERE np.email_enabled = true
    AND t.due_date IS NOT NULL
    AND t.due_date >= v_today
    AND t.status != 'done'
    AND (t.due_date - v_today) = ANY(np.task_reminders)
    AND NOT EXISTS (
      SELECT 1 FROM notification_queue nq
      WHERE nq.user_id = np.user_id
        AND nq.type = 'task_reminder'
        AND nq.payload->>'task_id' = t.id::text
        AND nq.payload->>'days_until' = ((t.due_date - v_today))::text
    );

END;
$function$;

-- Schedule the reminder function to run every hour at minute 0
-- Uses cron.schedule which is the standard pg_cron interface
SELECT cron.schedule(
  'schedule-deadline-reminders',
  '0 * * * *',
  'SELECT public.schedule_deadline_reminders()'
);

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION public.schedule_deadline_reminders() TO authenticated;
