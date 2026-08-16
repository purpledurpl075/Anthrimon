-- devices.polling_interval_s defaulted to 300s at the DB level (001_init.sql)
-- while the create-device API schema and the alert engine's own fallback both
-- already assumed 15s -- three places disagreeing on "the" default, with 300
-- being the outlier no code path actually exercised in practice. Align the
-- column default with the value everything else already uses. Existing rows
-- are untouched; this only changes what a future bare INSERT would get.
ALTER TABLE devices ALTER COLUMN polling_interval_s SET DEFAULT 15;
