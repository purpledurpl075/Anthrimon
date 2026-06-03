-- Stores decoded SNMP trap events received from devices, forwarded by either
-- the hub-local trap receiver or a remote collector's trap listener.

CREATE TABLE IF NOT EXISTS trap_events (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id       UUID        REFERENCES devices(id) ON DELETE SET NULL,
    source_ip       INET        NOT NULL,
    trap_type       TEXT        NOT NULL,   -- 'linkDown', 'coldStart', etc.
    oid             TEXT        NOT NULL,   -- snmpTrapOID value
    severity        TEXT        NOT NULL DEFAULT 'info'
                                CHECK (severity IN ('critical','warning','info')),
    varbinds        JSONB       NOT NULL DEFAULT '[]',
    snmp_version    TEXT        NOT NULL DEFAULT 'v2c',
    collector_id    UUID        REFERENCES remote_collectors(id) ON DELETE SET NULL,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trap_events_device_id   ON trap_events(device_id);
CREATE INDEX IF NOT EXISTS idx_trap_events_received_at ON trap_events(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_trap_events_trap_type   ON trap_events(trap_type);

-- Purge events older than 30 days (enforced by a background job / cron).
COMMENT ON TABLE trap_events IS
    'Raw decoded SNMP trap events.  Retention: 30 days.  '
    'device_id is NULL when the source IP does not match any known device.';
