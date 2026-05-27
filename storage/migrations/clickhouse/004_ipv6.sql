-- 004_ipv6.sql
-- Add proper dual-stack (IPv4 + IPv6) support to flow aggregates.
--
-- flow_records already has src_ip6/dst_ip6 IPv6 columns, but the ingest
-- code was writing all addresses into src_ip/dst_ip (IPv4), causing
-- ClickHouse to reject IPv6 link-local and global addresses.
--
-- Changes:
--   1. Recreate mv_flow_agg_1min to ONLY aggregate IPv4 flows
--      (src_ip6 = '::').  IPv6-only flows no longer pollute the IPv4
--      aggregate as 0.0.0.0 → 0.0.0.0 noise.
--   2. Add flow_agg6_1min  — SummingMergeTree keyed on IPv6 src/dst.
--   3. Add mv_flow_agg6_1min — feeds flow_agg6_1min from IPv6 flows.

-- ============================================================
-- 1.  Rebuild the IPv4 materialized view (IPv4 flows only)
-- ============================================================
DROP VIEW IF EXISTS mv_flow_agg_1min;

CREATE MATERIALIZED VIEW mv_flow_agg_1min
TO flow_agg_1min AS
SELECT
    toStartOfMinute(flow_start)     AS minute,
    collector_device_id,
    src_ip,
    dst_ip,
    ip_protocol,
    src_asn,
    dst_asn,
    sum(bytes)                      AS bytes_total,
    sum(packets)                    AS packets_total,
    count()                         AS flow_count
FROM flow_records
WHERE src_ip6 = '::'
GROUP BY minute, collector_device_id, src_ip, dst_ip, ip_protocol, src_asn, dst_asn;


-- ============================================================
-- 2.  1-minute IPv6 aggregate table
-- ============================================================
CREATE TABLE IF NOT EXISTS flow_agg6_1min (
    minute              DateTime,
    collector_device_id UUID,
    src_ip6             IPv6,
    dst_ip6             IPv6,
    ip_protocol         UInt8,
    src_asn             UInt32,
    dst_asn             UInt32,
    bytes_total         UInt64,
    packets_total       UInt64,
    flow_count          UInt64
)
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(minute)
ORDER BY (collector_device_id, minute, src_ip6, dst_ip6, ip_protocol)
TTL minute + INTERVAL 1 YEAR
SETTINGS index_granularity = 8192;


-- ============================================================
-- 3.  IPv6 aggregate materialized view
-- ============================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_flow_agg6_1min
TO flow_agg6_1min AS
SELECT
    toStartOfMinute(flow_start)     AS minute,
    collector_device_id,
    src_ip6,
    dst_ip6,
    ip_protocol,
    src_asn,
    dst_asn,
    sum(bytes)                      AS bytes_total,
    sum(packets)                    AS packets_total,
    count()                         AS flow_count
FROM flow_records
WHERE src_ip6 != '::'
GROUP BY minute, collector_device_id, src_ip6, dst_ip6, ip_protocol, src_asn, dst_asn;
