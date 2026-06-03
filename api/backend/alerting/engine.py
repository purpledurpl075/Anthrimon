from __future__ import annotations

import asyncio
import hashlib
import math
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import structlog
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import AsyncSessionLocal
from ..models.alert import Alert, AlertRule, MaintenanceWindow
from ..models.settings import SystemSetting
from . import notify
from .maintenance import device_in_maintenance, load_active_windows
from .evaluators import (
    Breach,
    eval_cpu, eval_mem, eval_device_down,
    eval_interface_down, eval_interface_flap,
    eval_uptime, eval_temperature, eval_interface_errors, eval_interface_util,
    eval_custom_oid, eval_ospf_state, eval_route_missing, eval_flow_bandwidth,
    eval_syslog_match, eval_bgp_session_down, eval_bgp_session_flapping,
    eval_bgp_prefix_drop, eval_device_latency, eval_snmp_trap, fetch_syslog_context,
    resolve_devices,
)

logger = structlog.get_logger(__name__)

EVAL_INTERVAL = 15  # seconds

# How long to keep an fp in the in-memory state dicts after it was last active.
# Must exceed any realistic duration_seconds + stable_for_seconds to avoid
# clearing a pending duration gate early.  4 h is a safe upper bound.
_STATE_TTL = timedelta(hours=4)


def _safe_context(ctx: dict) -> dict:
    """Sanitize a context dict for JSONB storage — replace Infinity/NaN with None."""
    def _clean(v):
        if isinstance(v, float) and not math.isfinite(v):
            return None
        if isinstance(v, dict):
            return {k: _clean(val) for k, val in v.items()}
        if isinstance(v, list):
            return [_clean(i) for i in v]
        return v
    return {k: _clean(v) for k, v in ctx.items()}

# Pending notification: (alert, rule, resolved)
_PendingNotif = tuple[Alert, AlertRule, bool]


def _selector_specificity(selector: Optional[dict]) -> int:
    """Higher = more specific. device_ids(3) > tags(2) > vendors(1) > all(0)."""
    if not selector:
        return 0
    if selector.get("device_ids"):
        return 3
    if selector.get("tags"):
        return 2
    if selector.get("vendors"):
        return 1
    return 0


def _device_matches_selector(device: dict, selector: Optional[dict]) -> bool:
    if not selector:
        return True
    if "device_ids" in selector:
        return device["id"] in (selector["device_ids"] or [])
    if "vendors" in selector:
        return device.get("vendor") in (selector["vendors"] or [])
    if "tags" in selector:
        dev_tags = device.get("tags") or []
        if isinstance(dev_tags, str):
            import json
            try: dev_tags = json.loads(dev_tags)
            except Exception: dev_tags = []
        return any(t in dev_tags for t in selector["tags"])
    return True


def _is_overridden(rule: AlertRule, device: dict, peer_rules: list[AlertRule]) -> bool:
    """Return True if another peer rule is more specific for this device+metric."""
    my_spec = _selector_specificity(rule.device_selector)
    for other in peer_rules:
        if other.id == rule.id or not other.is_enabled:
            continue
        if _selector_specificity(other.device_selector) > my_spec:
            if _device_matches_selector(device, other.device_selector):
                return True
    return False


