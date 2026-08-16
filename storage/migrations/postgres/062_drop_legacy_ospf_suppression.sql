-- The legacy per-rule OSPF-neighbor suppression mechanism
-- (suppress_if_parent_down / parent_device_id) is retired: the dashboard
-- never rendered a parent_device_id picker, so it was a dead no-op for
-- every rule created through the UI. Superseded generally by the
-- automatic Tier-1 SuppressionMap (own-device + topology cascade) and
-- Tier-2 peer-alert correlation.
ALTER TABLE alert_rules DROP COLUMN IF EXISTS suppress_if_parent_down;
ALTER TABLE alert_rules DROP COLUMN IF EXISTS parent_device_id;
