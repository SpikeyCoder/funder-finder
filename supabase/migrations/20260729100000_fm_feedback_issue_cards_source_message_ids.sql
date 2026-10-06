-- FM-2026-07-29-06: reconcile fm_feedback.issue_cards.source_message_ids.
-- ─────────────────────────────────────────────────────────────────────────────
-- Found while recovering the source for 20260613223429 (fm_feedback_state), which
-- had been applied ad-hoc with no repo file. Recovering that migration's SQL from
-- the ledger and diffing it against live schema showed the tables and indexes
-- matched — except `fm_feedback.issue_cards` carries one extra column:
--
--   source_message_ids  text[]  nullable, no default
--
-- 20260613223429 never created it, and NO ledger entry contains SQL that adds it.
-- So it was added by a change that left no trace at all — not even the executed
-- statements that ad-hoc migrations normally record. Presumably a direct DDL
-- statement run against the database.
--
-- This migration carries the column forward so the migration chain actually
-- reproduces production. It is a no-op against the live database (the column is
-- already there) and is what creates the column on any rebuilt environment.
--
-- Deliberately NOT folded into 20260613223429: that file is a verbatim record of
-- what ran on 2026-06-13, and editing it would misrepresent history. The column
-- appeared later; it is reconciled later.
--
-- Type recovered from the live catalogue rather than guessed —
-- format_type() reports text[], attnotnull false, no default expression.
-- ─────────────────────────────────────────────────────────────────────────────

alter table fm_feedback.issue_cards
  add column if not exists source_message_ids text[];

comment on column fm_feedback.issue_cards.source_message_ids is
  'Message ids that were deduplicated into this card. Reconciled into migrations by FM-2026-07-29-06; originally added out-of-band with no ledger record.';
