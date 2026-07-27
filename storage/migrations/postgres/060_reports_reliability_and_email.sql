-- ============================================================
-- ADVANCED REPORTS — reliability + per-schedule email customization
-- Adds:
--   scheduled_reports.email_subject / email_note   (feature 8: custom
--     subject/intro note when a schedule's report is emailed)
--   scheduled_reports.consecutive_failures / last_failure_notified_at
--     (feature 6: scheduler retry + notify-after-N-consecutive-failures)
-- No new GRANT needed — the existing table-level GRANT from 058_reports.sql
-- already covers new columns.
-- ============================================================

ALTER TABLE scheduled_reports ADD COLUMN email_subject TEXT;
ALTER TABLE scheduled_reports ADD COLUMN email_note TEXT;
ALTER TABLE scheduled_reports ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduled_reports ADD COLUMN last_failure_notified_at TIMESTAMPTZ;
