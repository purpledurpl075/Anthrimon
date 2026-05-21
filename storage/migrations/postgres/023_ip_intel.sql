-- IP intelligence cache: GeoIP + AbuseIPDB results per IP address

CREATE TABLE ip_intel (
    ip               INET        PRIMARY KEY,
    is_private       BOOLEAN     NOT NULL DEFAULT false,
    -- GeoIP (ip-api.com)
    country_iso      CHAR(2),
    country_name     TEXT,
    asn              BIGINT,
    asn_org          TEXT,
    city             TEXT,
    geo_checked_at   TIMESTAMPTZ,
    -- AbuseIPDB
    abuse_score      SMALLINT,           -- 0–100 confidence score
    abuse_reports    INT,
    abuse_isp        TEXT,
    abuse_domain     TEXT,
    abuse_checked_at TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ip_intel_abuse   ON ip_intel(abuse_score DESC) WHERE abuse_score IS NOT NULL;
CREATE INDEX idx_ip_intel_country ON ip_intel(country_iso)       WHERE country_iso IS NOT NULL;
