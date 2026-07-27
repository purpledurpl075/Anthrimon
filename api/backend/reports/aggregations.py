"""Data aggregation for each Advanced Reports report type. Pure data-gathering
— no rendering. Consumed by both the on-demand /reports/run endpoint and the
scheduler, and by the PDF/CSV renderers.
"""
from __future__ import annotations

import uuid
from datetime import datetime

import httpx
import structlog
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from .filters import normalize_range
from ..models.device import Device
from ..models.site import Site
from ..services.urls import ch_url, vm_url

logger = structlog.get_logger(__name__)


async def _vm_instant(query: str, at: datetime | None = None) -> float | None:
    try:
        params = {"query": query}
        if at is not None:
            params["time"] = str(int(at.timestamp()))
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{vm_url()}/api/v1/query", params=params)
            r.raise_for_status()
            result = r.json().get("data", {}).get("result", [])
            if result and result[0].get("value"):
                return float(result[0]["value"][1])
    except Exception as exc:
        logger.warning("reports_vm_query_failed", query=query, error=str(exc))
    return None


async def _ch_query(query: str) -> list[dict]:
    """Run a ClickHouse SQL query and return rows as dicts. Mirrors
    routers/admin.py's _ch_admin() — same wire format (raw SQL + FORMAT JSON)."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(ch_url(), content=" ".join(query.split()) + " FORMAT JSON",
                                     headers={"Content-Type": "text/plain"})
        resp.raise_for_status()
        return resp.json().get("data", [])
    except Exception as exc:
        logger.warning("reports_ch_query_failed", error=str(exc))
        return []


async def _ch_query_params(query: str, ch_params: dict) -> list[dict]:
    """Parameterized ClickHouse query ({name:Type} placeholders bound via
    param_<name> query-string args) — mirrors alerting/evaluators.py's
    eval_syslog_match(). Use this instead of _ch_query() whenever any part
    of the query is not a validated UUID/int (e.g. an admin-authored regex)."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(ch_url(), params=ch_params,
                                     content=" ".join(query.split()) + " FORMAT JSON",
                                     headers={"Content-Type": "text/plain"})
        resp.raise_for_status()
        return resp.json().get("data", [])
    except Exception as exc:
        logger.warning("reports_ch_query_failed", error=str(exc))
        return []


async def _tenant_device_ids_str(db: AsyncSession, tenant_id: uuid.UUID, site_id: str | None = None) -> list[str]:
    """Device IDs for this tenant (optionally scoped to one site), as strings
    — for ClickHouse IN(...) clauses (ClickHouse has no notion of a Postgres
    tenant_id/site_id join)."""
    q = select(Device.id).where(Device.tenant_id == tenant_id, Device.is_active == True)  # noqa: E712
    if site_id:
        q = q.where(Device.site_id == site_id)
    ids = (await db.execute(q)).scalars().all()
    return [str(i) for i in ids]


async def capacity_report_data(
    db: AsyncSession, tenant_id: uuid.UUID, filters: dict,
) -> dict:
    """Capacity & utilisation trends across sites — avg/peak interface
    utilisation per device over the report window (default 30d)."""
    start, end, days = normalize_range(filters, "capacity")
    site_id = filters.get("site_id")
    window = f"{days}d"

    q = (
        select(Device, Site.name)
        .join(Site, Site.id == Device.site_id, isouter=True)
        .where(Device.tenant_id == tenant_id, Device.is_active == True)  # noqa: E712
    )
    if site_id:
        q = q.where(Device.site_id == site_id)
    q = q.order_by(Site.name.nullslast(), Device.hostname)
    devices = (await db.execute(q)).all()

    rows = []
    for dev, site_name in devices:
        did = str(dev.id)
        avg_in = await _vm_instant(
            f'avg(avg_over_time(rate(anthrimon_if_in_octets_total{{device_id="{did}"}}[5m])[{window}:5m]))*8', at=end,
        )
        peak_in = await _vm_instant(
            f'max(max_over_time(rate(anthrimon_if_in_octets_total{{device_id="{did}"}}[5m])[{window}:5m]))*8', at=end,
        )
        cpu_avg = await _vm_instant(
            f'avg_over_time(anthrimon_device_cpu_util_pct{{device_id="{did}"}}[{window}])', at=end,
        )
        rows.append({
            "device_id": did,
            "hostname": dev.hostname,
            "site": site_name or "Unassigned",
            "avg_in_bps": avg_in,
            "peak_in_bps": peak_in,
            "avg_cpu_pct": cpu_avg,
        })

    return {
        "window": window, "window_days": days,
        "period_start": start.isoformat(), "period_end": end.isoformat(),
        "devices": rows,
    }


