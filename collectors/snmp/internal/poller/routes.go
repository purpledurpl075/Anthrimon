package poller

import (
	"fmt"
	"net"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/client"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/model"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/oid"
)

// PollRouteTable tries ipCidrRouteTable (RFC 2096) first.
// If that table is empty — which happens on modern devices like Aruba CX that
// implement only the newer RFC 4292 inetCidrRouteTable — it falls back to
// inetCidrRouteTable automatically.
func PollRouteTable(s *client.Session, deviceID uuid.UUID, ifByIndex map[int]string) ([]*model.RouteEntry, error) {
	results, err := pollRouteTableCidr(s, deviceID, ifByIndex)
	if err == nil && len(results) > 0 {
		log.Info().Str("device_id", deviceID.String()).Int("routes", len(results)).Msg("routes: RFC2096 ipCidrRouteTable")
		return results, nil
	}
	// RFC 2096 empty or errored — try RFC 4292 inetCidrRouteTable
	results, err = pollRouteTableInet(s, deviceID, ifByIndex)
	if err == nil && len(results) > 0 {
		log.Info().Str("device_id", deviceID.String()).Int("routes", len(results)).Msg("routes: RFC4292 inetCidrRouteTable")
		return results, nil
	}
	log.Warn().Str("device_id", deviceID.String()).Msg("routes: both ipCidrRouteTable and inetCidrRouteTable empty")
	return nil, nil
}

// ── RFC 2096: ipCidrRouteTable ────────────────────────────────────────────────

func pollRouteTableCidr(s *client.Session, deviceID uuid.UUID, ifByIndex map[int]string) ([]*model.RouteEntry, error) {
	pdus, err := s.BulkWalkAll(oid.IPCidrRouteTable)
	if err != nil || len(pdus) == 0 {
		return nil, err
	}

	type rowKey struct{ dest, mask, nexthop string }
	type row struct {
		ifIndex   int
		proto     int
		routeType int
		metric    int
	}
	rows := make(map[rowKey]*row)
	ensure := func(k rowKey) *row {
		if r, ok := rows[k]; ok { return r }
		r := &row{}; rows[k] = r; return r
	}

	for _, pdu := range pdus {
		col, dest, mask, nexthop, ok := splitCidrRouteIndex(pdu.Name)
		if !ok { continue }
		k := rowKey{dest, mask, nexthop}
		r := ensure(k)
		switch col {
		case 5: r.ifIndex   = client.PDUInt(pdu)
		case 6: r.routeType = client.PDUInt(pdu)
		case 7: r.proto     = client.PDUInt(pdu)
		case 11: r.metric   = client.PDUInt(pdu)
		}
	}

	results := make([]*model.RouteEntry, 0, len(rows))
	for k, r := range rows {
		proto := cidrProtoName(r.proto)
		if proto == "" || r.routeType == 2 {
			continue
		}
		prefixLen := maskToPrefixLen(k.mask)
		nextHop := k.nexthop
		if nextHop == "0.0.0.0" || proto == "connected" {
			nextHop = ""
		}
		results = append(results, &model.RouteEntry{
			DeviceID:      deviceID,
			Destination:   fmt.Sprintf("%s/%d", k.dest, prefixLen),
			NextHop:       nextHop,
			Protocol:      proto,
			Metric:        r.metric,
			InterfaceName: ifByIndex[r.ifIndex],
		})
	}
	return results, nil
}

// splitCidrRouteIndex parses the ipCidrRouteTable OID index.
// Format: col.a.b.c.d.ma.mb.mc.md.tos.na.nb.nc.nd
func splitCidrRouteIndex(pduName string) (col int, dest, mask, nexthop string, ok bool) {
	full := strings.TrimPrefix(pduName, ".")
	base := strings.TrimPrefix(oid.IPCidrRouteTable, ".")
	if !strings.HasPrefix(full, base+".") {
		return 0, "", "", "", false
	}
	parts := strings.Split(full[len(base)+1:], ".")
	if len(parts) < 14 {
		return 0, "", "", "", false
	}
	c, err := strconv.Atoi(parts[0])
	if err != nil { return 0, "", "", "", false }
	dest    = strings.Join(parts[1:5],   ".")
	mask    = strings.Join(parts[5:9],   ".")
	nexthop = strings.Join(parts[10:14], ".")
	return c, dest, mask, nexthop, true
}

// cidrProtoName maps RFC 2096 ipCidrRouteProto values to protocol strings.
func cidrProtoName(v int) string {
	switch v {
	case 2:  return "connected"
	case 3:  return "static"
	case 8:  return "rip"
	case 9:  return "isis"
	case 13: return "ospf"
	case 14: return "bgp"
	case 16: return "eigrp"
	case 1:  return "other"
	default: return ""
	}
}

// ── RFC 4292: inetCidrRouteTable ─────────────────────────────────────────────
// Used by Aruba CX, modern Juniper, newer IOS-XE, etc.
// Index: destType.destLen.a.b.c.d.pfxLen.policyOID.nhType.nhLen.n.m.o.p
// Protocol uses IANAipRouteProtocol TC — same numbering as RFC 2096: local=2, static=3, ospf=13, bgp=14.

