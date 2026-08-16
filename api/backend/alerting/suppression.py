"""Parent-child alert suppression — Tier 1.

Computes a per-cycle map of which device IDs / metric combinations are
suppressed by which parent alert.  The engine consults this map when creating
new alerts (set status='suppressed') and when device_down resolves
(unsuppress dependents).

Suppression rules implemented in this tier:

  0. An active collector_offline alert suppresses device_down (and any other
     alert) for every device managed by that collector — a monitoring-plane
     outage is a more fundamental root cause than any individual device's own
     device_down, and must win attribution before Rule 1 can (backwards)
     attribute the collector_offline alert to one of the very devices it
     caused to go stale. See _apply_collector_offline_rule.

  1. device_down on device X suppresses all OTHER alerts on X.
     (own-device collateral — interfaces, BGP, OSPF, CPU)

  2. device_down on device X suppresses device_down on devices that are
     topology-downstream of X (via topology_links).  Determined by graph
     traversal where the parent went down before the child.

  3. interface_down on device X for port P suppresses device_down on the
     LLDP/CDP neighbor connected to P.  Catches the "uplink dropped, the
     downstream device went unreachable" pattern.

  4. device_down on device X suppresses independent neighbor-side session
     alerts (ospf_state / isis_state / bgp_session_down) whose peer
     identifier (IP, router-id, or IS-IS hostname) resolves to one of X's
     own known IPs. Catches "device X died, so its OSPF/IS-IS/BGP peers
     each independently reported the adjacency/session as down" — see
     _apply_peer_alert_rules.

Future tiers (NOT implemented here):
  - bgp_session_down → route_missing for prefixes from that peer
  - ospf_neighbor down → routes via that neighbor
  - environmental (temp/PSU) → device_down on same device
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass
class SuppressionMap:
    # device_id → parent_alert_id: the device_down on this device is suppressed
    # because the root cause is the referenced parent alert (topology upstream).
    device_down_parent: dict[str, uuid.UUID] = field(default_factory=dict)

    # device_id → parent_alert_id: any non-device_down alert on this device is
    # suppressed because of the root cause.  Set when the device itself is down
    # (own-device collateral) or when the device is downstream of a parent.
    other_alerts_parent: dict[str, uuid.UUID] = field(default_factory=dict)

    # (device_id, metric) → parent_alert_id — Tier-2 peer-alert correlation for
    # metrics where a device has at most one open alert per metric (OSPF/IS-IS).
    peer_metric_parent: dict[tuple[str, str], uuid.UUID] = field(default_factory=dict)

    # (device_id, metric, peer_ip) → parent_alert_id — Tier-2 for metrics where
    # a device can have multiple concurrent alerts of the same metric, keyed
    # by which peer they're about (BGP: one alert per peer).
    peer_session_parent: dict[tuple[str, str, str], uuid.UUID] = field(default_factory=dict)

    def parent_for(self, device_id: Optional[str], metric: str,
                    peer_ip: Optional[str] = None) -> Optional[uuid.UUID]:
        """Return the parent alert ID that should suppress this breach, if any."""
        if not device_id:
            return None
        if metric == "device_down":
            return self.device_down_parent.get(device_id)
        p = self.other_alerts_parent.get(device_id)
        if p is not None:
            return p
        if metric in ("ospf_state", "isis_state"):
            return self.peer_metric_parent.get((device_id, metric))
        if metric == "bgp_session_down" and peer_ip:
            return self.peer_session_parent.get((device_id, metric, peer_ip))
        return None


async def compute_suppression_map(db: AsyncSession, tenant_id: str) -> SuppressionMap:
    """Build the suppression map for one tenant in one cycle.

    Order matters: own-device first, then topology downstream cascade, then
    interface_down → downstream device. A later rule MAY overwrite an
    earlier rule's attribution when it has better evidence for the true
    upstream root (e.g. Rule 2 reattributing a device Rule 1 initially
    pointed at its own about-to-be-suppressed device_down). Reattribution
    only ever moves forward toward a more fundamental cause, never backward.
    """
    sm = SuppressionMap()

    # ── Rule 0: collector_offline as root cause ─────────────────────────────
    # Runs first: a collector outage is a more fundamental root cause than any
    # individual device's own device_down, and must win attribution before
    # Rule 1 gets a chance to (backwards) attribute the collector's own alert
    # to one of the very devices it caused to go stale.
    await _apply_collector_offline_rule(db, tenant_id, sm)

    # ── Load all currently-active device_down alerts (parents for rule 1 + 2) ─
    # Include 'suppressed' status too: a suppressed device_down still represents
    # a device that's currently down — it just means it's NOT the root cause.
    # Excluding suppressed would make the "all my other topology neighbours are
    # also down" check (refined Rule 2) unstable, because as soon as one mesh
    # peer gets suppressed it would fall out of the down set, breaking the
    # cascade for everyone else and causing a flapping unsuppress→suppress loop.
    rows = (await db.execute(text("""
        SELECT a.id, a.device_id, a.triggered_at, a.status
          FROM alerts a
          JOIN alert_rules ar ON ar.id = a.rule_id
         WHERE a.tenant_id = CAST(:tid AS uuid)
           AND ar.metric = 'device_down'
           AND a.status IN ('open','acknowledged','suppressed')
           AND a.device_id IS NOT NULL
         ORDER BY a.triggered_at ASC
    """), {"tid": tenant_id})).fetchall()

    # device_id → (alert_id, triggered_at) — earliest open device_down per device
    down_devices: dict[str, tuple[uuid.UUID, object]] = {}
    for r in rows:
        did = str(r.device_id)
        if did not in down_devices:
            down_devices[did] = (r.id, r.triggered_at)

    if not down_devices:
        # Even without device_downs, interface_down → downstream may still apply.
        return await _apply_interface_down_rules(db, tenant_id, sm)

    # ── Rule 1: own-device collateral ──────────────────────────────────────
    for did, (aid, _) in down_devices.items():
        if did in sm.device_down_parent:
            continue  # already attributed to a Tier-0 collector_offline root
        sm.other_alerts_parent[did] = aid

    # ── Rule 2: topology downstream cascade ────────────────────────────────
    # Load topology adjacency: undirected edges from topology_links.
    edges = (await db.execute(text("""
        SELECT source_device_id::text AS a, dest_device_id::text AS b
          FROM topology_links
         WHERE tenant_id = CAST(:tid AS uuid)
    """), {"tid": tenant_id})).fetchall()

    adj: dict[str, set[str]] = {}
    for e in edges:
        adj.setdefault(e.a, set()).add(e.b)
        adj.setdefault(e.b, set()).add(e.a)

    # Walk from each down device (sorted by triggered_at ASC) so the earliest
    # failure wins attribution.  A child is downstream of a parent only if:
    #   - it is a topology neighbor of the parent
    #   - it also went down, at or after the parent's triggered_at
    #   - ALL of its other topology neighbors are also currently down
    #     (i.e., no surviving uplink — its failure is genuinely caused by the
    #     loss of upstream connectivity, not an independent failure happening
    #     to coincide in a meshed topology)
    # Seed with devices already attributed by Tier-0, so a collector-offline
    # root never gets treated as an ordinary topology cascade root/neighbor.
    visited: set[str] = set(sm.device_down_parent.keys())
    for root_did, (root_aid, root_ts) in sorted(
        down_devices.items(), key=lambda kv: kv[1][1]
    ):
        if root_did in visited:
            continue
        visited.add(root_did)
        queue: list[str] = [root_did]
        while queue:
            cur = queue.pop(0)
            for nb in adj.get(cur, ()):
                if nb in visited or nb not in down_devices:
                    continue
                nb_aid, nb_ts = down_devices[nb]
                if nb_ts < root_ts:
                    # Neighbor failed earlier than the root; don't attribute it.
                    continue
                # Refined check: only attribute as downstream if the neighbour
                # has no surviving uplink.  Every monitored topology neighbour
                # of `nb` must also be in down_devices.
                if any(other not in down_devices for other in adj.get(nb, ())):
                    continue
                visited.add(nb)
                sm.device_down_parent[nb] = root_aid
                sm.other_alerts_parent[nb] = root_aid
                queue.append(nb)

    # ── Rule 3: interface_down → downstream device ─────────────────────────
    sm = await _apply_interface_down_rules(db, tenant_id, sm)

    # ── Rule 4: peer-alert correlation (OSPF/IS-IS/BGP neighbor-side alerts) ──
    return await _apply_peer_alert_rules(db, tenant_id, sm, down_devices)


async def _apply_interface_down_rules(
    db: AsyncSession, tenant_id: str, sm: SuppressionMap
) -> SuppressionMap:
    """For each open interface_down alert on device X port P, find the LLDP/CDP
    neighbor on P and suppress that neighbor's device_down under this interface
    alert — but only if the neighbor isn't already attributed to an earlier
    cause (rule 2 wins over rule 3 because device_down on the upstream device
    is a more fundamental root cause).

    Also considers interface_down alerts already 'suppressed' as Rule 1
    same-device collateral of X's own device_down: once X goes down, its own
    uplink interface_down alert becomes Rule-1 collateral and drops out of the
    'open'/'acknowledged' evidence set on the very next cycle — without this,
    a downstream device that only Rule 3 (not Rule 2's stricter "all
    neighbors down" check) can explain would flicker from 'suppressed' back to
    'open' for a cycle. Only alerts confirmed to be collateral of the SAME
    device's own device_down are considered — not suppressed for some other,
    unrelated reason — to avoid chaining through unrelated attributions.
    """
    rows = (await db.execute(text("""
        SELECT a.id                     AS alert_id,
               a.device_id              AS device_id,
               a.interface_id           AS interface_id,
               a.status                 AS status,
               a.suppressed_by_alert_id AS suppressed_by_alert_id,
               i.name                   AS local_port_name
          FROM alerts a
          JOIN alert_rules ar ON ar.id = a.rule_id
          JOIN interfaces  i  ON i.id  = a.interface_id
         WHERE a.tenant_id = CAST(:tid AS uuid)
           AND ar.metric = 'interface_down'
           AND a.status IN ('open','acknowledged','suppressed')
           AND a.interface_id IS NOT NULL
    """), {"tid": tenant_id})).fetchall()

    rows = [
        r for r in rows
        if r.status != "suppressed"
        or (
            sm.other_alerts_parent.get(str(r.device_id)) is not None
            and r.suppressed_by_alert_id == sm.other_alerts_parent[str(r.device_id)]
        )
    ]
    if not rows:
        return sm

    # Resolve each interface to its remote device via LLDP first, CDP as fallback.
    # remote_mgmt_ip → device_id lookup, scoped to tenant.
    dev_by_ip = {
        str(r.mgmt_ip).split("/")[0]: str(r.id)
        for r in (await db.execute(text("""
            SELECT id, mgmt_ip FROM devices WHERE tenant_id = CAST(:tid AS uuid)
        """), {"tid": tenant_id})).fetchall()
    }

    for r in rows:
        # Find downstream device via LLDP, then CDP.
        remote_ip = (await db.execute(text("""
            SELECT remote_mgmt_ip FROM lldp_neighbors
             WHERE device_id = :did AND local_port_name = :port
             LIMIT 1
        """), {"did": str(r.device_id), "port": r.local_port_name})).scalar_one_or_none()
        if not remote_ip:
            remote_ip = (await db.execute(text("""
                SELECT remote_mgmt_ip FROM cdp_neighbors
                 WHERE device_id = :did AND local_port_name = :port
                 LIMIT 1
            """), {"did": str(r.device_id), "port": r.local_port_name})).scalar_one_or_none()
        if not remote_ip:
            continue
        remote_did = dev_by_ip.get(remote_ip)
        if not remote_did:
            continue
        # Don't reattribute if rule 2 already assigned this neighbor to an earlier root.
        if remote_did in sm.device_down_parent:
            continue
        sm.device_down_parent[remote_did] = r.alert_id
        if remote_did not in sm.other_alerts_parent:
            sm.other_alerts_parent[remote_did] = r.alert_id

    return sm


async def _apply_peer_alert_rules(
    db: AsyncSession, tenant_id: str, sm: SuppressionMap,
    down_devices: dict[str, tuple[uuid.UUID, object]],
) -> SuppressionMap:
    """Tier-2: device_down on X suppresses independent neighbor-side session
    alerts (OSPF/IS-IS/BGP) whose peer identifier resolves to one of X's IPs.

    Re-queries the live protocol tables each cycle (consistent with how rules
    2/3 re-derive live state rather than trusting Alert.context JSON) — this
    is also a hard requirement for IS-IS, since eval_isis_state's Breach.extra
    never carries the neighbor's IP at all (only hostname/interface/state).

    None of ospf_neighbors/isis_neighbors/bgp_sessions store a resolved
    peer device_id — only the peer's IP/router-id/hostname as seen over the
    protocol — so this builds a per-cycle "known IP/hostname → device_id"
    index from devices.mgmt_ip and interfaces.ip_addresses (every IP any
    device in the tenant answers to, not just its mgmt IP).
    """
    if not down_devices:
        return sm

    ip_rows = (await db.execute(text("""
        SELECT id::text AS device_id, host(mgmt_ip) AS ip
          FROM devices WHERE tenant_id = CAST(:tid AS uuid) AND mgmt_ip IS NOT NULL
        UNION ALL
        SELECT i.device_id::text, elem->>'address'
          FROM interfaces i
          JOIN devices d ON d.id = i.device_id
         CROSS JOIN LATERAL jsonb_array_elements(i.ip_addresses) elem
         WHERE d.tenant_id = CAST(:tid AS uuid)
    """), {"tid": tenant_id})).fetchall()
    # Build ip -> device_id, but drop any IP claimed by more than one device
    # (a real address collision, e.g. duplicate loopbacks from a copy-pasted
    # lab config) rather than silently picking whichever row happened to
    # come back last — an ambiguous match must not drive suppression.
    ip_to_device: dict[str, Optional[str]] = {}
    for r in ip_rows:
        if not r.ip:
            continue
        if r.ip in ip_to_device and ip_to_device[r.ip] != r.device_id:
            ip_to_device[r.ip] = None  # ambiguous — more than one device claims this IP
        else:
            ip_to_device[r.ip] = r.device_id

    host_rows = (await db.execute(text(
        "SELECT id::text AS device_id, lower(hostname) AS h FROM devices "
        "WHERE tenant_id = CAST(:tid AS uuid)"
    ), {"tid": tenant_id})).fetchall()
    host_to_device: dict[str, Optional[str]] = {}
    for r in host_rows:
        if not r.h:
            continue
        if r.h in host_to_device and host_to_device[r.h] != r.device_id:
            host_to_device[r.h] = None  # ambiguous — hostname isn't DB-unique
        else:
            host_to_device[r.h] = r.device_id

    def _down_parent_for_ip(ip: Optional[str]) -> Optional[uuid.UUID]:
        if not ip:
            return None
        did = ip_to_device.get(ip)
        return down_devices[did][0] if did in down_devices else None

    # OSPF: one alert per device, so device-level (device_id, 'ospf_state') keying is precise.
    ospf_rows = (await db.execute(text("""
        SELECT n.device_id::text AS device_id, host(n.neighbor_ip) AS neighbor_ip,
               host(n.neighbor_router_id) AS neighbor_router_id
          FROM ospf_neighbors n JOIN devices d ON d.id = n.device_id
         WHERE d.tenant_id = CAST(:tid AS uuid)
           AND n.state NOT IN ('full','unknown')
           AND n.updated_at > NOW() - INTERVAL '5 minutes'
    """), {"tid": tenant_id})).fetchall()
    for r in ospf_rows:
        if r.device_id in down_devices:
            continue  # a device that's itself down isn't reattributed by its own peer view
        parent = _down_parent_for_ip(r.neighbor_ip) or _down_parent_for_ip(r.neighbor_router_id)
        if parent:
            sm.peer_metric_parent[(r.device_id, "ospf_state")] = parent

    # IS-IS: IP match first, hostname fallback (vendors that don't populate sys_id/IP).
    isis_rows = (await db.execute(text("""
        SELECT n.device_id::text AS device_id, host(n.ipv4_address) AS ipv4_address,
               host(n.ipv6_address) AS ipv6_address, n.hostname AS hostname
          FROM isis_neighbors n JOIN devices d ON d.id = n.device_id
         WHERE d.tenant_id = CAST(:tid AS uuid)
           AND n.adjacency_state NOT IN ('up','unknown')
           AND n.updated_at > NOW() - INTERVAL '5 minutes'
    """), {"tid": tenant_id})).fetchall()
    for r in isis_rows:
        if r.device_id in down_devices:
            continue
        parent = (
            _down_parent_for_ip(r.ipv4_address)
            or _down_parent_for_ip(r.ipv6_address)
        )
        if parent is None and r.hostname:
            host_did = host_to_device.get(r.hostname.lower())
            if host_did in down_devices:
                parent = down_devices[host_did][0]
        if parent:
            sm.peer_metric_parent[(r.device_id, "isis_state")] = parent

    # BGP: per-session keying (a device can have multiple concurrently-broken peers).
    bgp_rows = (await db.execute(text("""
        SELECT s.device_id::text AS device_id, host(s.peer_ip) AS peer_ip,
               s.peer_router_id AS peer_router_id
          FROM bgp_sessions s JOIN devices d ON d.id = s.device_id
         WHERE d.tenant_id = CAST(:tid AS uuid)
           AND s.admin_status = 'start' AND s.session_state NOT IN ('established','unknown')
           AND s.updated_at > NOW() - INTERVAL '5 minutes'
    """), {"tid": tenant_id})).fetchall()
    for r in bgp_rows:
        if r.device_id in down_devices:
            continue
        parent = _down_parent_for_ip(r.peer_ip) or _down_parent_for_ip(r.peer_router_id)
        if parent:
            sm.peer_session_parent[(r.device_id, "bgp_session_down", r.peer_ip)] = parent

    return sm


async def _apply_collector_offline_rule(
    db: AsyncSession, tenant_id: str, sm: SuppressionMap
) -> None:
    """Tier-0: an active collector_offline alert is a more fundamental root
    cause than any individual device's own device_down — every device managed
    by that collector (including the leader device eval_collector_offline
    happens to anchor the alert on) has both device_down_parent and
    other_alerts_parent attributed here, mutating `sm` in place before Rules
    1-3 run.

    Note: eval_device_down already independently suppresses creating a
    device_down breach at all for a device whose collector is offline (see
    evaluators.py:eval_device_down), so in steady state there is usually
    nothing left for this rule to reattribute — it mainly guards the
    transient window right as a collector goes offline (a device_down alert
    that already existed before the outage began) and non-device_down alerts
    on collector-managed devices that predate the outage.
    """
    rows = (await db.execute(text("""
        SELECT a.id AS alert_id, a.context->>'collector_id' AS collector_id
          FROM alerts a
          JOIN alert_rules ar ON ar.id = a.rule_id
         WHERE a.tenant_id = CAST(:tid AS uuid)
           AND ar.metric = 'collector_offline'
           AND a.status IN ('open','acknowledged','suppressed')
    """), {"tid": tenant_id})).fetchall()
    for r in rows:
        if not r.collector_id:
            continue
        siblings = (await db.execute(text(
            "SELECT id::text FROM devices WHERE tenant_id = CAST(:tid AS uuid) "
            "  AND collector_id = CAST(:cid AS uuid)"
        ), {"tid": tenant_id, "cid": r.collector_id})).scalars().all()
        for did in siblings:
            sm.device_down_parent[did] = r.alert_id
            sm.other_alerts_parent[did] = r.alert_id
