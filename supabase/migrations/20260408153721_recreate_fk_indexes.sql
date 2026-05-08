-- Recreate indexes for foreign keys that need covering indexes
-- These were dropped as "unused" but Supabase now flags the FKs as unindexed
CREATE INDEX IF NOT EXISTS idx_access_log_link_id ON public.access_log(link_id);
CREATE INDEX IF NOT EXISTS idx_access_log_user_id ON public.access_log(user_id);
CREATE INDEX IF NOT EXISTS idx_kb_project_id ON public.application_knowledge_base(project_id);
CREATE INDEX IF NOT EXISTS idx_kb_tracked_grant ON public.application_knowledge_base(tracked_grant_id);
CREATE INDEX IF NOT EXISTS idx_bookmarked_passages_kb ON public.bookmarked_passages(kb_entry_id);
CREATE INDEX IF NOT EXISTS idx_calendar_feeds_project ON public.calendar_feeds(project_id);
CREATE INDEX IF NOT EXISTS idx_compliance_req_assignee ON public.compliance_requirements(assignee_user_id);
CREATE INDEX IF NOT EXISTS idx_compliance_req_project ON public.compliance_requirements(project_id);
CREATE INDEX IF NOT EXISTS idx_grant_history_changed_by ON public.grant_status_history(changed_by);
CREATE INDEX IF NOT EXISTS idx_grant_history_from_status ON public.grant_status_history(from_status_id);
CREATE INDEX IF NOT EXISTS idx_grant_history_to_status ON public.grant_status_history(to_status_id);
CREATE INDEX IF NOT EXISTS idx_notif_queue_user ON public.notification_queue(user_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_first_project ON public.onboarding_progress(first_project_id);
CREATE INDEX IF NOT EXISTS idx_proj_access_granted_by ON public.project_access(granted_by);
CREATE INDEX IF NOT EXISTS idx_proj_access_user ON public.project_access(user_id);
CREATE INDEX IF NOT EXISTS idx_signal_events_user ON public.search_signal_events(user_id);
CREATE INDEX IF NOT EXISTS idx_share_links_created_by ON public.shareable_links(created_by);
CREATE INDEX IF NOT EXISTS idx_share_links_project ON public.shareable_links(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON public.tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tracked_grants_status ON public.tracked_grants(status_id);
