-- RECOVERED 2026-07-29 (FM-2026-07-29-06) from supabase_migrations.schema_migrations.
--
-- This migration was applied to production on 2026-06-13 with NO source in this
-- repo — it was applied ad-hoc (dashboard / MCP), which records the executed SQL
-- in the ledger's `statements` column but writes no file. Body below is that
-- recorded SQL verbatim; only this header was added.
--
-- Do NOT re-apply: it is already applied and recorded under version
-- 20260613223429. Everything here is `if not exists`-guarded anyway.
--
-- Verified against live schema on recovery: schema `fm_feedback` exists, both
-- tables exist, and both indexes exist.
--
-- IMPORTANT — this file alone no longer reproduces production. The live
-- `fm_feedback.issue_cards` also has a `source_message_ids text[]` column that
-- this migration never created; it was added later by another untracked change
-- whose SQL is not in the ledger at all. That column is reconciled forward in
-- 20260729100000, so the chain as a whole is correct. Do not "fix" it by editing
-- this file — that would misrepresent what actually ran on 2026-06-13.
--
-- Access posture (checked, no change made): the `fm_feedback` schema is not
-- exposed to PostgREST, and neither `anon` nor `authenticated` holds USAGE on it
-- or SELECT on its tables. RLS is therefore off on both tables without exposing
-- anything — the same posture as the `private` schema. Note the data includes
-- feedback-email senders and subjects, so that isolation is load-bearing.

create schema if not exists fm_feedback;

create table if not exists fm_feedback.processed_emails (
  message_id   text primary key,
  thread_id    text,
  subject      text,
  sender       text,
  email_date   timestamptz,
  status       text not null,
  n_issues     int  not null default 0,
  processed_at timestamptz not null default now()
);

create table if not exists fm_feedback.issue_cards (
  fingerprint   text primary key,
  card_id       text not null,
  card_url      text,
  message_id    text references fm_feedback.processed_emails(message_id),
  title         text,
  affected_page text,
  category      text,
  priority      text,
  created_at    timestamptz not null default now()
);

create index if not exists idx_fm_issue_cards_page on fm_feedback.issue_cards(affected_page);
create index if not exists idx_fm_issue_cards_msg  on fm_feedback.issue_cards(message_id);
