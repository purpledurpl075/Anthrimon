-- Enable trigram extension for fuzzy/ILIKE search with GIN indexes.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Devices
CREATE INDEX IF NOT EXISTS idx_trgm_devices_hostname    ON devices    USING gin(hostname              gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_trgm_devices_mgmt_ip     ON devices    USING gin(CAST(mgmt_ip AS text) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_trgm_devices_fqdn        ON devices    USING gin(fqdn                  gin_trgm_ops);

-- Interfaces
CREATE INDEX IF NOT EXISTS idx_trgm_ifaces_name         ON interfaces USING gin(name                  gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_trgm_ifaces_description  ON interfaces USING gin(description            gin_trgm_ops);

-- Alerts
CREATE INDEX IF NOT EXISTS idx_trgm_alerts_title        ON alerts     USING gin(title                  gin_trgm_ops);

-- BGP
CREATE INDEX IF NOT EXISTS idx_trgm_bgp_peer_ip         ON bgp_sessions USING gin(CAST(peer_ip AS text) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_trgm_bgp_peer_desc       ON bgp_sessions USING gin(peer_description       gin_trgm_ops);
