-- ============================================================
-- ADVANCED REPORTS — additional report types
-- Widens report_type from {capacity, sla, inventory} to add:
--   compliance, alert_summary, config_changes, flow_top_talkers,
--   interface_health, bgp_health, syslog_security
-- ============================================================

ALTER TABLE scheduled_reports DROP CONSTRAINT scheduled_reports_report_type_check;
ALTER TABLE scheduled_reports ADD CONSTRAINT scheduled_reports_report_type_check
    CHECK (report_type IN (
        'capacity', 'sla', 'inventory',
        'compliance', 'alert_summary', 'config_changes',
        'flow_top_talkers', 'interface_health', 'bgp_health', 'syslog_security'
    ));

ALTER TABLE report_runs DROP CONSTRAINT report_runs_report_type_check;
ALTER TABLE report_runs ADD CONSTRAINT report_runs_report_type_check
    CHECK (report_type IN (
        'capacity', 'sla', 'inventory',
        'compliance', 'alert_summary', 'config_changes',
        'flow_top_talkers', 'interface_health', 'bgp_health', 'syslog_security'
    ));
