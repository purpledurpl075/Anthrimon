-- notification_send_log: per-channel send history with retry count and error capture.
CREATE TABLE notification_send_log (
    id          BIGSERIAL PRIMARY KEY,
    channel_id  UUID        NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
    tenant_id   UUID        NOT NULL REFERENCES tenants(id),
    alert_id    UUID        REFERENCES alerts(id) ON DELETE SET NULL,
    event       TEXT        NOT NULL,   -- 'alert.fired' | 'alert.resolved' | 'test'
    status      TEXT        NOT NULL,   -- 'success' | 'failure'
    error       TEXT,
    attempts    SMALLINT    NOT NULL DEFAULT 1,
    sent_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notif_send_log_channel ON notification_send_log(channel_id, sent_at DESC);
CREATE INDEX idx_notif_send_log_tenant  ON notification_send_log(tenant_id,  sent_at DESC);
