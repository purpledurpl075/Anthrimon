package poller

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/gosnmp/gosnmp"
	"github.com/google/uuid"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/client"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/model"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/oid"
)

// PollBGPSessions walks bgpPeerTable (RFC 1657) and returns one BGPSession per peer.
// Also reads bgpLocalAs (scalar) to populate LocalASN on each row.
func PollBGPSessions(s *client.Session, deviceID uuid.UUID) ([]*model.BGPSession, error) {
	// Read local AS number first (scalar).
	localASN := int64(0)
	localASRow, err := s.Get([]string{oid.BGPLocalAs})
	if err == nil && len(localASRow) > 0 {
		localASN = int64(client.PDUUint64(localASRow[0]))
	}

	// Walk the entire bgpPeerTable subtree.
	pdus, err := s.BulkWalkAll(oid.BGPPeerTable)
	if err != nil || len(pdus) == 0 {
		return nil, err
	}

	type row struct {
		routerID        string
		state           int
		adminStatus     int
		remoteASN       int64
		inUpdates       int64
		outUpdates      int64
		fsmTrans        int64  // bgpPeerFsmEstablishedTransitions
		established     uint32 // value from col 16
		establishedTicks bool  // true = TimeTicks (subtract from sysUpTime), false = Gauge32 seconds
		prefixesRx      int
		holdTime        int
	}

	rows := make(map[string]*row)
	ensure := func(ip string) *row {
		if r, ok := rows[ip]; ok {
			return r
		}
		r := &row{}
		rows[ip] = r
		return r
	}

	for _, pdu := range pdus {
		col, peerIP, ok := bgpParseIndex(pdu.Name)
		if !ok || peerIP == "" {
			continue
		}
		r := ensure(peerIP)
		switch col {
		case 1: // bgpPeerIdentifier
			r.routerID = bgpIPFromPDU(pdu)
		case 2: // bgpPeerState
			r.state = client.PDUInt(pdu)
		case 3: // bgpPeerAdminStatus
			r.adminStatus = client.PDUInt(pdu)
		case 7: // bgpPeerInUpdates
			r.inUpdates = int64(client.PDUUint64(pdu))
		case 8: // bgpPeerOutUpdates
			r.outUpdates = int64(client.PDUUint64(pdu))
		case 9: // bgpPeerRemoteAs
			r.remoteASN = int64(client.PDUUint64(pdu))
		case 11: // bgpPeerInPrefixes (col 11 in some implementations)
			r.prefixesRx = client.PDUInt(pdu)
		case 15: // bgpPeerFsmEstablishedTransitions — flap counter
			r.fsmTrans = int64(client.PDUUint64(pdu))
		case 16: // bgpPeerFsmEstablishedTime
			// RFC 1657: Gauge32 in seconds (duration since established).
			// Some vendors (Cisco IOS) return TimeTicks (sysUpTime when established) instead.
			if v, ok := pdu.Value.(uint32); ok {
				r.established      = v
				r.establishedTicks = pdu.Type == gosnmp.TimeTicks
			}
		case 19: // bgpPeerHoldTime
			r.holdTime = client.PDUInt(pdu)
		}
	}

	// Fetch current sysUpTime to compute uptime from ticks.
	sysUpTime := uint32(0)
	upRow, err := s.Get([]string{"1.3.6.1.2.1.1.3.0"})
	if err == nil && len(upRow) > 0 {
		if v, ok := upRow[0].Value.(uint32); ok {
			sysUpTime = v
		}
	}

	results := make([]*model.BGPSession, 0, len(rows))
	for peerIP, r := range rows {
		// Skip rows where we got no useful data.
		if r.state == 0 && r.remoteASN == 0 {
			continue
		}

		uptimeSecs := int64(0)
		if r.state == 6 && r.established > 0 {
			if r.establishedTicks {
				// Cisco-style: TimeTicks = sysUpTime value when session became established
				if sysUpTime >= r.established {
					uptimeSecs = int64((sysUpTime - r.established) / 100)
				}
			} else {
				// RFC 1657: Gauge32 already in seconds
				uptimeSecs = int64(r.established)
			}
		}

		results = append(results, &model.BGPSession{
			DeviceID:         deviceID,
			PeerIP:           peerIP,
			PeerRouterID:     r.routerID,
			LocalASN:         localASN,
			RemoteASN:        r.remoteASN,
			State:            bgpStateName(r.state),
			AdminStatus:      bgpAdminStatus(r.adminStatus),
			UptimeSeconds:    uptimeSecs,
			InUpdates:        r.inUpdates,
			OutUpdates:       r.outUpdates,
			FlapCount:        r.fsmTrans,
			PrefixesReceived: r.prefixesRx,
		})
	}
	return results, nil
}

// bgpParseIndex extracts the column number and peer IP from a bgpPeerTable PDU name.
// OID format: 1.3.6.1.2.1.15.3.1.<col>.<a>.<b>.<c>.<d>
func bgpParseIndex(pduName string) (col int, peerIP string, ok bool) {
	base := strings.TrimPrefix(oid.BGPPeerTable, ".")
	full := strings.TrimPrefix(pduName, ".")
	if !strings.HasPrefix(full, base+".") {
		return 0, "", false
	}
	parts := strings.Split(full[len(base)+1:], ".")
	if len(parts) < 5 {
		return 0, "", false
	}
	c, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, "", false
	}
	ip := strings.Join(parts[1:5], ".")
	return c, ip, true
}

// bgpIPFromPDU extracts a dotted-decimal IPv4 from a BGP OID value.
func bgpIPFromPDU(pdu gosnmp.SnmpPDU) string {
	switch v := pdu.Value.(type) {
	case []byte:
		if len(v) == 4 {
			return fmt.Sprintf("%d.%d.%d.%d", v[0], v[1], v[2], v[3])
		}
	case string:
		return strings.TrimSpace(v)
	}
	return ""
}

func bgpStateName(v int) string {
	switch v {
	case 1:
		return "idle"
	case 2:
		return "connect"
	case 3:
		return "active"
	case 4:
		return "opensent"
	case 5:
		return "openconfirm"
	case 6:
		return "established"
	default:
		return "unknown"
	}
}

func bgpAdminStatus(v int) string {
	if v == 1 {
		return "stop"
	}
	return "start"
}