def _fingerprint(rule_id: str, device_id: str, interface_id: Optional[str] = None) -> str:
    raw = f"{rule_id}:{device_id}:{interface_id or ''}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def _build_title(rule: AlertRule, breach: Breach) -> str:
    base = breach.device_name
    if breach.interface_name:
        base += f" — {breach.interface_name}"
    metric_labels = {
        "cpu_util_pct":    f"CPU {breach.value:.1f}%" if breach.value is not None else "CPU high",
        "mem_util_pct":    f"Memory {breach.value:.1f}%" if breach.value is not None else "Memory high",
        "device_down":     "device unreachable",
        "interface_down":  "interface down",
        "interface_flap":  f"interface flapping ({int(min(breach.value or 0, 1e9))} changes)",
        "temperature":     f"temperature {breach.value:.1f}°C" if breach.value is not None else "temperature high",
        "interface_errors":   f"interface errors ({int(breach.value) if breach.value and math.isfinite(breach.value) else 0})",
        "interface_util_pct": f"bandwidth {breach.value:.1f}%" if breach.value is not None else "bandwidth high",
        "ospf_state":      f"OSPF neighbor {breach.extra.get('neighbor','')} {breach.extra.get('ospf_state','')}",
        "uptime":          f"rebooted (uptime {int(breach.value) if breach.value and math.isfinite(breach.value) else 0}s)",
        "route_missing":    f"route {breach.extra.get('prefix', rule.custom_oid or '?')} missing",
        "flow_bandwidth":  f"flow bandwidth {breach.value / 1e6:.1f} Mbps ({breach.extra.get('flow_filter','')}) high" if breach.value is not None else "flow bandwidth high",
        "syslog_match":    f"syslog match ({int(breach.value) if breach.value and math.isfinite(breach.value) else 0}×): {breach.extra.get('syslog_message', breach.extra.get('syslog_pattern','')[:60])}",
        "config_change":   f"config changed (+{breach.extra.get('lines_added',0)} -{breach.extra.get('lines_removed',0)} lines)",
        "bgp_session_down":    f"BGP peer {breach.extra.get('peer_ip','?')} (AS{breach.extra.get('peer_asn','?')}) {breach.extra.get('session_state','down')}",
        "bgp_session_flapping":f"BGP peer {breach.extra.get('peer_ip','?')} (AS{breach.extra.get('peer_asn','?')}) flapped {breach.extra.get('flap_count',0)}× in {breach.extra.get('window_minutes',60)}m",
        "bgp_prefix_drop":     f"BGP peer {breach.extra.get('peer_ip','?')} (AS{breach.extra.get('peer_asn','?')}) prefix count dropped {breach.extra.get('drop_pct',0):.1f}% ({breach.extra.get('prefixes_now','?')} vs avg {breach.extra.get('prefixes_avg','?')})",
        "snmp_trap":       f"SNMP trap {breach.extra.get('trap_type', breach.extra.get('trap_type_pattern','?'))} received {int(breach.value) if breach.value is not None else 0}× in {breach.extra.get('window_minutes','?')}m",
        "device_latency": (
            f"high RTT {breach.value:.1f} ms (threshold {breach.extra.get('threshold_ms','?')} ms)"
            if breach.extra.get("metric") == "rtt_ms"
            else f"packet loss {breach.value:.1f}% (threshold {breach.extra.get('threshold_pct','?')}%)"
        ) if breach.value is not None else (
            f"high RTT — ms (threshold {breach.extra.get('threshold_ms','?')} ms)"
            if breach.extra.get("metric") == "rtt_ms"
            else f"packet loss —% (threshold {breach.extra.get('threshold_pct','?')}%)"
        ),
    }
    return f"{base}: {metric_labels.get(rule.metric, rule.metric)}"


async def _safe_dispatch(alert: Alert, rule: AlertRule, *, resolved: bool = False) -> None:
    """Dispatch notifications in a fresh session, outside the eval transaction."""
    try:
        await notify.dispatch(alert, rule, resolved=resolved)
    except Exception as exc:
        logger.error("notify_dispatch_failed", alert_id=str(alert.id),
                     rule=rule.name, error=str(exc))


