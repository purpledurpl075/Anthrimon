-- ============================================================
-- ADVANCED REPORTS — bundled multi-type report packs (feature 4)
-- Widens report_type to add 'bundle' — a synthetic type whose filters carry
-- a report_types: list[str] sub-list of the other 10 real types.
-- ============================================================

ALTER TABLE scheduled_reports DROP CONSTRAINT scheduled_reports_report_type_check;
ALTER TABLE scheduled_reports ADD CONSTRAINT scheduled_reports_report_type_check
    CHECK (report_type IN (
        'capacity', 'sla', 'inventory',
        'compliance', 'alert_summary', 'config_changes',
        'flow_top_talkers', 'interface_health', 'bgp_health', 'syslog_security',
        'bundle'
    ));

ALTER TABLE report_runs DROP CONSTRAINT report_runs_report_type_check;
ALTER TABLE report_runs ADD CONSTRAINT report_runs_report_type_check
    CHECK (report_type IN (
        'capacity', 'sla', 'inventory',
        'compliance', 'alert_summary', 'config_changes',
        'flow_top_talkers', 'interface_health', 'bgp_health', 'syslog_security',
        'bundle'
    ));
