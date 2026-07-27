"""CSV rendering for each report type. Mirrors the io.StringIO + csv.writer
pattern already used by routers/alerts.py's export_alerts_csv."""
from __future__ import annotations

import csv
import io


def capacity_report_csv(data: dict) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Site", "Device", "Avg CPU %", "Avg Inbound (bps)", "Peak Inbound (bps)"])
    for d in data["devices"]:
        w.writerow([
            d["site"], d["hostname"],
            f'{d["avg_cpu_pct"]:.2f}' if d["avg_cpu_pct"] is not None else "",
            f'{d["avg_in_bps"]:.0f}' if d["avg_in_bps"] is not None else "",
            f'{d["peak_in_bps"]:.0f}' if d["peak_in_bps"] is not None else "",
        ])
    return buf.getvalue()


def sla_report_csv(data: dict) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Site", "Device", "Downtime (seconds)", "Uptime %"])
    for d in data["devices"]:
        w.writerow([d["site"], d["hostname"], f'{d["downtime_seconds"]:.0f}', f'{d["uptime_pct"]:.3f}'])
    return buf.getvalue()


def inventory_report_csv(data: dict) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Site", "Hostname", "FQDN", "Mgmt IP", "Vendor", "Type",
                "Platform", "OS Version", "Serial", "Status"])
    for d in data["devices"]:
        w.writerow([
            d["site"], d["hostname"], d["fqdn"] or "", d["mgmt_ip"], d["vendor"], d["device_type"],
            d["platform"] or "", d["os_version"] or "", d["serial_number"] or "", d["status"],
        ])
    return buf.getvalue()


def compliance_report_csv(data: dict) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Policy", "Severity", "Device", "Status", "Findings", "Checked At"])
    for r in data["results"]:
        w.writerow([r["policy"], r["severity"], r["device"], r["status"], r["finding_count"], r["checked_at"]])
    return buf.getvalue()


def alert_summary_report_csv(data: dict) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Severity", "Alert Count", "MTTA (seconds)", "MTTR (seconds)"])
    for s in data["by_severity"]:
        w.writerow([s["severity"], s["alert_count"],
                    f'{s["mtta_seconds"]:.0f}' if s["mtta_seconds"] is not None else "",
                    f'{s["mttr_seconds"]:.0f}' if s["mttr_seconds"] is not None else ""])
    w.writerow([])
    w.writerow(["Top Devices", "Alert Count"])
    for d in data["top_devices"]:
        w.writerow([d["hostname"], d["alert_count"]])
    return buf.getvalue()


def config_changes_report_csv(data: dict) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Device", "Collected At", "Lines Added", "Lines Removed", "Changed By"])
    for c in data["changes"]:
        w.writerow([c["hostname"], c["collected_at"], c["lines_added"], c["lines_removed"], c["changed_by"]])
    return buf.getvalue()


def flow_top_talkers_report_csv(data: dict) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Source IP", "Destination IP", "Protocol", "Bytes", "Packets"])
    for t in data["talkers"]:
        w.writerow([t["src_ip"], t["dst_ip"], t["protocol"], t["bytes_total"], t["packets_total"]])
    return buf.getvalue()


def interface_health_report_csv(data: dict) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Device", "In Errors", "Out Errors", "In Discards", "Out Discards", "Flap Count"])
    for d in data["devices"]:
        w.writerow([d["hostname"], d["in_errors"], d["out_errors"], d["in_discards"], d["out_discards"], d["flap_count"]])
    return buf.getvalue()


def bgp_health_report_csv(data: dict) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Device", "Peer IP", "Peer ASN", "State", "Prefixes Rx", "Prefixes Tx",
                "Flap Count (all-time)", "State Changes (window)"])
    for s in data["sessions"]:
        w.writerow([s["hostname"], s["peer_ip"], s["peer_asn"] or "", s["session_state"],
                    s["prefixes_received"], s["prefixes_advertised"], s["flap_count"], s["state_changes_in_window"]])
    return buf.getvalue()


def syslog_security_report_csv(data: dict) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Severity", "Count"])
    for s in data["by_severity"]:
        w.writerow([s["severity_name"], s["count"]])
    w.writerow([])
    w.writerow(["Matched Rule", "Pattern", "Match Count"])
    for r in data["matched_rules"]:
        w.writerow([r["rule_name"], r["pattern"], r["match_count"]])
    return buf.getvalue()


def bundle_report_csv(data: dict) -> str:
    """Concatenates each section's own CSV export with a separator line —
    cheaper than the PDF fragment-template split since CSV has no shared
    header/footer chrome to reconcile."""
    parts = []
    for section in data.get("sections", []):
        parts.append(f"=== {section['title']} ===")
        parts.append(REPORT_CSV_FUNCS[section["type"]](section["data"]))
    return "\n".join(parts)


REPORT_CSV_FUNCS = {
    "capacity": capacity_report_csv,
    "sla": sla_report_csv,
    "inventory": inventory_report_csv,
    "compliance": compliance_report_csv,
    "alert_summary": alert_summary_report_csv,
    "config_changes": config_changes_report_csv,
    "flow_top_talkers": flow_top_talkers_report_csv,
    "interface_health": interface_health_report_csv,
    "bgp_health": bgp_health_report_csv,
    "syslog_security": syslog_security_report_csv,
    "bundle": bundle_report_csv,
}