async def sla_report_data(
    db: AsyncSession, tenant_id: uuid.UUID, filters: dict,
) -> dict:
    """SLA / uptime summaries — per-device downtime from device_down alert
    history over the report window (default 30d)."""
    start, end, days = normalize_range(filters, "sla")
    site_id = filters.get("site_id")
    period_start = start.timestamp()
    period_end = end.timestamp()

    q = (
        select(Device.id, Device.hostname, Site.name)
        .join(Site, Site.id == Device.site_id, isouter=True)
        .where(Device.tenant_id == tenant_id, Device.is_active == True)  # noqa: E712
    )
    if site_id:
        q = q.where(Device.site_id == site_id)
    devices = (await db.execute(q)).all()

    downtime_rows = (await db.execute(text("""
        SELECT a.device_id,
               EXTRACT(EPOCH FROM (
                   LEAST(COALESCE(a.resolved_at, TO_TIMESTAMP(:period_end)), TO_TIMESTAMP(:period_end))
                   - GREATEST(a.triggered_at, TO_TIMESTAMP(:period_start))
               )) AS downtime_seconds
          FROM alerts a
          JOIN alert_rules ar ON ar.id = a.rule_id
         WHERE a.tenant_id = CAST(:tid AS uuid)
           AND ar.metric = 'device_down'
           AND a.device_id IS NOT NULL
           AND COALESCE(a.resolved_at, TO_TIMESTAMP(:period_end)) >= TO_TIMESTAMP(:period_start)
           AND a.triggered_at <= TO_TIMESTAMP(:period_end)
    """), {"tid": str(tenant_id), "period_start": period_start, "period_end": period_end})).fetchall()

    downtime_by_device: dict[str, float] = {}
    for r in downtime_rows:
        seconds = max(0.0, float(r.downtime_seconds))
        downtime_by_device[str(r.device_id)] = downtime_by_device.get(str(r.device_id), 0.0) + seconds

    period_seconds = period_end - period_start
    rows = []
    for did, hostname, site_name in devices:
        down_s = downtime_by_device.get(str(did), 0.0)
        uptime_pct = max(0.0, min(100.0, (1 - down_s / period_seconds) * 100)) if period_seconds > 0 else 100.0
        rows.append({
            "device_id": str(did),
            "hostname": hostname,
            "site": site_name or "Unassigned",
            "downtime_seconds": down_s,
            "uptime_pct": round(uptime_pct, 3),
        })

    rows.sort(key=lambda r: r["uptime_pct"])
    return {
        "window_days": days,
        "period_start": start.isoformat(), "period_end": end.isoformat(),
        "devices": rows,
    }


