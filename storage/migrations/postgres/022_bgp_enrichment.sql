-- BGP enrichment: flap counter, extra fields, session event log

-- New columns on bgp_sessions
ALTER TABLE bgp_sessions
    ADD COLUMN IF NOT EXISTS peer_router_id  TEXT,
    ADD COLUMN IF NOT EXISTS admin_status    TEXT     NOT NULL DEFAULT 'start',
    ADD COLUMN IF NOT EXISTS in_updates      BIGINT   NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS out_updates     BIGINT   NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS flap_count      INT      NOT NULL DEFAULT 0;

-- Session event log — one row per state transition
CREATE TABLE IF NOT EXISTS bgp_session_events (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  UUID        NOT NULL REFERENCES bgp_sessions(id) ON DELETE CASCADE,
    device_id   UUID        NOT NULL REFERENCES devices(id)      ON DELETE CASCADE,
    peer_ip     INET        NOT NULL,
    prev_state  TEXT        NOT NULL,
    new_state   TEXT        NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bgp_events_session ON bgp_session_events(session_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_bgp_events_device  ON bgp_session_events(device_id,  recorded_at DESC);
