-- Indices to support Traps tab filtering/search (severity filter, trap-type
-- search, OID search, varbind text search). pg_trgm already enabled by
-- 030_search_indexes.sql.

CREATE INDEX IF NOT EXISTS idx_trap_events_severity       ON trap_events(severity);
CREATE INDEX IF NOT EXISTS idx_trgm_trap_events_trap_type ON trap_events USING gin(trap_type        gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_trgm_trap_events_oid       ON trap_events USING gin(oid              gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_trgm_trap_events_varbinds  ON trap_events USING gin((varbinds::text) gin_trgm_ops);