async def inventory_report_data(
    db: AsyncSession, tenant_id: uuid.UUID, filters: dict,
) -> dict:
    """Device/interface inventory listing. No time dimension — always a
    current snapshot; site_id scoping still applies."""
    site_id = filters.get("site_id")
    q = (
        select(Device, Site.name)
        .join(Site, Site.id == Device.site_id, isouter=True)
        .where(Device.tenant_id == tenant_id, Device.is_active == True)  # noqa: E712
    )
    if site_id:
        q = q.where(Device.site_id == site_id)
    q = q.order_by(Site.name.nullslast(), Device.hostname)
    devices = (await db.execute(q)).all()

    rows = [{
        "hostname": dev.hostname,
        "fqdn": dev.fqdn,
        "mgmt_ip": dev.mgmt_ip_str,
        "site": site_name or "Unassigned",
        "vendor": dev.vendor,
        "device_type": dev.device_type,
        "platform": dev.platform,
        "os_version": dev.os_version,
        "serial_number": dev.serial_number,
        "status": dev.status,
    } for dev, site_name in devices]

    return {"devices": rows}


async def compliance_report_data(
    db: AsyncSession, tenant_id: uuid.UUID, filters: dict,
) -> dict:
    """Config compliance pass/fail summary by policy, plus the latest
    per-device-per-policy result within the report window (default 30d)."""
    start, end, days = normalize_range(filters, "compliance")
    site_id = filters.get("site_id")

    site_clause = "AND d.site_id = :site_id" if site_id else ""
    params = {"tid": str(tenant_id), "start": start, "end": end}
    if site_id:
        params["site_id"] = site_id

    rows = (await db.execute(text(f"""
        SELECT p.name AS policy_name, p.severity, d.hostname, cr.status, cr.checked_at, cr.findings
          FROM compliance_results cr
          JOIN compliance_policies p ON p.id = cr.policy_id
          JOIN devices d ON d.id = cr.device_id
         WHERE p.tenant_id = :tid AND cr.checked_at BETWEEN :start AND :end {site_clause}
         ORDER BY p.name, d.hostname, cr.checked_at DESC
    """), params)).all()

    # Keep only the latest result per (policy, device) pair — rows already
    # arrive checked_at DESC within each group, so the first hit wins.
    latest: dict[tuple, dict] = {}
    for r in rows:
        key = (r.policy_name, r.hostname)
        if key not in latest:
            latest[key] = {
                "policy": r.policy_name, "severity": r.severity, "device": r.hostname,
                "status": r.status, "checked_at": r.checked_at.isoformat(),
                "finding_count": len(r.findings or []),
            }

    results = list(latest.values())
    summary_by_policy: dict[str, dict] = {}
    for res in results:
        s = summary_by_policy.setdefault(res["policy"], {"policy": res["policy"], "pass": 0, "fail": 0, "error": 0})
        s[res["status"]] = s.get(res["status"], 0) + 1

    return {
        "window_days": days,
        "period_start": start.isoformat(), "period_end": end.isoformat(),
        "summary": list(summary_by_policy.values()), "results": results,
    }


_SEVERITY_ORDER = ["critical", "major", "minor", "warning", "info"]


