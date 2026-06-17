"""Human-readable catalog of SNMP trap types for the Traps UI.

The keys here are `trap_type` values as produced by `resolveTrapType()` in
collectors/remote/cmd/trap-handler/main.go — that function is the single
source of truth for what strings can land in trap_events.trap_type. Every
named trap there has a corresponding entry below; every vendor's generic
"*.trap" fallback (plus the catch-all "unknown") is also covered so that any
*future* trap type — one this dict has never seen — still resolves to a
sensible, human-readable description via describe_trap()'s fallback.

is_cataloged=False marks generic fallback entries. The Traps UI uses this to
flag "uncatalogued" trap types so admins know which OIDs are worth adding a
specific entry for here.
"""

from __future__ import annotations

from typing import TypedDict


class TrapCatalogEntry(TypedDict):
    label: str
    description: str
    category: str
    is_cataloged: bool


_GENERIC = (
    "Generic {vendor} SNMP notification — this specific trap type hasn't been "
    "individually cataloged yet. Check the OID against the vendor's MIBs to "
    "add a tailored description."
)

TRAP_CATALOG: dict[str, TrapCatalogEntry] = {
    # ── Standard SNMPv2-MIB traps ───────────────────────────────────────────
    "coldStart": {
        "label": "Cold Start",
        "description": "The device's SNMP agent (re)initialized from a power-off or full "
                        "reboot. Expected after a planned reboot or firmware upgrade — "
                        "unexpected occurrences may indicate a crash or power loss.",
        "category": "standard",
        "is_cataloged": True,
    },
    "warmStart": {
        "label": "Warm Start",
        "description": "The device's SNMP agent reinitialized without a full power cycle "
                        "(e.g. a software restart or config reload). Usually benign, but "
                        "worth correlating with recent config-management activity.",
        "category": "standard",
        "is_cataloged": True,
    },
    "linkDown": {
        "label": "Interface Link Down",
        "description": "An interface transitioned to the down state. Usually a physical "
                        "link failure, unplugged cable, or the remote end shutting the "
                        "interface down — check interface status and recent topology changes.",
        "category": "standard",
        "is_cataloged": True,
    },
    "linkUp": {
        "label": "Interface Link Up",
        "description": "An interface transitioned to the up state. Informational under "
                        "normal operation; frequent linkDown/linkUp pairs on the same "
                        "interface indicate a flapping link.",
        "category": "standard",
        "is_cataloged": True,
    },
    "authenticationFailure": {
        "label": "SNMP Authentication Failure",
        "description": "The device rejected an SNMP request with an invalid community "
                        "string or SNMPv3 credentials. Repeated occurrences may indicate "
                        "a misconfigured poller or an unauthorized access attempt.",
        "category": "standard",
        "is_cataloged": True,
    },
    "egpNeighborLoss": {
        "label": "EGP Neighbor Loss",
        "description": "An Exterior Gateway Protocol neighbor relationship was lost. EGP "
                        "is largely obsolete, but some platforms still emit this trap for "
                        "general exterior-routing neighbor-down events.",
        "category": "standard",
        "is_cataloged": True,
    },

    # ── BGP4-MIB traps ───────────────────────────────────────────────────────
    "bgp.backwardTransition": {
        "label": "BGP Backward Transition",
        "description": "A BGP peer moved to a less-established state (e.g. Established → "
                        "Idle). This is the primary signal for a BGP session drop or flap "
                        "— check the peer's reachability and recent config changes.",
        "category": "bgp",
        "is_cataloged": True,
    },
    "bgp.established": {
        "label": "BGP Session Established",
        "description": "A BGP peering session came up. Informational under normal "
                        "operation; if it follows a recent bgp.backwardTransition, the "
                        "session was flapping and just recovered.",
        "category": "bgp",
        "is_cataloged": True,
    },

    # ── OSPF-MIB traps ───────────────────────────────────────────────────────
    "ospf.authFailure": {
        "label": "OSPF Authentication Failure",
        "description": "An OSPF packet failed authentication on an interface. Often "
                        "caused by a mismatched authentication key/type with a neighbor — "
                        "check OSPF interface auth config on both ends.",
        "category": "ospf",
        "is_cataloged": True,
    },
    "ospf.virtAuthFailure": {
        "label": "OSPF Virtual Link Authentication Failure",
        "description": "An OSPF packet failed authentication on a virtual link. Check "
                        "the virtual-link authentication configuration on both endpoint "
                        "routers.",
        "category": "ospf",
        "is_cataloged": True,
    },
    "ospf.lsdbOverflow": {
        "label": "OSPF Link-State Database Overflow",
        "description": "The OSPF link-state database exceeded its configured maximum "
                        "size. This can cause route instability — investigate the source "
                        "of excessive LSA generation in the area.",
        "category": "ospf",
        "is_cataloged": True,
    },
    "ospf.lsdbApproachingOverflow": {
        "label": "OSPF LSDB Approaching Overflow",
        "description": "The OSPF link-state database is nearing its configured maximum "
                        "size. Early warning before ospf.lsdbOverflow — investigate LSA "
                        "growth before it becomes critical.",
        "category": "ospf",
        "is_cataloged": True,
    },
    "ospf.nbrStateChange": {
        "label": "OSPF Neighbor State Change",
        "description": "An OSPF neighbor relationship changed state (e.g. Full → Down). "
                        "A transition to/from Full indicates an adjacency was lost or "
                        "formed — check the neighbor's reachability.",
        "category": "ospf",
        "is_cataloged": True,
    },
    "ospf.virtNbrStateChange": {
        "label": "OSPF Virtual Neighbor State Change",
        "description": "An OSPF neighbor relationship over a virtual link changed state. "
                        "Check connectivity across the transit area used by the virtual link.",
        "category": "ospf",
        "is_cataloged": True,
    },
    "ospf.ifStateChange": {
        "label": "OSPF Interface State Change",
        "description": "An OSPF-enabled interface changed state (e.g. DR election "
                        "result, or the interface going down). Correlate with the "
                        "interface's link status.",
        "category": "ospf",
        "is_cataloged": True,
    },
    "ospf.virtIfStateChange": {
        "label": "OSPF Virtual Interface State Change",
        "description": "The state of an OSPF virtual link's local interface changed. "
                        "Check the underlying transit-area path for the virtual link.",
        "category": "ospf",
        "is_cataloged": True,
    },
    "ospf.trap": {
        "label": "OSPF Notification",
        "description": _GENERIC.format(vendor="OSPF"),
        "category": "ospf",
        "is_cataloged": False,
    },

    # ── ISIS-MIB traps ───────────────────────────────────────────────────────
    "isis.databaseOverload": {
        "label": "IS-IS Database Overload",
        "description": "An IS-IS router set its Link State Database overload bit, "
                        "meaning it will be excluded from transit paths until cleared. "
                        "Often caused by hitting a memory or LSP limit.",
        "category": "isis",
        "is_cataloged": True,
    },
    "isis.corruptedLSP": {
        "label": "IS-IS Corrupted LSP",
        "description": "IS-IS detected a corrupted Link State PDU in its database "
                        "(checksum/format error). May indicate memory issues on this "
                        "router or a problem on a neighboring router.",
        "category": "isis",
        "is_cataloged": True,
    },
    "isis.adjacencyChange": {
        "label": "IS-IS Adjacency Change",
        "description": "An IS-IS adjacency to a neighbor came up or went down. A drop to "
                        "'down' indicates a lost neighbor relationship — check the link "
                        "and neighbor's IS-IS state.",
        "category": "isis",
        "is_cataloged": True,
    },
    "isis.trap": {
        "label": "IS-IS Notification",
        "description": _GENERIC.format(vendor="IS-IS"),
        "category": "isis",
        "is_cataloged": False,
    },

    # ── MPLS-MIB traps ───────────────────────────────────────────────────────
    "mpls.xcDown": {
        "label": "MPLS Cross-Connect Down",
        "description": "An MPLS label-switched path cross-connect went down. This "
                        "typically breaks an LSP — check the path's constituent links "
                        "and LDP/RSVP-TE sessions.",
        "category": "mpls",
        "is_cataloged": True,
    },
    "mpls.xcUp": {
        "label": "MPLS Cross-Connect Up",
        "description": "An MPLS label-switched path cross-connect came up. "
                        "Informational; confirms an LSP is established.",
        "category": "mpls",
        "is_cataloged": True,
    },
    "mpls.trap": {
        "label": "MPLS Notification",
        "description": _GENERIC.format(vendor="MPLS"),
        "category": "mpls",
        "is_cataloged": False,
    },

    # ── BRIDGE-MIB / STP traps ───────────────────────────────────────────────
    "stp.topologyChange": {
        "label": "Spanning Tree Topology Change",
        "description": "A Spanning Tree topology change was detected — a port "
                        "transitioned in a way that altered the active topology. "
                        "Frequent occurrences indicate flapping links or a loop somewhere "
                        "in the STP domain.",
        "category": "stp",
        "is_cataloged": True,
    },
    "stp.newRoot": {
        "label": "Spanning Tree New Root Bridge",
        "description": "This switch became the Spanning Tree root bridge. Unexpected "
                        "root changes can cause widespread topology recalculation — "
                        "check bridge priorities if this wasn't intentional.",
        "category": "stp",
        "is_cataloged": True,
    },
    "stp.trap": {
        "label": "Spanning Tree Notification",
        "description": _GENERIC.format(vendor="Spanning Tree / Bridge"),
        "category": "stp",
        "is_cataloged": False,
    },

    # ── LLDP-MIB traps ───────────────────────────────────────────────────────
    "lldp.remTablesChange": {
        "label": "LLDP Neighbor Table Change",
        "description": "The LLDP remote-systems table changed — a neighbor was "
                        "discovered, lost, or updated its advertised information. Useful "
                        "for detecting unexpected topology changes or new device "
                        "connections.",
        "category": "lldp",
        "is_cataloged": True,
    },
    "lldp.trap": {
        "label": "LLDP Notification",
        "description": _GENERIC.format(vendor="LLDP"),
        "category": "lldp",
        "is_cataloged": False,
    },

    # ── VRRP-MIB traps ───────────────────────────────────────────────────────
    "vrrp.authFailure": {
        "label": "VRRP Authentication Failure",
        "description": "A VRRP router received a packet that failed authentication. "
                        "Check that VRRP authentication settings match across all "
                        "routers in the virtual router group.",
        "category": "vrrp",
        "is_cataloged": True,
    },
    "vrrp.newMaster": {
        "label": "VRRP New Master",
        "description": "This router became the VRRP master for a virtual router. "
                        "Indicates a failover occurred — check why the previous master "
                        "stopped advertising (link/device failure, priority change).",
        "category": "vrrp",
        "is_cataloged": True,
    },
    "vrrp.trap": {
        "label": "VRRP Notification",
        "description": _GENERIC.format(vendor="VRRP"),
        "category": "vrrp",
        "is_cataloged": False,
    },

    # ── Arista vendor traps ──────────────────────────────────────────────────
    "arista.bgpPeerStateChange": {
        "label": "Arista BGP Peer State Change",
        "description": "An Arista switch reported a BGP peer state change. Check the "
                        "peer's reachability and recent config changes — equivalent to "
                        "bgp.backwardTransition/established but vendor-specific.",
        "category": "arista",
        "is_cataloged": True,
    },
    "arista.linkStateChange": {
        "label": "Arista Link State Change",
        "description": "An Arista switch reported an interface link state change. "
                        "Equivalent to linkUp/linkDown but via Arista's own MIB — check "
                        "interface status.",
        "category": "arista",
        "is_cataloged": True,
    },
    "arista.macMove": {
        "label": "Arista MAC Address Move",
        "description": "A MAC address was learned on a different port than before. "
                        "Normal during topology changes or host migrations; frequent "
                        "moves for the same MAC can indicate a loop or duplicate MAC.",
        "category": "arista",
        "is_cataloged": True,
    },
    "arista.macLearn": {
        "label": "Arista MAC Address Learned",
        "description": "A new MAC address was learned on a port. Informational — "
                        "reflects normal MAC table population as devices communicate.",
        "category": "arista",
        "is_cataloged": True,
    },
    "arista.macAge": {
        "label": "Arista MAC Address Aged Out",
        "description": "A MAC address was removed from the table after its aging "
                        "timer expired (the host stopped sending traffic). Informational "
                        "under normal operation.",
        "category": "arista",
        "is_cataloged": True,
    },
    "arista.trap": {
        "label": "Arista Notification",
        "description": _GENERIC.format(vendor="Arista"),
        "category": "arista",
        "is_cataloged": False,
    },

    # ── Aruba CX vendor traps ────────────────────────────────────────────────
    "aruba_cx.linkStateChange": {
        "label": "Aruba CX Link State Change",
        "description": "An Aruba CX switch reported an interface link state change. "
                        "Equivalent to linkUp/linkDown but via Aruba's own MIB — check "
                        "interface status.",
        "category": "aruba_cx",
        "is_cataloged": True,
    },
    "aruba_cx.trap": {
        "label": "Aruba CX Notification",
        "description": _GENERIC.format(vendor="Aruba CX"),
        "category": "aruba_cx",
        "is_cataloged": False,
    },

    # ── HP vendor traps ──────────────────────────────────────────────────────
    "hp.linkChange": {
        "label": "HP Link Change",
        "description": "An HP/ProCurve device reported an interface link state change. "
                        "Equivalent to linkUp/linkDown but via HP's own MIB — check "
                        "interface status.",
        "category": "hp",
        "is_cataloged": True,
    },
    "hp.trap": {
        "label": "HP Notification",
        "description": _GENERIC.format(vendor="HP/ProCurve"),
        "category": "hp",
        "is_cataloged": False,
    },

    # ── Cisco vendor traps ───────────────────────────────────────────────────
    "cisco.bgpBackwardTransition": {
        "label": "Cisco BGP Backward Transition",
        "description": "A Cisco device reported a BGP peer moving to a less-established "
                        "state. Equivalent to bgp.backwardTransition — check the peer's "
                        "reachability and recent config changes.",
        "category": "cisco",
        "is_cataloged": True,
    },
    "cisco.configChange": {
        "label": "Cisco Configuration Change",
        "description": "The running configuration on a Cisco device changed. Correlate "
                        "with the audit log / config-management history to identify who "
                        "made the change and what was modified.",
        "category": "cisco",
        "is_cataloged": True,
    },
    "cisco.envMonAlert": {
        "label": "Cisco Environmental Alarm",
        "description": "A Cisco environmental monitor alarm fired — power supply, fan, "
                        "or temperature out of range. Investigate hardware health on this "
                        "device immediately; this often precedes a hardware failure.",
        "category": "cisco",
        "is_cataloged": True,
    },
    "cisco.trap": {
        "label": "Cisco Notification",
        "description": _GENERIC.format(vendor="Cisco"),
        "category": "cisco",
        "is_cataloged": False,
    },

    # ── Juniper vendor traps ─────────────────────────────────────────────────
    "juniper.trap": {
        "label": "Juniper Notification",
        "description": _GENERIC.format(vendor="Juniper"),
        "category": "juniper",
        "is_cataloged": False,
    },

    # ── Fallback ─────────────────────────────────────────────────────────────
    "unknown": {
        "label": "Unrecognized Trap",
        "description": "This trap's OID didn't match any known standard or "
                        "vendor-enterprise prefix, so its trap type couldn't be "
                        "determined. Check the raw OID against the originating "
                        "device's vendor MIBs to identify and catalog it.",
        "category": "unknown",
        "is_cataloged": False,
    },
}

_FALLBACK: TrapCatalogEntry = {
    "label": "Unrecognized Trap Type",
    "description": "This trap type isn't in the catalog yet. Check the raw OID against "
                    "the originating device's vendor MIBs to identify and catalog it.",
    "category": "unknown",
    "is_cataloged": False,
}


def describe_trap(trap_type: str) -> TrapCatalogEntry:
    """Look up human-readable catalog info for a trap_type, with a safe default
    for anything not (yet) cataloged."""
    return TRAP_CATALOG.get(trap_type, _FALLBACK)
