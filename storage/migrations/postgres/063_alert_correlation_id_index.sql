-- Alert.correlation_id is revived (was declared but never read/written) as
-- the grouping key for the mass-simultaneous-failure heuristic: N
-- topologically-unrelated device_down alerts that first-fire within the
-- same short window get tagged with a shared correlation_id.
CREATE INDEX IF NOT EXISTS idx_alerts_correlation_id
    ON alerts(correlation_id) WHERE correlation_id IS NOT NULL;