func pollRouteTableInet(s *client.Session, deviceID uuid.UUID, ifByIndex map[int]string) ([]*model.RouteEntry, error) {
	pdus, err := s.BulkWalkAll(oid.InetCidrRouteTable)
	if err != nil || len(pdus) == 0 {
		return nil, err
	}

	type row struct {
		ifIndex int
		proto   int
		metric  int
	}
	rows := make(map[string]*row)
	ensure := func(idx string) *row {
		if r, ok := rows[idx]; ok { return r }
		r := &row{}; rows[idx] = r; return r
	}

	for _, pdu := range pdus {
		col, idx, ok := inetCidrParseCol(pdu.Name)
		if !ok { continue }
		r := ensure(idx)
		// RFC 4292 column assignments — cols 1-6 are INDEX fields (not accessible):
		// 7=inetCidrRouteIfIndex, 8=Type, 9=Proto, 10=Age, 11=NextHopAS, 12=Metric1
		switch col {
		case 7:  r.ifIndex = client.PDUInt(pdu)
		case 9:  r.proto   = client.PDUInt(pdu)
		case 12: r.metric  = client.PDUInt(pdu)
		}
	}

	results := make([]*model.RouteEntry, 0, len(rows))
	for idx, r := range rows {
		proto := inetCidrProtoName(r.proto)
		if proto == "" { continue }

		dest, nexthop, ok := inetCidrParseIndex(idx)
		if !ok { continue }

		results = append(results, &model.RouteEntry{
			DeviceID:      deviceID,
			Destination:   dest,
			NextHop:       nexthop,
			Protocol:      proto,
			Metric:        r.metric,
			InterfaceName: ifByIndex[r.ifIndex],
		})
	}
	return results, nil
}

// inetCidrParseCol extracts column number and raw index string.
// OID: base.col.{index}
func inetCidrParseCol(pduName string) (col int, idx string, ok bool) {
	base := strings.TrimPrefix(oid.InetCidrRouteTable, ".")
	full := strings.TrimPrefix(pduName, ".")
	if !strings.HasPrefix(full, base+".") {
		return 0, "", false
	}
	rest := full[len(base)+1:]
	dot := strings.IndexByte(rest, '.')
	if dot < 0 { return 0, "", false }
	c, err := strconv.Atoi(rest[:dot])
	if err != nil { return 0, "", false }
	return c, rest[dot+1:], true
}

// inetCidrParseIndex decodes the inetCidrRouteTable OID index for IPv4 and IPv6.
// Index: destType.destLen.addr[destLen].pfxLen.[policy...].nhType.nhLen.nhAddr[nhLen]
func inetCidrParseIndex(idx string) (dest, nexthop string, ok bool) {
	parts := strings.Split(idx, ".")
	if len(parts) < 14 {
		return "", "", false
	}

	destType := parts[0]
	destLen, _ := strconv.Atoi(parts[1])

	switch destType {
	case "1": // IPv4
		if destLen != 4 || len(parts) < 14 {
			return "", "", false
		}
		destIP := strings.Join(parts[2:6], ".")
		pfxLen := parts[6]
		dest = fmt.Sprintf("%s/%s", destIP, pfxLen)
		// Scan for nexthop: find "1.4" followed by 4 valid octets
		for i := 7; i < len(parts)-5; i++ {
			if parts[i] != "1" || parts[i+1] != "4" {
				continue
			}
			if len(parts) < i+6 { break }
			nh := strings.Join(parts[i+2:i+6], ".")
			if isValidIPOctets(parts[i+2 : i+6]) {
				if nh == "0.0.0.0" {
					nh = ""
				}
				return dest, nh, true
			}
		}
		return dest, "", true

	case "2": // IPv6
		if destLen != 16 || len(parts) < 2+16+1 {
			return "", "", false
		}
		destIP := octetsToIPv6(parts[2 : 2+16])
		pfxLen := parts[2+16]
		dest = fmt.Sprintf("%s/%s", destIP, pfxLen)
		// Scan for nexthop: find "2.16" followed by 16 octets
		start := 2 + 16 + 1 // past destAddr + pfxLen
		for i := start; i < len(parts)-17; i++ {
			if parts[i] == "2" && parts[i+1] == "16" && len(parts) >= i+18 {
				nhIP := octetsToIPv6(parts[i+2 : i+18])
				if nhIP == "::" {
					nhIP = ""
				}
				return dest, nhIP, true
			}
		}
		return dest, "", true

	default:
		return "", "", false
	}
}

func octetsToIPv6(octets []string) string {
	if len(octets) != 16 {
		return ""
	}
	raw := make(net.IP, 16)
	for i, o := range octets {
		v, _ := strconv.Atoi(o)
		raw[i] = byte(v)
	}
	return raw.String()
}

func isValidIPOctets(parts []string) bool {
	if len(parts) != 4 { return false }
	for _, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 || n > 255 { return false }
	}
	return true
}

// inetCidrProtoName maps RFC 4292 inetCidrRouteProto (IANAipRouteProtocol TC).
// Same numbering as RFC 2096 ipCidrRouteProto — ospf=13, bgp=14.
func inetCidrProtoName(v int) string {
	return cidrProtoName(v)
}
