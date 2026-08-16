"""SNMP OID -> human-readable name resolution for trap/varbind display.

The host's net-snmp MIB installation is incomplete (missing core
SNMPv2-SMI/TC/CONF modules, so even `snmptranslate` can't resolve standard
OIDs) and vendor MIB files aren't bundled with the repo. Rather than depend
on either, this is a small, self-contained dictionary covering the OIDs that
actually show up in trap_events: standard IF-MIB/BRIDGE-MIB/Q-BRIDGE-MIB
table columns (varbinds on linkUp/linkDown/MAC-table traps) and the
ARISTA-BRIDGE-EXT-MIB notifications emitted by the lab's Arista switches.
"""

from __future__ import annotations

from typing import Optional

# Exact-match OIDs: notifications and scalars (no instance index appended).
_EXACT: dict[str, str] = {
    # SNMPv2-MIB standard traps (snmpTrapOID values)
    "1.3.6.1.6.3.1.1.5.1": "coldStart",
    "1.3.6.1.6.3.1.1.5.2": "warmStart",
    "1.3.6.1.6.3.1.1.5.3": "linkDown",
    "1.3.6.1.6.3.1.1.5.4": "linkUp",
    "1.3.6.1.6.3.1.1.5.5": "authenticationFailure",
    "1.3.6.1.6.3.1.1.5.6": "egpNeighborLoss",
    # SNMPv2-MIB — always present alongside a v1-originated trap (snmptrapd's
    # v1->v2c normalisation carries the original enterprise OID here).
    "1.3.6.1.6.3.1.1.4.3.0": "snmpTrapEnterprise",

    # ARISTA-BRIDGE-EXT-MIB (aristaMibs.2 = 1.3.6.1.4.1.30065.3.2) notifications
    "1.3.6.1.4.1.30065.3.2.0.1": "aristaMacMove",
    "1.3.6.1.4.1.30065.3.2.0.2": "aristaMacLearn",
    "1.3.6.1.4.1.30065.3.2.0.3": "aristaMacAge",

    # OSPF-MIB (RFC 1850) ospfGeneralGroup scalar
    "1.3.6.1.2.1.14.1.1": "ospfRouterId",

    # ENTITY-MIB (RFC 4133) scalar
    "1.3.6.1.2.1.47.1.4.1.0": "entLastChangeTime",
}

