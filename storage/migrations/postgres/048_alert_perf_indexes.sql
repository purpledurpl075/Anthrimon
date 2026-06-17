-- Performance indexes for the alert engine's per-rule / per-cycle queries.
--
-- The engine runs these every ~15s in alerting/engine.py:
--   1. escalation:    WHERE rule_id = ? AND status = 'open'      AND severity = ? AND triggered_at >= ?
--   2. auto-resolve:  WHERE rule_id = ? AND status IN ('open','acknowledged') AND triggered_at >= ?
--   3. dedup lookup:  WHERE fingerprint = ? AND status IN ('open','acknowledged','suppressed')
--   4. retro-suppr.:  WHERE fingerprint = ? AND status = 'resolved' ORDER BY resolved_at DESC LIMIT 1
--
-- Before this, only idx_alerts_fingerprint_open (partial, status='open') existed,
-- so queries (1)-(4) fell back to idx_alerts_status / idx_alerts_triggered_at and
-- scanned far more rows than necessary as alert volume grows.

-- Covers (1) and (2): rule_id + status equality/IN, with triggered_at available for the range.
CREATE INDEX IF NOT EXISTS idx_alerts_rule_status
    ON alerts(rule_id, status, triggered_at DESC);

-- Covers (3) the multi-status fingerprint dedup lookup and (4) the resolved
-- most-recent lookup (fingerprint + status='resolved' ordered by resolved_at).
CREATE INDEX IF NOT EXISTS idx_alerts_fingerprint_status
    ON alerts(fingerprint, status, resolved_at DESC);

-- The old partial index is now a strict subset of idx_alerts_fingerprint_status.
DROP INDEX IF EXISTS idx_alerts_fingerprint_open;
