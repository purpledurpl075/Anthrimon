-- 035_site_id_columns.sql
-- Add optional site_id to objects that can be scoped to a specific site.
-- NULL means tenant-wide (current default behaviour is preserved).
-- ON DELETE SET NULL: deleting a site does not delete these objects; they
-- become tenant-wide again.

ALTER TABLE credentials
    ADD COLUMN IF NOT EXISTS site_id UUID REFERENCES sites(id) ON DELETE SET NULL;

ALTER TABLE notification_channels
    ADD COLUMN IF NOT EXISTS site_id UUID REFERENCES sites(id) ON DELETE SET NULL;

ALTER TABLE maintenance_windows
    ADD COLUMN IF NOT EXISTS site_id UUID REFERENCES sites(id) ON DELETE SET NULL;

ALTER TABLE compliance_policies
    ADD COLUMN IF NOT EXISTS site_id UUID REFERENCES sites(id) ON DELETE SET NULL;

-- Indexes for common filter pattern: WHERE tenant_id = ? AND (site_id = ? OR site_id IS NULL)
CREATE INDEX IF NOT EXISTS idx_credentials_site         ON credentials(site_id)           WHERE site_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notif_channels_site      ON notification_channels(site_id)  WHERE site_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_maint_windows_site       ON maintenance_windows(site_id)    WHERE site_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_compliance_policies_site ON compliance_policies(site_id)    WHERE site_id IS NOT NULL;