# Table-column prefixes: the resolved name has the OID's trailing instance
# index (everything after the prefix) appended, e.g.
# "1.3.6.1.2.1.17.7.1.2.2.1.2.20.80.0.0.1.0.3" -> "dot1qTpFdbPort.20.80.0.0.1.0.3".
_COLUMNS: list[tuple[str, str]] = [
    # Q-BRIDGE-MIB dot1qTpFdbTable (instance = dot1qFdbId.MACaddress, 7 sub-ids)
    ("1.3.6.1.2.1.17.7.1.2.2.1.1", "dot1qTpFdbAddress"),
    ("1.3.6.1.2.1.17.7.1.2.2.1.2", "dot1qTpFdbPort"),
    ("1.3.6.1.2.1.17.7.1.2.2.1.3", "dot1qTpFdbStatus"),

    # BRIDGE-MIB dot1dTpFdbTable (instance = MACaddress, 6 sub-ids)
    ("1.3.6.1.2.1.17.4.3.1.1", "dot1dTpFdbAddress"),
    ("1.3.6.1.2.1.17.4.3.1.2", "dot1dTpFdbPort"),
    ("1.3.6.1.2.1.17.4.3.1.3", "dot1dTpFdbStatus"),

    # IF-MIB ifTable / ifXTable (instance = ifIndex, 1 sub-id)
    ("1.3.6.1.2.1.2.2.1.1",    "ifIndex"),
    ("1.3.6.1.2.1.2.2.1.2",    "ifDescr"),
    ("1.3.6.1.2.1.2.2.1.3",    "ifType"),
    ("1.3.6.1.2.1.2.2.1.7",    "ifAdminStatus"),
    ("1.3.6.1.2.1.2.2.1.8",    "ifOperStatus"),
    ("1.3.6.1.2.1.31.1.1.1.1", "ifName"),
    ("1.3.6.1.2.1.31.1.1.1.18", "ifAlias"),

    # BGP4-MIB (RFC 4273) bgpPeerTable (instance = peer IP, 4 sub-ids)
    ("1.3.6.1.2.1.15.3.1.1",  "bgpPeerIdentifier"),
    ("1.3.6.1.2.1.15.3.1.2",  "bgpPeerState"),
    ("1.3.6.1.2.1.15.3.1.3",  "bgpPeerAdminStatus"),
    ("1.3.6.1.2.1.15.3.1.7",  "bgpPeerRemoteAddr"),
    ("1.3.6.1.2.1.15.3.1.14", "bgpPeerLastError"),

    # OSPF-MIB (RFC 1850) ospfLsdbTable (instance = areaId.lsType.lsId.routerId)
    ("1.3.6.1.2.1.14.4.1.1", "ospfLsdbAreaId"),
    ("1.3.6.1.2.1.14.4.1.2", "ospfLsdbType"),
    ("1.3.6.1.2.1.14.4.1.3", "ospfLsdbLsid"),
    ("1.3.6.1.2.1.14.4.1.4", "ospfLsdbRouterId"),

    # OSPF-MIB ospfIfTable (instance = ospfIfIpAddress.ospfAddressLessIf)
    ("1.3.6.1.2.1.14.7.1.1",  "ospfIfIpAddress"),
    ("1.3.6.1.2.1.14.7.1.2",  "ospfAddressLessIf"),
    ("1.3.6.1.2.1.14.7.1.12", "ospfIfState"),

    # OSPF-MIB ospfNbrTable (instance = ospfNbrIpAddr.ospfNbrAddressLessIndex)
    ("1.3.6.1.2.1.14.10.1.1", "ospfNbrIpAddr"),
    ("1.3.6.1.2.1.14.10.1.2", "ospfNbrAddressLessIndex"),
    ("1.3.6.1.2.1.14.10.1.3", "ospfNbrRtrId"),
    ("1.3.6.1.2.1.14.10.1.6", "ospfNbrState"),

    # RMON-MIB (RFC 2819) eventTable — carried by Aruba CX's generic RMON
    # event notification (ARUBAWIRED-MGMD-RMON-TRAP-MIB), e.g. an
    # audit-log-buffer-wrapped event.
    ("1.3.6.1.2.1.16.9.1.1.1", "eventIndex"),
    ("1.3.6.1.2.1.16.9.1.1.2", "eventDescription"),

    # ENTITY-MIB (RFC 4133) entPhysicalTable (instance = entPhysicalIndex)
    ("1.3.6.1.2.1.47.1.1.1.1.2", "entPhysicalDescr"),

    # LLDP-MIB (IEEE 802.1AB) lldpStatistics scalars — no instance suffix in
    # practice (always ".0"), kept as a column entry so the ".0" still shows.
    ("1.0.8802.1.1.2.1.2.2", "lldpStatsRemTablesInserts"),
    ("1.0.8802.1.1.2.1.2.3", "lldpStatsRemTablesDeletes"),
    ("1.0.8802.1.1.2.1.2.4", "lldpStatsRemTablesDrops"),
    ("1.0.8802.1.1.2.1.2.5", "lldpStatsRemTablesAgeouts"),

    # TCP-MIB (RFC 4022) tcpConnTable (instance = localAddr.localPort.remAddr.remPort)
    ("1.3.6.1.2.1.6.13.1.1", "tcpConnState"),

    # ISIS-MIB (RFC 4444) isisNotificationEntry — varbinds carried on IS-IS
    # notifications (isisAdjacencyChange uses columns 1, 2, 3, 12; other IS-IS
    # notifications can carry column 4).
    ("1.3.6.1.2.1.138.1.10.1.1",  "isisNotificationSysLevelIndex"),
    ("1.3.6.1.2.1.138.1.10.1.2",  "isisNotificationCircIfIndex"),
    ("1.3.6.1.2.1.138.1.10.1.3",  "isisPduLspId"),
    ("1.3.6.1.2.1.138.1.10.1.4",  "isisPduFragment"),
    ("1.3.6.1.2.1.138.1.10.1.12", "isisAdjState"),

    # ARISTA-BGP4V2-MIB peer table (instance = peer IP) — varbinds on
    # bgp.established/backwardTransition when sent via Arista's BGP4V2 MIB.
    ("1.3.6.1.4.1.30065.4.1.1.2.1.6",  "aristaBgp4V2PeerLocalPort"),
    ("1.3.6.1.4.1.30065.4.1.1.2.1.9",  "aristaBgp4V2PeerRemotePort"),
    ("1.3.6.1.4.1.30065.4.1.1.2.1.13", "aristaBgp4V2PeerState"),
    ("1.3.6.1.4.1.30065.4.1.1.2.1.14", "aristaBgp4V2PeerDescription"),
    # ARISTA-BGP4V2-MIB NLRI (route) table
    ("1.3.6.1.4.1.30065.4.1.1.3.1.1", "aristaBgp4V2NlriIndex"),
    ("1.3.6.1.4.1.30065.4.1.1.3.1.2", "aristaBgp4V2NlriAfi"),
    ("1.3.6.1.4.1.30065.4.1.1.3.1.4", "aristaBgp4V2NlriPrefixType"),
    ("1.3.6.1.4.1.30065.4.1.1.3.1.6", "aristaBgp4V2NlriPrefixLen"),
    ("1.3.6.1.4.1.30065.4.1.1.3.1.7", "aristaBgp4V2NlriBest"),
    ("1.3.6.1.4.1.30065.4.1.1.3.1.9", "aristaBgp4V2NlriOrigin"),

    # ARISTA-SNMP-TRANSPORTS-MIB — varbinds Arista adds to a standard
    # authenticationFailure trap identifying the offending request's source.
    ("1.3.6.1.4.1.30065.3.10.5.1", "aristaAuthFailTrapTDomain"),
    ("1.3.6.1.4.1.30065.3.10.5.2", "aristaAuthFailTrapSrcTAddress"),

    # OLD-CISCO-TS-MIB — varbinds on the legacy cisco.tcpConnectionClose trap
    ("1.3.6.1.4.1.9.2.9.3.1.1", "tslineSesType"),
    ("1.3.6.1.4.1.9.2.9.2.1.18", "tsLineUser"),

    # CISCO-CONFIG-MAN-MIB ccmHistoryEventTable
    ("1.3.6.1.4.1.9.9.43.1.1.6.1.3", "ccmHistoryEventCommandSource"),
    ("1.3.6.1.4.1.9.9.43.1.1.6.1.4", "ccmHistoryEventConfigSource"),
    ("1.3.6.1.4.1.9.9.43.1.1.6.1.5", "ccmHistoryEventConfigDestination"),

    # CISCO-SYSLOG-MIB clogHistoryTable — carried on cisco.syslogMessage
    ("1.3.6.1.4.1.9.9.41.1.2.3.1.2", "clogHistFacility"),
    ("1.3.6.1.4.1.9.9.41.1.2.3.1.3", "clogHistSeverity"),
    ("1.3.6.1.4.1.9.9.41.1.2.3.1.4", "clogHistMsgName"),
    ("1.3.6.1.4.1.9.9.41.1.2.3.1.5", "clogHistMsgText"),
    ("1.3.6.1.4.1.9.9.41.1.2.3.1.6", "clogHistTimestamp"),

    # CISCO-RF-MIB scalars — carried on cisco.rfProgression/cisco.rfSwitchover
    ("1.3.6.1.4.1.9.9.176.1.1.1.0", "cRFStatusUnitId"),
    ("1.3.6.1.4.1.9.9.176.1.1.2.0", "cRFStatusUnitState"),
    ("1.3.6.1.4.1.9.9.176.1.1.3.0", "cRFStatusPeerUnitId"),
    ("1.3.6.1.4.1.9.9.176.1.1.4.0", "cRFStatusPeerUnitState"),

    # CISCO-SNMP-TARGET-EXT-MIB — source of a non-authentic SNMP request
    ("1.3.6.1.4.1.9.9.412.1.1.1.0", "cExtSnmpTargetAuthInetType"),
    ("1.3.6.1.4.1.9.9.412.1.1.2.0", "cExtSnmpTargetAuthInetAddr"),

    # CISCO-BGP4-MIB cbgpPeer2Table (instance = peer address type/address)
    ("1.3.6.1.4.1.9.9.187.1.2.5.1.3",  "cbgpPeer2State"),
    ("1.3.6.1.4.1.9.9.187.1.2.5.1.17", "cbgpPeer2LastError"),
    ("1.3.6.1.4.1.9.9.187.1.2.5.1.28", "cbgpPeer2LastErrorTxt"),
    ("1.3.6.1.4.1.9.9.187.1.2.5.1.29", "cbgpPeer2PrevState"),
    # CISCO-BGP4-MIB legacy cbgpPeerTable (instance = peer IP)
    ("1.3.6.1.4.1.9.9.187.1.2.1.1.7", "cbgpPeerLastErrorTxt"),
    ("1.3.6.1.4.1.9.9.187.1.2.1.1.8", "cbgpPeerPrevState"),

    # MPLS-LSR-MIB (RFC 3813) mplsInterfaceTable
    ("1.3.6.1.2.1.131.1.1.1.2", "mplsInterfaceLabelMinIn"),
    ("1.3.6.1.2.1.131.1.1.1.5", "mplsInterfaceLabelMaxOut"),
]


