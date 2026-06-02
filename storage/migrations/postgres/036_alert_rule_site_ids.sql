-- 036_alert_rule_site_ids.sql
-- Alert rules and policies can target a specific set of sites.
-- NULL / empty array means tenant-wide (all sites), preserving existing behaviour.
-- The alerting engine selects devices whose site_id is in this array when non-null.

ALTER TABLE alert_rules
    ADD COLUMN IF NOT EXISTS site_ids UUID[] DEFAULT NULL;

ALTER TABLE alert_policies
    ADD COLUMN IF NOT EXISTS site_ids UUID[] DEFAULT NULL;

-- GIN index for fast ANY(site_ids) look-ups in the evaluator
CREATE INDEX IF NOT EXISTS idx_alert_rules_site_ids    ON alert_rules    USING gin(site_ids) WHERE site_ids IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_alert_policies_site_ids ON alert_policies USING gin(site_ids) WHERE site_ids IS NOT NULL;