async def alert_summary_report_data(
    db: AsyncSession, tenant_id: uuid.UUID, filters: dict,
) -> dict:
    """Alert counts and mean-time-to-ack/resolve by severity, plus the
    noisiest devices, over the report window (default 30d)."""
    start, end, days = normalize_range(filters, "alert_summary")
    site_id = filters.get("site_id")

    site_join = "JOIN devices d ON d.id = a.device_id" if site_id else ""
    site_clause = "AND d.site_id = :site_id" if site_id else ""
    params = {"tid": str(tenant_id), "start": start, "end": end}
    if site_id:
        params["site_id"] = site_id

    by_severity = (await db.execute(text(f"""
        SELECT a.severity, COUNT(*) AS alert_count,
               AVG(EXTRACT(EPOCH FROM (a.acknowledged_at - a.triggered_at)))
                   FILTER (WHERE a.acknowledged_at IS NOT NULL) AS mtta_seconds,
               AVG(EXTRACT(EPOCH FROM (a.resolved_at - a.triggered_at)))
                   FILTER (WHERE a.resolved_at IS NOT NULL) AS mttr_seconds
          FROM alerts a
          {site_join}
         WHERE a.tenant_id = :tid AND a.triggered_at BETWEEN :start AND :end {site_clause}
         GROUP BY a.severity
    """), params)).all()

    severity_rows = {r.severity: r for r in by_severity}
    severity_summary = [{
        "severity": sev,
        "alert_count": severity_rows[sev].alert_count if sev in severity_rows else 0,
        "mtta_seconds": float(severity_rows[sev].mtta_seconds) if sev in severity_rows and severity_rows[sev].mtta_seconds is not None else None,
        "mttr_seconds": float(severity_rows[sev].mttr_seconds) if sev in severity_rows and severity_rows[sev].mttr_seconds is not None else None,
    } for sev in _SEVERITY_ORDER if sev in severity_rows]

    top_devices = (await db.execute(text(f"""
        SELECT d.hostname, COUNT(*) AS alert_count
          FROM alerts a
          JOIN devices d ON d.id = a.device_id
         WHERE a.tenant_id = :tid AND a.triggered_at BETWEEN :start AND :end {site_clause}
         GROUP BY d.hostname
         ORDER BY alert_count DESC
         LIMIT 15
    """), params)).all()

    total = sum(s["alert_count"] for s in severity_summary)
    return {
        "window_days": days,
        "period_start": start.isoformat(), "period_end": end.isoformat(),
        "total_alerts": total,
        "by_severity": severity_summary,
        "top_devices": [{"hostname": r.hostname, "alert_count": r.alert_count} for r in top_devices],
    }


async def config_changes_report_data(
    db: AsyncSession, tenant_id: uuid.UUID, filters: dict,
) -> dict:
    """Config diffs (who changed what, how much) over the report window
    (default 30d). Actor attribution mirrors git_archive.py's
    _triggered_by() — nearest-preceding config_push audit row within 120s
    of the backup, falling back to "periodic poll" if none is found.
    audit_log.created_at is naive UTC (a known gotcha), so the comparison
    converts collected_at (timestamptz) to naive UTC via AT TIME ZONE."""
    start, end, days = normalize_range(filters, "config_changes")
    site_id = filters.get("site_id")

    site_clause = "AND d.site_id = :site_id" if site_id else ""
    params = {"tid": str(tenant_id), "start": start, "end": end}
    if site_id:
        params["site_id"] = site_id

    rows = (await db.execute(text(f"""
        SELECT d.hostname, cb.collected_at, cd.lines_added, cd.lines_removed, u.username
          FROM config_diffs cd
          JOIN config_backups cb ON cb.id = cd.curr_backup_id
          JOIN devices d ON d.id = cd.device_id
          LEFT JOIN LATERAL (
              SELECT user_id FROM audit_log
               WHERE resource_type = 'device' AND resource_id = cd.device_id
                 AND action = 'config_push'
                 AND created_at <= (cb.collected_at AT TIME ZONE 'UTC')
                 AND created_at >= (cb.collected_at AT TIME ZONE 'UTC') - INTERVAL '120 seconds'
               ORDER BY created_at DESC LIMIT 1
          ) al ON true
          LEFT JOIN users u ON u.id = al.user_id
         WHERE d.tenant_id = :tid AND cb.collected_at BETWEEN :start AND :end {site_clause}
         ORDER BY cb.collected_at DESC
         LIMIT 200
    """), params)).all()

    changes = [{
        "hostname": r.hostname,
        "collected_at": r.collected_at.isoformat(),
        "lines_added": r.lines_added,
        "lines_removed": r.lines_removed,
        "changed_by": r.username or "periodic poll",
    } for r in rows]

    return {
        "window_days": days,
        "period_start": start.isoformat(), "period_end": end.isoformat(),
        "changes": changes,
    }


