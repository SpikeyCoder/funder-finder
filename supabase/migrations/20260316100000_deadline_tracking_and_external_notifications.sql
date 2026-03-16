-- Add previous_deadline column for deadline change detection
ALTER TABLE public.tracked_grants ADD COLUMN IF NOT EXISTS previous_deadline date;

-- Create trigger to track deadline changes
CREATE OR REPLACE FUNCTION public.track_deadline_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.deadline IS DISTINCT FROM NEW.deadline THEN
    NEW.previous_deadline = OLD.deadline;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_track_deadline_change ON public.tracked_grants;
CREATE TRIGGER trg_track_deadline_change
  BEFORE UPDATE ON public.tracked_grants
  FOR EACH ROW EXECUTE FUNCTION public.track_deadline_change();

-- Allow nullable user_id in notification_queue for external assignees
ALTER TABLE public.notification_queue ALTER COLUMN user_id DROP NOT NULL;
