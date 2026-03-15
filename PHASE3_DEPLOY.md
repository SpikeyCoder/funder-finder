# Phase 3 Deployment Guide

## Overview

Phase 3 adds Pipeline Depth, Tasks & Deadline Management to FunderMatch. This includes 8 database migrations, 6 new edge functions, and updated frontend pages.

## Pre-Deployment Checklist

- [ ] Ensure you're on the latest `main` branch
- [ ] Supabase CLI is installed and linked (`supabase link --project-ref tgtotjvdubhjxzybmdex`)

---

## Step 1: Run Database Migrations (in order)

Migrations must run sequentially because they have dependencies.

```bash
# From the project root in Cloud Shell:
supabase db push
```

This runs all pending migrations in `supabase/migrations/` in filename order. The 8 new migrations are:

1. `20260315010000_create_pipeline_statuses.sql` — Pipeline status table + auto-seed trigger
2. `20260315010001_create_tracked_grants.sql` — Tracked grants table (replaces project_saved_funders)
3. `20260315010002_create_grant_status_history.sql` — Audit trail for status changes
4. `20260315010003_migrate_saved_funders.sql` — Migrates existing saved funders to tracked_grants
5. `20260315010004_create_tasks.sql` — Task management with overdue detection
6. `20260315010005_create_notification_system.sql` — Notification preferences + queue
7. `20260315010006_create_calendar_feeds.sql` — Calendar feed tokens
8. `20260315010007_performance_fixes.sql` — Missing indexes + seeds for existing users

If `supabase db push` fails, run migrations individually:

```bash
# Connect to the database and run each SQL file:
supabase db execute --file supabase/migrations/20260315010000_create_pipeline_statuses.sql
supabase db execute --file supabase/migrations/20260315010001_create_tracked_grants.sql
# ... and so on for each migration
```

## Step 2: Deploy Edge Functions

```bash
# Deploy all 6 new edge functions
supabase functions deploy tracked-grants --no-verify-jwt
supabase functions deploy pipeline-statuses --no-verify-jwt
supabase functions deploy portfolio --no-verify-jwt
supabase functions deploy grant-tasks --no-verify-jwt
supabase functions deploy calendar-feed --no-verify-jwt
supabase functions deploy process-notifications --no-verify-jwt
```

## Step 3: Build & Deploy Frontend

```bash
npm install
npm run build
git add -A
git commit -m "Phase 3: Pipeline depth, tasks & deadline management"
git push origin main
```

GitHub Actions will auto-deploy to GitHub Pages.

## Step 4: Post-Deployment Verification

### Test Pipeline Statuses
1. Log in at fundermatch.org
2. Go to Dashboard → any project → Tracker tab
3. Verify 8 default pipeline statuses appear

### Test Grant Tracking
1. Go to Matches tab → click "Track" on a funder
2. Verify it appears in Tracker tab with "Researching" status
3. Change status via dropdown → verify it updates
4. Add an external grant via "Add Grant" button

### Test Tasks
1. Open a tracked grant detail → add a task
2. Go to /tasks → verify task appears grouped correctly
3. Toggle task completion

### Test CSV Import/Export
1. In Tracker tab, click "Export CSV" → verify CSV downloads
2. Click "Import CSV" → upload the exported CSV → verify column mapping

### Test Portfolio
1. Go to /portfolio → verify metrics cards populate
2. Verify grants table shows entries from all projects

### Test Settings
1. Go to /settings → Notifications tab
2. Toggle email notifications and deadline reminders
3. Go to Calendar tab → create a new feed → copy URL

### Test Data Migration
1. Any previously saved funders should appear in the Tracker tab
2. Old statuses (researching/applied/awarded/passed) should map to new pipeline statuses

## Optional: Enable SendGrid for Email Notifications

```bash
supabase secrets set SENDGRID_API_KEY=your_api_key_here
```

Without this, notifications will log to console instead of sending email.

## Optional: Enable pg_cron for Scheduled Notifications

In the Supabase dashboard, go to Database → Extensions → enable `pg_cron`, then:

```sql
SELECT cron.schedule(
  'process-notifications',
  '0 8 * * *',  -- Daily at 8 AM UTC
  $$SELECT net.http_post(
    'https://tgtotjvdubhjxzybmdex.supabase.co/functions/v1/process-notifications',
    '{"action": "all"}'::jsonb,
    '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
    )
  )$$
);
```

## New Files Summary

### Migrations (8)
- `20260315010000` through `20260315010007`

### Edge Functions (6)
- `tracked-grants` — CRUD for tracked grants + CSV import/export
- `pipeline-statuses` — Manage pipeline status configurations
- `portfolio` — Cross-project portfolio metrics and grants
- `grant-tasks` — Task CRUD with grouping by urgency
- `calendar-feed` — .ics feed generation
- `process-notifications` — Email notification queue processing

### Frontend Pages (modified/new)
- `ProjectWorkspace.tsx` — Complete rewrite for tracked grants
- `PortfolioPage.tsx` — New cross-project portfolio view
- `MyTasksPage.tsx` — New unified tasks view
- `UserSettingsPage.tsx` — Added Notifications + Calendar tabs
- `NavBar.tsx` — Added Portfolio + Tasks links
- `App.tsx` — Added /portfolio and /tasks routes
- `types.ts` — Added Phase 3 TypeScript interfaces