async def flow_top_talkers_report_data(
    db: AsyncSession, tenant_id: uuid.UUID, filters: dict,
) -> dict:
    """Top bandwidth consumers by src/dst/protocol, adapted from
    routers/flow.py's top_talkers() endpoint — same tables, same device
    filter, same protocol name map, just a wider default window."""
    from ..routers.flow import PROTO_NAMES, _device_filter

    start, end, days = normalize_range(filters, "flow_top_talkers")
    limit = int(filters.get("limit", 25))

    device_ids = await _tenant_device_ids_str(db, tenant_id, filters.get("site_id"))
    if not device_ids:
        return {
            "window_days": days,
            "period_start": start.isoformat(), "period_end": end.isoformat(),
            "talkers": [],
        }

    dev_filter = _device_filter(device_ids)
    start_lit = start.strftime("%Y-%m-%d %H:%M:%S")
    end_lit = end.strftime("%Y-%m-%d %H:%M:%S")
    rows = await _ch_query(f"""
        SELECT
            src_addr, dst_addr, ip_protocol,
            sum(bytes_total)   AS bytes_total,
            sum(packets_total) AS packets_total
        FROM (
            SELECT IPv4NumToString(src_ip) AS src_addr, IPv4NumToString(dst_ip) AS dst_addr,
                   ip_protocol, bytes_total, packets_total
              FROM flow_agg_1min
             WHERE {dev_filter} AND minute BETWEEN toDateTime('{start_lit}') AND toDateTime('{end_lit}')
            UNION ALL
            SELECT IPv6NumToString(src_ip6) AS src_addr, IPv6NumToString(dst_ip6) AS dst_addr,
                   ip_protocol, bytes_total, packets_total
              FROM flow_agg6_1min
             WHERE {dev_filter} AND minute BETWEEN toDateTime('{start_lit}') AND toDateTime('{end_lit}')
        )
        GROUP BY src_addr, dst_addr, ip_protocol
        ORDER BY bytes_total DESC
        LIMIT {limit}
    """)

    talkers = [{
        "src_ip": r["src_addr"], "dst_ip": r["dst_addr"],
        "protocol": PROTO_NAMES.get(int(r["ip_protocol"]), str(r["ip_protocol"])),
        "bytes_total": int(r["bytes_total"]), "packets_total": int(r["packets_total"]),
    } for r in rows]

    return {
        "window_days": days,
        "period_start": start.isoformat(), "period_end": end.isoformat(),
        "talkers": talkers,
    }


async def interface_health_report_data(
    db: AsyncSession, tenant_id: uuid.UUID, filters: dict,
) -> dict:
    """Interface errors/discards (VictoriaMetrics counters, summed across all
    interfaces per device) plus link-state flap counts (InterfaceStatusLog),
    over the report window (default 7d)."""
    start, end, days = normalize_range(filters, "interface_health")
    site_id = filters.get("site_id")

    q = select(Device.id, Device.hostname).where(Device.tenant_id == tenant_id, Device.is_active == True)  # noqa: E712
    if site_id:
        q = q.where(Device.site_id == site_id)
    q = q.order_by(Device.hostname)
    devices = (await db.execute(q)).all()

    site_clause = "AND site_id = :site_id" if site_id else ""
    params = {"tid": str(tenant_id), "start": start, "end": end}
    if site_id:
        params["site_id"] = site_id

    flap_rows = (await db.execute(text(f"""
        SELECT device_id, COUNT(*) AS flap_count
          FROM interface_status_log
         WHERE device_id IN (SELECT id FROM devices WHERE tenant_id = :tid {site_clause})
           AND recorded_at BETWEEN :start AND :end
         GROUP BY device_id
    """), params)).all()
    flaps_by_device = {str(r.device_id): r.flap_count for r in flap_rows}

    window = f"{days}d"
    rows = []
    for did, hostname in devices:
        sdid = str(did)
        in_errors = await _vm_instant(f'sum(increase(anthrimon_if_in_errors_total{{device_id="{sdid}"}}[{window}]))', at=end)
        out_errors = await _vm_instant(f'sum(increase(anthrimon_if_out_errors_total{{device_id="{sdid}"}}[{window}]))', at=end)
        in_discards = await _vm_instant(f'sum(increase(anthrimon_if_in_discards_total{{device_id="{sdid}"}}[{window}]))', at=end)
        out_discards = await _vm_instant(f'sum(increase(anthrimon_if_out_discards_total{{device_id="{sdid}"}}[{window}]))', at=end)
        flap_count = flaps_by_device.get(sdid, 0)

        if not any([in_errors, out_errors, in_discards, out_discards, flap_count]):
            continue  # skip devices with a perfectly clean window — keeps the report focused

        rows.append({
            "hostname": hostname,
            "in_errors": int(in_errors) if in_errors else 0,
            "out_errors": int(out_errors) if out_errors else 0,
            "in_discards": int(in_discards) if in_discards else 0,
            "out_discards": int(out_discards) if out_discards else 0,
            "flap_count": flap_count,
        })

    rows.sort(key=lambda r: r["in_errors"] + r["out_errors"] + r["flap_count"], reverse=True)
    return {
        "window_days": days,
        "period_start": start.isoformat(), "period_end": end.isoformat(),
        "devices": rows,
    }


