ALTER TABLE remote_collectors
    ADD COLUMN state_interval_s   INTEGER,
    ADD COLUMN counter_interval_s INTEGER;

COMMENT ON COLUMN remote_collectors.state_interval_s   IS 'Fast-path state poll interval in seconds (BGP/OSPF/ISIS). NULL = platform default (15s).';
COMMENT ON COLUMN remote_collectors.counter_interval_s IS 'Slow-path counter/topology poll interval in seconds. NULL = platform default (60s).';
