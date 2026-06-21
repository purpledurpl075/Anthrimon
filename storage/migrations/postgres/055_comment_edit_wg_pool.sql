-- 055: Alert comment editing + WireGuard pool expansion
--
-- 1. Add updated_at to alert_comments so edits are tracked
-- 2. Expand wg_ip_pool from .2-.51 to .2-.254

ALTER TABLE alert_comments
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- Expand the WireGuard pool from 50 addresses to 253 (.2 through .254)
INSERT INTO wg_ip_pool (ip)
SELECT ('10.100.0.' || generate_series(52, 254))::INET
ON CONFLICT DO NOTHING;