async def bgp_health_report_data(
    db: AsyncSession, tenant_id: uuid.UUID, filters: dict,
) -> dict:
    """Current BGP session snapshot (state, prefixes, all-time flap_count —
    both already tracked columns on bgp_sessions) plus state-change events
    within the report window (default 30d) as an instability signal."""
    start, end, days = normalize_range(filters, "bgp_health")
    site_id = filters.get("site_id")

    site_clause_d = "AND d.site_id = :site_id" if site_id else ""
    site_clause_sub = "AND site_id = :site_id" if site_id else ""
    params = {"tid": str(tenant_id), "start": start, "end": end}
    if site_id:
        params["site_id"] = site_id

    sessions = (await db.execute(text(f"""
        SELECT s.id, d.hostname, s.peer_ip, s.peer_asn, s.session_state,
               s.prefixes_received, s.prefixes_advertised, s.flap_count
          FROM bgp_sessions s
          JOIN devices d ON d.id = s.device_id
         WHERE d.tenant_id = :tid {site_clause_d}
         ORDER BY d.hostname, s.peer_ip
    """), params)).all()

    events = (await db.execute(text(f"""
        SELECT session_id, COUNT(*) AS state_changes
          FROM bgp_session_events
         WHERE device_id IN (SELECT id FROM devices WHERE tenant_id = :tid {site_clause_sub})
           AND recorded_at BETWEEN :start AND :end
         GROUP BY session_id
    """), params)).all()
    changes_by_session = {r.session_id: r.state_changes for r in events}

    rows = [{
        "hostname": s.hostname,
        "peer_ip": str(s.peer_ip),
        "peer_asn": s.peer_asn,
        "session_state": s.session_state,
        "prefixes_received": s.prefixes_received or 0,
        "prefixes_advertised": s.prefixes_advertised or 0,
        "flap_count": s.flap_count,
        "state_changes_in_window": changes_by_session.get(s.id, 0),
    } for s in sessions]

    return {
        "window_days": days,
        "period_start": start.isoformat(), "period_end": end.isoformat(),
        "sessions": rows,
    }


