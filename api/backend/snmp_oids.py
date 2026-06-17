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

    # ARISTA-BRIDGE-EXT-MIB (aristaMibs.2 = 1.3.6.1.4.1.30065.3.2) notifications
    "1.3.6.1.4.1.30065.3.2.0.1": "aristaMacMove",
    "1.3.6.1.4.1.30065.3.2.0.2": "aristaMacLearn",
    "1.3.6.1.4.1.30065.3.2.0.3": "aristaMacAge",
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


def enrich_varbind(varbind: dict) -> dict:
    """Return a copy of `varbind` with a resolved `name` key added."""
    return {**varbind, "name": resolve_oid(varbind.get("oid"))}