def resolve_oid(oid: Optional[str]) -> Optional[str]:
    """Return a human-readable name for `oid`, or None if unrecognized.

    For table columns, the name includes the OID's trailing instance index
    (e.g. "dot1qTpFdbPort.20.80.0.0.1.0.3") so the specific row is still
    identifiable.
    """
    if not oid:
        return None
    oid = oid.strip().lstrip(".")

    if oid in _EXACT:
        return _EXACT[oid]

    for prefix, name in _COLUMNS:
        if oid == prefix:
            return name
        if oid.startswith(prefix + "."):
            return name + oid[len(prefix):]

    return None


# Coded-integer columns where the raw SNMP value is an enum, not a number
# anyone would recognize on sight. Keyed by the base column name from
# _COLUMNS/_EXACT (i.e. the part before any trailing instance index) so a
# lookup works the same way for a scalar ("ifAdminStatus") or a table row
# ("ifAdminStatus.574").
_VALUE_ENUMS: dict[str, dict[str, str]] = {
    # IF-MIB ifAdminStatus / ifOperStatus (RFC 2863)
    "ifAdminStatus": {"1": "up", "2": "down", "3": "testing"},
    "ifOperStatus": {
        "1": "up", "2": "down", "3": "testing", "4": "unknown",
        "5": "dormant", "6": "notPresent", "7": "lowerLayerDown",
    },
    # BRIDGE-MIB / Q-BRIDGE-MIB dot1{d,q}TpFdbStatus (RFC 1493 / 4363)
    "dot1dTpFdbStatus": {"1": "other", "2": "invalid", "3": "learned", "4": "self", "5": "mgmt"},
    "dot1qTpFdbStatus": {"1": "other", "2": "invalid", "3": "learned", "4": "self", "5": "mgmt"},

    # BGP4-MIB (RFC 4273)
    "bgpPeerState": {
        "1": "idle", "2": "connect", "3": "active", "4": "opensent",
        "5": "openconfirm", "6": "established",
    },
    "bgpPeerAdminStatus": {"1": "stop", "2": "start"},

    # OSPF-MIB (RFC 1850)
    "ospfLsdbType": {
        "1": "routerLink", "2": "networkLink", "3": "summaryLink",
        "4": "asSummaryLink", "5": "asExternalLink",
    },
    "ospfIfState": {
        "1": "down", "2": "loopback", "3": "waiting", "4": "pointToPoint",
        "5": "designatedRouter", "6": "backupDesignatedRouter", "7": "otherDesignatedRouter",
    },
    "ospfNbrState": {
        "1": "down", "2": "attempt", "3": "init", "4": "twoWay",
        "5": "exchangeStart", "6": "exchange", "7": "loading", "8": "full",
    },

    # ISIS-MIB (RFC 4444)
    "isisNotificationSysLevelIndex": {"1": "level1", "2": "level2", "3": "level1and2"},
    "isisAdjState": {"1": "down", "2": "initializing", "3": "up", "4": "failed"},

    # TCP-MIB (RFC 4022)
    "tcpConnState": {
        "1": "closed", "2": "listen", "3": "synSent", "4": "synReceived",
        "5": "established", "6": "finWait1", "7": "finWait2", "8": "closeWait",
        "9": "lastAck", "10": "closing", "11": "timeWait", "12": "deleteTCB",
    },

    # ARISTA-BGP4V2-MIB / CISCO-BGP4-MIB — same six-state BGP FSM as
    # bgpPeerState (RFC 4273), just under each vendor's own MIB.
    "aristaBgp4V2PeerState": {
        "1": "idle", "2": "connect", "3": "active", "4": "opensent",
        "5": "openconfirm", "6": "established",
    },
    "cbgpPeer2State": {
        "1": "idle", "2": "connect", "3": "active", "4": "opensent",
        "5": "openconfirm", "6": "established",
    },
    "cbgpPeer2PrevState": {
        "1": "idle", "2": "connect", "3": "active", "4": "opensent",
        "5": "openconfirm", "6": "established",
    },
    "cbgpPeerPrevState": {
        "1": "idle", "2": "connect", "3": "active", "4": "opensent",
        "5": "openconfirm", "6": "established",
    },

    # CISCO-SYSLOG-MIB clogHistSeverity — standard syslog severity (0-7),
    # shifted by one (Cisco's SNMP-Notification-Severity TC starts at 1).
    "clogHistSeverity": {
        "1": "emergency", "2": "alert", "3": "critical", "4": "error",
        "5": "warning", "6": "notice", "7": "informational", "8": "debug",
    },
}


