-- 056: Sync Postgres ENUMs with ORM model definitions
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block,
-- so this file must be run with psql (which auto-commits each statement).

-- device_type: add 'access_point' (used by ORM for wireless APs)
ALTER TYPE device_type ADD VALUE IF NOT EXISTS 'access_point';

-- device_status: add 'degraded' (used by ORM for partially-degraded devices)
ALTER TYPE device_status ADD VALUE IF NOT EXISTS 'degraded';

-- collection_method: add 'netconf' and 'syslog' (used by ORM)
ALTER TYPE collection_method ADD VALUE IF NOT EXISTS 'netconf';
ALTER TYPE collection_method ADD VALUE IF NOT EXISTS 'syslog';