async def syslog_security_report_data(
    db: AsyncSession, tenant_id: uuid.UUID, filters: dict,
) -> dict:
    """Syslog severity trend (syslog_agg_1hr, summed across tenant devices)
    plus match counts for each configured syslog_match alert rule, over the
    report window (default 7d). Regex patterns are admin-authored rule
    config, not end-user input, but are still bound as ClickHouse query
    parameters (never string-interpolated) via _ch_query_params — same
    safety discipline as alerting/evaluators.py's eval_syslog_match()."""
    import json as _json

    from ..models.alert import AlertRule

    start, end, days = normalize_range(filters, "syslog_security")

    device_ids = await _tenant_device_ids_str(db, tenant_id, filters.get("site_id"))
    if not device_ids:
        return {
            "window_days": days,
            "period_start": start.isoformat(), "period_end": end.isoformat(),
            "by_severity": [], "matched_rules": [],
        }

    start_lit = start.strftime("%Y-%m-%d %H:%M:%S")
    end_lit = end.strftime("%Y-%m-%d %H:%M:%S")

    ids_list = ", ".join(f"toUUID('{d}')" for d in device_ids)
    severity_rows = await _ch_query(f"""
        SELECT severity, sum(count) AS total
          FROM syslog_agg_1hr
         WHERE device_id IN ({ids_list}) AND hour BETWEEN toDateTime('{start_lit}') AND toDateTime('{end_lit}')
         GROUP BY severity
         ORDER BY severity
    """)
    from ..routers.syslog import SEVERITY_NAMES
    by_severity = [{
        "severity": int(r["severity"]),
        "severity_name": SEVERITY_NAMES.get(int(r["severity"]), str(r["severity"])),
        "count": int(r["total"]),
    } for r in severity_rows]

    rules = (await db.execute(
        select(AlertRule).where(AlertRule.tenant_id == tenant_id, AlertRule.metric == "syslog_match")
    )).scalars().all()

    matched_rules = []
    for rule in rules:
        try:
            filt = _json.loads(rule.custom_oid) if rule.custom_oid else {}
        except Exception:
            continue
        pattern = (filt.get("pattern") or "").strip()
        if not pattern:
            continue

        clauses = [f"device_id IN ({ids_list})", "ts BETWEEN {start:DateTime} AND {end:DateTime}",
                   "match(message, {pat:String})"]
        ch_params = {"param_start": start_lit, "param_end": end_lit, "param_pat": pattern}
        if filt.get("program"):
            clauses.append("program = {prog:String}")
            ch_params["param_prog"] = str(filt["program"])
        if filt.get("severity_max") is not None:
            clauses.append("severity <= {sevmax:UInt8}")
            ch_params["param_sevmax"] = str(int(filt["severity_max"]))

        where = " AND ".join(clauses)
        count_rows = await _ch_query_params(
            f"SELECT count() AS n FROM syslog_messages WHERE {where}", ch_params,
        )
        count = int(count_rows[0]["n"]) if count_rows else 0
        matched_rules.append({"rule_name": rule.name, "pattern": pattern, "match_count": count})

    matched_rules.sort(key=lambda r: r["match_count"], reverse=True)
    return {
        "window_days": days,
        "period_start": start.isoformat(), "period_end": end.isoformat(),
        "by_severity": by_severity, "matched_rules": matched_rules,
    }


async def bundle_report_data(
    db: AsyncSession, tenant_id: uuid.UUID, filters: dict,
) -> dict:
    """Combines multiple report types into one set of sections for a single
    PDF/CSV (feature 4). filters["report_types"] (validated non-empty, no
    dupes/self-reference by schemas.report._validate_bundle_filters) lists
    which of the other 10 types to include; the same filters (date range,
    site, compare) apply to every type in the bundle."""
    from .render import TITLES

    report_types = filters.get("report_types", [])
    sections = []
    for t in report_types:
        data = await REPORT_DATA_FUNCS[t](db, tenant_id, filters)
        sections.append({"type": t, "title": TITLES.get(t, t.title()), "data": data})

    return {"report_types": report_types, "sections": sections}


REPORT_DATA_FUNCS = {
    "capacity": capacity_report_data,
    "sla": sla_report_data,
    "inventory": inventory_report_data,
    "compliance": compliance_report_data,
    "alert_summary": alert_summary_report_data,
    "config_changes": config_changes_report_data,
    "flow_top_talkers": flow_top_talkers_report_data,
    "interface_health": interface_health_report_data,
    "bgp_health": bgp_health_report_data,
    "syslog_security": syslog_security_report_data,
    "bundle": bundle_report_data,
}