def resolve_value(name: Optional[str], value: object) -> Optional[str]:
    """Return a decoded label for `value` if `name` is a known coded-enum
    column (e.g. ifOperStatus "2" -> "down"), or None if there's no decode
    table for this column or the value isn't in it."""
    if not name:
        return None
    base = name.split(".", 1)[0]
    enum = _VALUE_ENUMS.get(base)
    if not enum:
        return None
    return enum.get(str(value).strip())


def enrich_varbind(varbind: dict) -> dict:
    """Return a copy of `varbind` with resolved `name`/`value_name`/`message`
    keys added, alongside the untouched original `oid`/`type`/`value`.

    `name` and `value_name` are None when the OID or value isn't in the
    catalog yet — `message` still renders a readable line in that case (using
    the raw OID/value), it just can't say what it *means*. See the
    "SNMP Trap & Varbind Catalog Reference" wiki article for how to add an
    entry once you've identified an uncatalogued one.
    """
    oid   = varbind.get("oid")
    value = varbind.get("value")
    name  = resolve_oid(oid)
    value_name = resolve_value(name, value)

    if name and value_name:
        message = f"{name} = {value_name} ({value})"
    elif name:
        message = f"{name} = {value}"
    else:
        message = f"OID {oid} = {value}"

    return {**varbind, "name": name, "value_name": value_name, "message": message}
