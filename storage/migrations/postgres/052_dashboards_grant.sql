-- ============================================================
-- Fix permissions on the dashboards table for systems where
-- 051_dashboards.sql was applied as a role other than anthrimon
-- (e.g. postgres), leaving the app user without access.
-- ============================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON dashboards TO anthrimon;
