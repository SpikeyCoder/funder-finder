-- Phase 3A: Grant status history for audit trail and metrics

CREATE TABLE IF NOT EXISTS grant_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracked_grant_id uuid NOT NULL REFERENCES tracked_grants(id) ON DELETE CASCADE,
  from_status_id uuid REFERENCES pipeline_statuses(id),
  to_status_id uuid NOT NULL REFERENCES pipeline_statuses(id),
  changed_by uuid NOT NULL REFERENCES auth.users(id),
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_grant_status_history_grant ON grant_status_history(tracked_grant_id, changed_at DESC);

-- RLS
ALTER TABLE grant_status_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own grant history"
  ON grant_status_history FOR SELECT
  USING (changed_by = auth.uid());

CREATE POLICY "Users can insert own grant history"
  ON grant_status_history FOR INSERT
  WITH CHECK (changed_by = auth.uid());

-- Trigger: auto-record status changes
CREATE OR REPLACE FUNCTION record_grant_status_change()
RETURNS trigger AS $$
BEGIN
  IF OLD.status_id IS DISTINCT FROM NEW.status_id THEN
    INSERT INTO grant_status_history (tracked_grant_id, from_status_id, to_status_id, changed_by)
    VALUES (NEW.id, OLD.status_id, NEW.status_id, NEW.user_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER tracked_grants_status_history
  AFTER UPDATE ON tracked_grants
  FOR EACH ROW
  WHEN (OLD.status_id IS DISTINCT FROM NEW.status_id)
  EXECUTE FUNCTION record_grant_status_change();
