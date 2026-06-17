-- 050_isis_link_details_and_lsp.sql
-- Per-adjacency IS-IS link details (isisCircLevelTable) and LSP database
-- (isisLSPSummaryTable), both from ISIS-MIB (RFC 4444).

-- ============================================================
-- IS-IS CIRCUIT LEVELS
-- Per-circuit, per-level link parameters: metric, hello/hold timers,
-- DIS election priority and the currently elected LAN-DIS.
-- Sourced from isisCircLevelTable.
-- ============================================================
CREATE TABLE isis_circuit_levels (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id       UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    instance        TEXT        NOT NULL DEFAULT 'default',
    interface_name  TEXT        NOT NULL,
    level           TEXT        NOT NULL,   -- level-1 | level-2
    metric          INT,
    hello_interval  INT,        -- seconds
    hold_timer      INT,        -- seconds (hello_interval * hello_multiplier)
    priority        INT,
    dis_id          TEXT,       -- LAN-DIS system ID, NULL if no DIS elected
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (device_id, instance, interface_name, level)
);

CREATE INDEX idx_isis_circuit_levels_device ON isis_circuit_levels(device_id);

CREATE TRIGGER trg_isis_circuit_levels_updated_at
    BEFORE UPDATE ON isis_circuit_levels
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- IS-IS LSP DATABASE
-- One row per LSP held in a device's link-state database.
-- Sourced from isisLSPSummaryTable.
-- ============================================================
CREATE TABLE isis_lsps (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id          UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    instance           TEXT        NOT NULL DEFAULT 'default',
    level              TEXT        NOT NULL,   -- level-1 | level-2
    lsp_id             TEXT        NOT NULL,   -- e.g. "0100.1001.0001.00-00"
    sequence_number    BIGINT,
    checksum           INT,
    remaining_lifetime INT,        -- seconds
    pdu_length         INT,
    overload_bit       BOOLEAN     NOT NULL DEFAULT false,
    attached_bit       BOOLEAN     NOT NULL DEFAULT false,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (device_id, instance, level, lsp_id)
);

CREATE INDEX idx_isis_lsps_device ON isis_lsps(device_id);

CREATE TRIGGER trg_isis_lsps_updated_at
    BEFORE UPDATE ON isis_lsps
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