class AlertEngine:
    def __init__(self) -> None:
        self._breach_since: dict[str, datetime] = {}   # fp → breach start (duration gating)
        self._clear_since:  dict[str, datetime] = {}   # fp → clear start (flap suppression)
        self._last_clear:   dict[str, datetime] = {}   # fp → last time condition was clear
        # fps manually resolved by a user while condition was still active;
        # suppressed until the condition actually clears so we don't spam
        self._suppress_until_clear: set[str] = set()
        # fp → last time it was touched by any state operation.
        # Housekeeping prunes any fp that hasn't been seen within _STATE_TTL,
        # which reclaims memory for deleted devices and retired rules.
        self._fp_last_seen: dict[str, datetime] = {}

    async def run(self) -> None:
        logger.info("alert_engine_starting", interval_s=EVAL_INTERVAL)
        _housekeeping_counter = 0
        while True:
            try:
                await asyncio.sleep(EVAL_INTERVAL)
                pending: list[_PendingNotif] = []
                async with AsyncSessionLocal() as db:
                    # Load platform settings once per cycle
                    prow = (await db.execute(
                        select(SystemSetting).where(SystemSetting.key == "platform")
                    )).scalar_one_or_none()
                    platform = prow.value if prow else {}

                    try:
                        pending = await self._evaluate_all(db, platform)
                        await db.commit()
                    except Exception as exc:
                        await db.rollback()
                        logger.error("alert_engine_eval_error", error=str(exc), exc_info=True)

                # Housekeeping every ~5 minutes (20 × 15 s cycles)
                _housekeeping_counter += 1
                if _housekeeping_counter >= 20:
                    _housekeeping_counter = 0
                    await self._housekeeping(platform)

                # Dispatch notifications after the commit — never inside the eval transaction.
                for alert, rule, resolved in pending:
                    await _safe_dispatch(alert, rule, resolved=resolved)
            except asyncio.CancelledError:
                logger.info("alert_engine_stopped")
                return
            except Exception as exc:
                logger.error("alert_engine_error", error=str(exc), exc_info=True)

    async def _housekeeping(self, platform: dict) -> None:
        """Periodic cleanup: auto-close stale alerts + purge old alerts + prune state dicts."""
        # ── Auto-close stale open alerts ─────────────────────────────────────
        auto_close_days = int(platform.get("auto_close_stale_days", 0))
        if auto_close_days > 0:
            try:
                async with AsyncSessionLocal() as db:
                    cutoff = f"now() - interval '{auto_close_days} days'"
                    result = await db.execute(text(f"""
                        UPDATE alerts
                        SET status = 'resolved', resolved_at = now()
                        WHERE status IN ('open','acknowledged')
                          AND triggered_at < {cutoff}
                        RETURNING id
                    """))
                    closed = result.rowcount
                    if closed:
                        logger.info("auto_closed_stale_alerts", count=closed, days=auto_close_days)
                    await db.commit()
            except Exception as exc:
                logger.error("housekeeping_error", error=str(exc))

        # ── Purge old resolved/expired alerts ────────────────────────────────
        # Only purges non-open alerts; open/acknowledged alerts are never deleted
        # by retention — they must be resolved or auto-closed first.
        retention_days = int(platform.get("alert_retention_days", 0))
        if retention_days > 0:
            try:
                async with AsyncSessionLocal() as db:
                    result = await db.execute(text(f"""
                        DELETE FROM alerts
                        WHERE status IN ('resolved','expired','suppressed')
                          AND triggered_at < now() - interval '{retention_days} days'
                    """))
                    deleted = result.rowcount
                    if deleted:
                        logger.info("alert_retention_purged", count=deleted, days=retention_days)
                    await db.commit()
            except Exception as exc:
                logger.error("housekeeping_retention_error", error=str(exc))

        # ── Prune in-memory state for deleted devices / retired rules ─────────
        # Any fingerprint not touched within _STATE_TTL is for a condition that
        # is no longer being evaluated (device deleted, rule disabled, interface
        # removed).  Remove it from all four state structures so memory stays
        # bounded regardless of how many devices have come and gone.
        now = datetime.now(timezone.utc)
        stale = {fp for fp, ts in self._fp_last_seen.items()
                 if (now - ts) > _STATE_TTL}
        if stale:
            for fp in stale:
                self._breach_since.pop(fp, None)
                self._clear_since.pop(fp, None)
                self._last_clear.pop(fp, None)
                self._suppress_until_clear.discard(fp)
                del self._fp_last_seen[fp]
            logger.info("alert_state_pruned",
                        stale_fps=len(stale),
                        remaining_fps=len(self._fp_last_seen))

    async def _evaluate_all(self, db: AsyncSession, platform: dict | None = None) -> list[_PendingNotif]:
        rules = (await db.execute(
            select(AlertRule)
            .where(AlertRule.is_enabled == True)  # noqa: E712
            .order_by(AlertRule.name)
        )).scalars().all()

        # Build per-metric override map so higher-specificity rules silence broader ones
        rules_by_metric: dict[str, list[AlertRule]] = {}
        for rule in rules:
            rules_by_metric.setdefault(rule.metric, []).append(rule)

        # Load active maintenance windows once per cycle for all tenants' rules
        tenant_ids = {str(r.tenant_id) for r in rules}
        active_windows: list = []
        for tid in tenant_ids:
            active_windows.extend(await load_active_windows(db, tid))

        pending: list[_PendingNotif] = []
        for rule in rules:
            rule_id_str = str(rule.id)  # capture before any potential failure
            # Use a savepoint so a failing rule only rolls back its own changes,
            # not the alert creations from earlier rules in this cycle.
            sp = await db.begin_nested()
            try:
                rule_pending = await self._evaluate_rule(
                    db, rule, rules_by_metric.get(rule.metric, []), active_windows, platform or {}
                )
                await sp.commit()
                pending.extend(rule_pending)
            except Exception as exc:
                await sp.rollback()
                logger.error("rule_eval_error", rule_id=rule_id_str, error=str(exc), exc_info=True)

        await self._purge_expired_windows(db)
        return pending

    async def _purge_expired_windows(self, db: AsyncSession) -> None:
        """Delete one-time maintenance windows that have passed their end time."""
        now = datetime.now(timezone.utc)
        expired = (await db.execute(
            select(MaintenanceWindow).where(
                MaintenanceWindow.is_recurring == False,  # noqa: E712
                MaintenanceWindow.ends_at < now,
            )
        )).scalars().all()
        for w in expired:
            logger.info("maintenance_window_expired", id=str(w.id), name=w.name)
            await db.delete(w)

    async def _evaluate_rule(self, db: AsyncSession, rule: AlertRule,
                              peer_rules: Optional[list[AlertRule]] = None,
                              active_windows: Optional[list] = None,
                              platform: dict | None = None) -> list[_PendingNotif]:
        peer_rules = peer_rules or []
        active_windows = active_windows or []
        tenant_id = str(rule.tenant_id)
        devices = await resolve_devices(db, tenant_id, rule.device_selector)
        if not devices:
            return []

        pending: list[_PendingNotif] = []

        # ── Collect breaches ───────────────────────────────────────────────────
        breaches: list[Breach] = []
        for device in devices:
            # Skip if a more specific rule already handles this device+metric
            if _is_overridden(rule, device, peer_rules):
                continue

            # Check device-level alert exclusions
            exclusions = device.get("alert_exclusions") or {}
            if isinstance(exclusions, str):
                import json as _j
                try: exclusions = _j.loads(exclusions)
                except Exception: exclusions = {}
            excluded_metrics = exclusions.get("metrics", [])
            if rule.metric in excluded_metrics:
                continue

            # Skip if device is in any active maintenance window
            if device_in_maintenance(device, active_windows):
                continue

            pre_breach_count = len(breaches)

            if rule.metric == "cpu_util_pct":
                b = await eval_cpu(db, device, rule.condition, rule.threshold or 0)
                if b: breaches.append(b)
            elif rule.metric == "mem_util_pct":
                b = await eval_mem(db, device, rule.condition, rule.threshold or 0)
                if b: breaches.append(b)
            elif rule.metric == "device_down":
                b = await eval_device_down(db, device, platform)
                if b: breaches.append(b)
            elif rule.metric == "interface_down":
                excluded_iface_ids = set(exclusions.get("interface_ids", []))
                new_breaches = await eval_interface_down(db, device)
                breaches.extend(b for b in new_breaches
                                 if b.interface_id not in excluded_iface_ids)
            elif rule.metric == "interface_flap":
                breaches.extend(await eval_interface_flap(
                    db, device,
                    threshold=rule.threshold or 3,
                    window_seconds=rule.duration_seconds or 300,
                ))
            elif rule.metric == "uptime":
                b = await eval_uptime(db, device, rule.condition or "lt", rule.threshold or 3600)
                if b: breaches.append(b)
            elif rule.metric == "temperature":
                b = await eval_temperature(db, device, rule.threshold or 60)
                if b: breaches.append(b)
            elif rule.metric == "interface_errors":
                breaches.extend(await eval_interface_errors(db, device, rule.threshold or 100))
            elif rule.metric == "interface_util_pct":
                breaches.extend(await eval_interface_util(db, device, rule.threshold or 80))
            elif rule.metric == "ospf_state":
                b = await eval_ospf_state(db, device)
                if b: breaches.append(b)
            elif rule.metric == "custom_oid" and rule.custom_oid:
                b = await eval_custom_oid(db, device, rule.custom_oid,
                                           rule.condition or "gt", rule.threshold or 0)
                if b: breaches.append(b)
            elif rule.metric == "route_missing" and rule.custom_oid:
                breaches.extend(await eval_route_missing(db, device, rule.custom_oid))
            elif rule.metric == "flow_bandwidth" and rule.threshold is not None:
                b = await eval_flow_bandwidth(device, rule.custom_oid or "", rule.threshold)
                if b: breaches.append(b)
            elif rule.metric == "bgp_session_down":
                breaches.extend(await eval_bgp_session_down(db, device))
            elif rule.metric == "bgp_session_flapping":
                threshold  = int(rule.threshold)  if rule.threshold  else 3
                window_min = int(rule.duration_seconds // 60) if rule.duration_seconds else 60
                breaches.extend(await eval_bgp_session_flapping(db, device, threshold, window_min))
            elif rule.metric == "bgp_prefix_drop":
                drop_pct = float(rule.threshold) if rule.threshold else 20.0
                breaches.extend(await eval_bgp_prefix_drop(db, device, drop_pct=drop_pct))
            elif rule.metric == "syslog_match" and rule.custom_oid:
                b = await eval_syslog_match(
                    device, rule.custom_oid,
                    rule.threshold or 1,
                    rule.duration_seconds or 300,
                )
                if b: breaches.append(b)
            elif rule.metric == "snmp_trap":
                b = await eval_snmp_trap(
                    db, device,
                    rule.custom_oid or "%",
                    rule.threshold or 1,
                    rule.duration_seconds or 300,
                )
                if b: breaches.append(b)
            elif rule.metric == "device_latency":
                rtt_thresh  = float(rule.threshold)       if rule.threshold        else 100.0
                loss_thresh = float(rule.extra_conditions[0].get("threshold", 10.0)) \
                              if rule.extra_conditions else 10.0
                breaches.extend(await eval_device_latency(device, rtt_thresh, loss_thresh))

            # Extra conditions — ALL must also be true (AND logic)
            if len(breaches) > pre_breach_count and rule.extra_conditions:
                for cond in (rule.extra_conditions or []):
                    cond_metric = cond.get("metric", "")
                    cond_breach = None
                    if cond_metric == "cpu_util_pct":
                        cond_breach = await eval_cpu(db, device, cond.get("condition","gt"), cond.get("threshold",0))
                    elif cond_metric == "mem_util_pct":
                        cond_breach = await eval_mem(db, device, cond.get("condition","gt"), cond.get("threshold",0))
                    if not cond_breach:
                        breaches = breaches[:pre_breach_count]
                        break

        now = datetime.now(timezone.utc)

        # breaching_fps: condition is currently true (regardless of duration)
        # firing_fps:    condition passed duration gate → eligible to fire
        breaching_fps: set[str] = set()
        firing_fps:    set[str] = set()

        for breach in breaches:
            fp = _fingerprint(str(rule.id), breach.device_id, breach.interface_id)
            breaching_fps.add(fp)
            self._clear_since.pop(fp, None)  # still breaching → reset clear clock

            if rule.duration_seconds > 0 and rule.metric != "interface_flap":
                if fp not in self._breach_since:
                    self._breach_since[fp] = now
                    continue
                if (now - self._breach_since[fp]).total_seconds() < rule.duration_seconds:
                    continue
            else:
                self._breach_since.pop(fp, None)

            firing_fps.add(fp)

        # Refresh last-seen for every actively breaching fp so the state TTL
        # clock resets as long as the condition is genuinely firing.
        for fp in breaching_fps:
            self._fp_last_seen[fp] = now

        # Expire manual-resolve suppression for any fp whose condition has now cleared
        for fp in list(self._suppress_until_clear):
            if fp not in breaching_fps:
                self._suppress_until_clear.discard(fp)
                self._last_clear[fp] = now
                self._fp_last_seen[fp] = now  # keep alive: suppress history still useful

        # ── Correlated suppression: build set of devices whose parent is down ──
        suppressed_device_ids: set[str] = set()
        if rule.suppress_if_parent_down and rule.parent_device_id:
            parent_alert = (await db.execute(
                text("""
                    SELECT 1 FROM alerts
                    WHERE device_id = :pid
                      AND status IN ('open','acknowledged')
                      AND severity IN ('critical','major')
                    LIMIT 1
                """),
                {"pid": str(rule.parent_device_id)},
            )).first()
            if parent_alert:
                # Only suppress devices that are OSPF neighbors of the parent —
                # not the entire rule scope, which could silence the whole tenant.
                neighbor_rows = (await db.execute(
                    text("""
                        SELECT d.id::text FROM devices d
                        JOIN ospf_neighbors n ON d.mgmt_ip = n.neighbor_ip
                        WHERE n.device_id = :pid
                    """),
                    {"pid": str(rule.parent_device_id)},
                )).fetchall()
                suppressed_device_ids = {r[0] for r in neighbor_rows}

        # ── Fire / suppress alerts ─────────────────────────────────────────────
        _storm_counts: dict[str, int] = {}  # device_id → recent alert count, cached per cycle
        for breach in breaches:
            fp = _fingerprint(str(rule.id), breach.device_id, breach.interface_id)
            if fp not in firing_fps:
                continue

            if rule.metric == "device_down" and breach.device_id:
                await db.execute(
                    text("UPDATE devices SET status = 'unreachable'::device_status WHERE id = :did"),
                    {"did": breach.device_id},
                )

            existing = (await db.execute(
                select(Alert).where(Alert.fingerprint == fp, Alert.status.in_(["open", "acknowledged", "suppressed"]))
            )).scalar_one_or_none()

            if existing is None:
                # If this fp was manually resolved while the condition was still active,
                # suppress re-creation until the condition actually clears.
                if fp in self._suppress_until_clear:
                    continue

                # Check whether the most recent resolution was manual (resolved_by set).
                # If so, and it happened more recently than the last natural clear,
                # suppress until the condition clears so we don't spam the operator.
                last_res = (await db.execute(
                    select(Alert.resolved_by, Alert.resolved_at)
                    .where(Alert.fingerprint == fp, Alert.status == "resolved")
                    .order_by(Alert.resolved_at.desc())
                    .limit(1)
                )).first()
                if last_res and last_res.resolved_by is not None:
                    last_clear = self._last_clear.get(fp)
                    if last_clear is None or last_res.resolved_at > last_clear:
                        self._suppress_until_clear.add(fp)
                        continue

                # ── Storm protection ────────────────────────────────────────────
                storm_limit = int((platform or {}).get("max_alerts_per_device_per_hour", 0))
                if storm_limit > 0 and breach.device_id:
                    if breach.device_id not in _storm_counts:
                        _storm_counts[breach.device_id] = (await db.execute(text(
                            "SELECT count(*) FROM alerts "
                            "WHERE device_id = :did::uuid "
                            "  AND triggered_at > now() - interval '1 hour'"
                        ), {"did": breach.device_id})).scalar_one()
                    if _storm_counts[breach.device_id] >= storm_limit:
                        logger.warning("storm_protection_triggered",
                                       device=breach.device_id, limit=storm_limit)
                        continue

                suppressed = breach.device_id in suppressed_device_ids
                alert = Alert(
                    id=uuid.uuid4(),
                    tenant_id=rule.tenant_id,
                    rule_id=rule.id,
                    device_id=uuid.UUID(breach.device_id) if breach.device_id else None,
                    interface_id=uuid.UUID(breach.interface_id) if breach.interface_id else None,
                    severity=rule.severity,
                    status="suppressed" if suppressed else "open",
                    title=_build_title(rule, breach),
                    message=rule.description,
                    context=_safe_context({
                        "metric":      rule.metric,
                        "device_name": breach.device_name,
                        "value":       breach.value,
                        "threshold":   rule.threshold,
                        "condition":   rule.condition,
                        **breach.extra,
                        # Annotate with recent syslog from this device (best-effort)
                        "syslog_context": await fetch_syslog_context(breach.device_id, count=5)
                                          if breach.device_id else [],
                    }),
                    triggered_at=now,
                    fingerprint=fp,
                    last_notified_at=now if not suppressed else None,
                )
                db.add(alert)
                if not suppressed:
                    logger.info("alert_fired", rule=rule.name, device=breach.device_name,
                                iface=breach.interface_name, severity=rule.severity)
                    pending.append((alert, rule, False))
            elif existing.status == "suppressed" and breach.device_id not in suppressed_device_ids:
                # Parent recovered — unsuppress
                existing.status = "open"

        # ── Escalation: promote severity on long-open unacknowledged alerts ────
        if rule.escalation_severity and rule.escalation_seconds:
            open_alerts = (await db.execute(
                select(Alert).where(
                    Alert.rule_id == rule.id,
                    Alert.status == "open",
                    Alert.severity == rule.severity,
                    Alert.triggered_at >= now - timedelta(days=90),
                )
            )).scalars().all()
            for alert in open_alerts:
                age = (now - alert.triggered_at).total_seconds()
                if age >= rule.escalation_seconds:
                    alert.severity = rule.escalation_severity
                    alert.last_notified_at = now
                    logger.info("alert_escalated", alert_id=str(alert.id),
                                to=rule.escalation_severity, rule=rule.name)
                    pending.append((alert, rule, False))

        # ── Auto-resolve with flap suppression ─────────────────────────────────
        open_alerts = (await db.execute(
            select(Alert).where(
                Alert.rule_id == rule.id,
                Alert.status.in_(["open", "acknowledged"]),
                Alert.triggered_at >= now - timedelta(days=90),
            )
        )).scalars().all()

        for alert in open_alerts:
            fp = alert.fingerprint or ""
            # Keep the state clock alive while the alert still exists in the DB,
            # whether it's currently breaching or in a stability countdown.
            if fp:
                self._fp_last_seen[fp] = now
            if fp in breaching_fps:
                # Still breaching — check re-notify interval
                if rule.renotify_seconds > 0 and alert.last_notified_at is not None:
                    elapsed = (now - alert.last_notified_at).total_seconds()
                    if elapsed >= rule.renotify_seconds:
                        alert.last_notified_at = now
                        pending.append((alert, rule, False))
                continue

            # Acknowledged alerts are not auto-resolved — operator must clear them
            if alert.status == "acknowledged":
                continue

            # Condition cleared — start or check the stable clock
            if rule.stable_for_seconds > 0:
                if fp not in self._clear_since:
                    self._clear_since[fp] = now
                    continue  # wait for stability
                if (now - self._clear_since[fp]).total_seconds() < rule.stable_for_seconds:
                    continue  # not stable yet

            # Resolve
            alert.status = "resolved"
            alert.resolved_at = now
            self._breach_since.pop(fp, None)
            self._clear_since.pop(fp, None)
            self._last_clear[fp] = now
            self._fp_last_seen[fp] = now   # suppress history still useful post-resolve
            self._suppress_until_clear.discard(fp)

            if rule.metric == "device_down" and alert.device_id:
                await db.execute(
                    text("UPDATE devices SET status = 'unknown'::device_status WHERE id = :did AND status = 'unreachable'::device_status"),
                    {"did": str(alert.device_id)},
                )
            logger.info("alert_auto_resolved", alert_id=str(alert.id), rule=rule.name)
            if rule.notify_on_resolve:
                pending.append((alert, rule, True))

        return pending


_engine = AlertEngine()


async def start_alert_engine() -> asyncio.Task:
    return asyncio.create_task(_engine.run(), name="alert-engine")
