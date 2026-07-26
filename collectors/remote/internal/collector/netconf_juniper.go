// Package collector — Junos NETCONF collector.
//
// NetconfJuniperCollector polls Junos devices over NETCONF (RFC 6241) for
// BGP/IS-IS/route state and posts it to the hub via the same endpoints the
// Arista eAPI and Aruba CX REST collectors use — this is Junos's parallel to
// those two: a structured, vendor-native API replacing the SNMP-MIB path for
// routing state on devices where it's enabled. Interface inventory, VLANs,
// ARP/MAC, LLDP, CPU/memory, and DOM stay on SNMP (already solid — see
// snmp_discovery.go) since NETCONF doesn't offer a clear improvement there
// and duplicating that work isn't worth it.
//
// Collection is controlled by the netconf_enabled flag per device (set by
// the hub when device_api_methods has junos_netconf enabled+reachable),
// mirroring eapi_enabled/rest_collection_enabled exactly.
package collector

import (
	"context"
	"encoding/xml"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"
	zlog "github.com/rs/zerolog/log"

	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/hub"
	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/netconf"
)

var netconfLog = zlog.Logger.With().Str("subsystem", "junos_netconf").Logger()

const netconfPort = 830

// NetconfJuniperCollector collects BGP/IS-IS/route state from Junos devices
// over NETCONF and forwards results to the hub.
type NetconfJuniperCollector struct {
	hubClient *hub.Client
	mu        sync.RWMutex
	devices   []hub.Device
	interval  time.Duration
	logger    zerolog.Logger
}

// NewNetconfJuniperCollector creates a new Junos NETCONF collector.
func NewNetconfJuniperCollector(hubClient *hub.Client, logger zerolog.Logger) *NetconfJuniperCollector {
	return &NetconfJuniperCollector{
		hubClient: hubClient,
		interval:  60 * time.Second,
		logger:    logger.With().Str("subsystem", "junos_netconf").Logger(),
	}
}

// SetDevices replaces the current device list.
func (c *NetconfJuniperCollector) SetDevices(devices []hub.Device) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.devices = devices
}

// SetInterval configures the poll cadence. A zero or negative value retains
// the current default. Takes effect on the next collector restart (the
// ticker is created once in Run).
func (c *NetconfJuniperCollector) SetInterval(intervalS int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if intervalS > 0 {
		c.interval = time.Duration(intervalS) * time.Second
	}
}

// Run starts the periodic NETCONF collection loop.
func (c *NetconfJuniperCollector) Run(ctx context.Context) {
	c.mu.RLock()
	interval := c.interval
	c.mu.RUnlock()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	c.collectAll(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.collectAll(ctx)
		}
	}
}

func (c *NetconfJuniperCollector) collectAll(ctx context.Context) {
	c.mu.RLock()
	devices := make([]hub.Device, len(c.devices))
	copy(devices, c.devices)
	c.mu.RUnlock()

	for _, dev := range devices {
		if !dev.NetconfEnabled || dev.Vendor != "juniper" {
			continue
		}
		c.collectOne(ctx, dev)
	}
}

func (c *NetconfJuniperCollector) collectOne(ctx context.Context, dev hub.Device) {
	cred := dev.SSHCredential()
	if cred == nil {
		c.logger.Warn().Str("device", dev.Hostname).Msg("no ssh credential for netconf")
		return
	}
	username, _ := cred.Data["username"].(string)
	password, _ := cred.Data["password"].(string)

	sess, err := netconf.Dial(dev.MgmtIP, netconfPort, username, password, 15*time.Second)
	if err != nil {
		c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("netconf dial failed")
		return
	}
	defer sess.Close()

	if bgpRecords, err := c.pollBGP(sess, dev); err != nil {
		c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("netconf bgp poll failed")
	} else if len(bgpRecords) > 0 {
		if err := c.hubClient.PostBGPSessions(ctx, dev.ID, bgpRecords); err != nil {
			c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("netconf bgp post failed")
		}
	}

	if isisRecords, err := c.pollISIS(sess, dev); err != nil {
		c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("netconf isis poll failed")
	} else if len(isisRecords) > 0 {
		if err := c.hubClient.PostISISNeighbors(ctx, dev.ID, isisRecords); err != nil {
			c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("netconf isis post failed")
		}
	}

	if routes, err := c.pollRoutes(sess, dev); err != nil {
		c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("netconf routes poll failed")
	} else {
		if err := c.hubClient.PostRoutes(ctx, dev.ID, routes); err != nil {
			c.logger.Warn().Err(err).Str("device", dev.Hostname).Msg("netconf routes post failed")
		}
	}
}

// ─── BGP ────────────────────────────────────────────────────────────────────

type bgpSummaryReply struct {
	BGPInformation struct {
		Peers []struct {
			PeerAddress    string `xml:"peer-address"`
			PeerAS         string `xml:"peer-as"`
			InputMessages  string `xml:"input-messages"`
			OutputMessages string `xml:"output-messages"`
			FlapCount      string `xml:"flap-count"`
			ElapsedTime    struct {
				Seconds string `xml:"seconds,attr"`
			} `xml:"elapsed-time"`
			PeerState string `xml:"peer-state"`
		} `xml:"bgp-peer"`
	} `xml:"bgp-information"`
}

// localASN fetches routing-options autonomous-system via a config get —
// get-bgp-summary-information doesn't include the local AS.
func (c *NetconfJuniperCollector) localASN(sess *netconf.Session) int64 {
	reply, err := sess.RPC(`<get-configuration><configuration><routing-options/></configuration></get-configuration>`, 10*time.Second)
	if err != nil {
		return 0
	}
	var parsed struct {
		Configuration struct {
			RoutingOptions struct {
				AutonomousSystem struct {
					ASNumber string `xml:"as-number"`
				} `xml:"autonomous-system"`
			} `xml:"routing-options"`
		} `xml:"configuration"`
	}
	if err := xml.Unmarshal([]byte(reply), &parsed); err != nil {
		return 0
	}
	v, _ := strconv.ParseInt(strings.TrimSpace(parsed.Configuration.RoutingOptions.AutonomousSystem.ASNumber), 10, 64)
	return v
}

func (c *NetconfJuniperCollector) pollBGP(sess *netconf.Session, dev hub.Device) ([]map[string]any, error) {
	reply, err := sess.RPC("<get-bgp-summary-information/>", 15*time.Second)
	if err != nil {
		return nil, err
	}
	var parsed bgpSummaryReply
	if err := xml.Unmarshal([]byte(reply), &parsed); err != nil {
		return nil, fmt.Errorf("unmarshal bgp reply: %w", err)
	}
	if len(parsed.BGPInformation.Peers) == 0 {
		return nil, nil
	}

	localASN := c.localASN(sess)

	records := make([]map[string]any, 0, len(parsed.BGPInformation.Peers))
	for _, p := range parsed.BGPInformation.Peers {
		peerASN, _ := strconv.ParseInt(strings.TrimSpace(p.PeerAS), 10, 64)
		inUpdates, _ := strconv.ParseInt(strings.TrimSpace(p.InputMessages), 10, 64)
		outUpdates, _ := strconv.ParseInt(strings.TrimSpace(p.OutputMessages), 10, 64)
		flapCount, _ := strconv.ParseInt(strings.TrimSpace(p.FlapCount), 10, 64)
		uptimeSecs, _ := strconv.ParseInt(strings.TrimSpace(p.ElapsedTime.Seconds), 10, 64)

		records = append(records, map[string]any{
			"device_id":   dev.ID,
			"vrf":         "default",
			"peer_ip":     strings.TrimSpace(p.PeerAddress),
			"peer_asn":    peerASN,
			"local_asn":   localASN,
			"state":       bgpNetconfStateName(p.PeerState),
			"uptime_s":    uptimeSecs,
			"in_updates":  inUpdates,
			"out_updates": outUpdates,
			"flap_count":  flapCount,
		})
	}
	return records, nil
}

// bgpNetconfStateName normalises Junos's human-readable peer-state text
// (e.g. "Established", "Active", "6/Establ") to the same lowercase state
// vocabulary the SNMP path uses (bgpPeerState from BGP4-MIB), so both
// sources populate the same bgp_session_state enum consistently.
func bgpNetconfStateName(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	switch {
	case strings.Contains(s, "establ"):
		return "established"
	case strings.Contains(s, "idle"):
		return "idle"
	case strings.Contains(s, "connect"):
		return "connect"
	case strings.Contains(s, "active"):
		return "active"
	case strings.Contains(s, "opensent"):
		return "opensent"
	case strings.Contains(s, "openconfirm"):
		return "openconfirm"
	default:
		return "unknown"
	}
}

// ─── IS-IS ──────────────────────────────────────────────────────────────────

type isisAdjacencyReply struct {
	ISISAdjacencyInformation struct {
		Adjacencies []struct {
			SystemName     string `xml:"system-name"`
			InterfaceName  string `xml:"interface-name"`
			Level          string `xml:"level"`
			AdjacencyState string `xml:"adjacency-state"`
			IPAddress      string `xml:"ip-address"`
		} `xml:"isis-adjacency"`
	} `xml:"isis-adjacency-information"`
}

func (c *NetconfJuniperCollector) pollISIS(sess *netconf.Session, dev hub.Device) ([]map[string]any, error) {
	reply, err := sess.RPC("<get-isis-adjacency-information><extensive/></get-isis-adjacency-information>", 15*time.Second)
	if err != nil {
		return nil, err
	}
	var parsed isisAdjacencyReply
	if err := xml.Unmarshal([]byte(reply), &parsed); err != nil {
		return nil, fmt.Errorf("unmarshal isis reply: %w", err)
	}
	if len(parsed.ISISAdjacencyInformation.Adjacencies) == 0 {
		return nil, nil
	}

	records := make([]map[string]any, 0, len(parsed.ISISAdjacencyInformation.Adjacencies))
	for _, a := range parsed.ISISAdjacencyInformation.Adjacencies {
		sysName := strings.TrimSpace(a.SystemName)
		// isis_neighbors.sys_id is NOT NULL and part of the row's unique
		// key; NETCONF's adjacency output doesn't surface the raw NSAP
		// system-id the way SNMP's isisISAdjNeighSysID does, but the
		// resolved system-name is stable and unique enough to serve the
		// same purpose here (and is far more useful to display anyway).
		sysID := sysName
		if sysID == "" {
			sysID = strings.TrimSpace(a.InterfaceName)
		}

		rec := map[string]any{
			"device_id":      dev.ID,
			"instance":       "",
			"sys_id":         sysID,
			"interface_name": strings.TrimSpace(a.InterfaceName),
			"circuit_type":   isisLevelFromNetconf(a.Level),
			"adj_state":      isisNetconfStateName(a.AdjacencyState),
		}
		if sysName != "" {
			rec["hostname"] = sysName
		}
		if ip := strings.TrimSpace(a.IPAddress); ip != "" {
			if strings.Contains(ip, ":") {
				rec["ipv6_address"] = ip
			} else {
				rec["ipv4_address"] = ip
			}
		}
		records = append(records, rec)
	}
	return records, nil
}

// isisLevelFromNetconf maps Junos's numeric <level> (1 or 2) to the same
// level vocabulary the SNMP path reports — direct and reliable here, unlike
// SNMP's isisISAdjUsage column, which couldn't be confidently identified
// (see snmp_routing.go).
func isisLevelFromNetconf(level string) string {
	switch strings.TrimSpace(level) {
	case "1":
		return "level-1"
	case "2":
		return "level-2"
	case "3":
		return "level-1-2"
	default:
		return "unknown"
	}
}

func isisNetconfStateName(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "up":
		return "up"
	case "down":
		return "down"
	case "initializing", "new", "one-way", "initializing-1", "initializing-2":
		return "initializing"
	case "failed", "rejected":
		return "failed"
	default:
		return "unknown"
	}
}

// ─── Routes ─────────────────────────────────────────────────────────────────

type routeInformationReply struct {
	RouteInformation struct {
		Tables []struct {
			TableName string `xml:"table-name"`
			Routes    []struct {
				Destination string `xml:"rt-destination"`
				Entries     []struct {
					ProtocolName string `xml:"protocol-name"`
					Metric       string `xml:"metric"`
					NextHops     []struct {
						To  string `xml:"to"`
						Via string `xml:"via"`
					} `xml:"nh"`
				} `xml:"rt-entry"`
			} `xml:"rt"`
		} `xml:"route-table"`
	} `xml:"route-information"`
}

func (c *NetconfJuniperCollector) pollRoutes(sess *netconf.Session, dev hub.Device) ([]map[string]any, error) {
	reply, err := sess.RPC("<get-route-information/>", 20*time.Second)
	if err != nil {
		return nil, err
	}
	var parsed routeInformationReply
	if err := xml.Unmarshal([]byte(reply), &parsed); err != nil {
		return nil, fmt.Errorf("unmarshal route reply: %w", err)
	}

	var records []map[string]any
	for _, table := range parsed.RouteInformation.Tables {
		// Only the main unicast IPv4/IPv6 tables — skip .mdns./.mpls. etc.
		if table.TableName != "inet.0" && table.TableName != "inet6.0" {
			continue
		}
		for _, rt := range table.Routes {
			for _, entry := range rt.Entries {
				proto := routeNetconfProtoName(entry.ProtocolName)
				if proto == "" {
					continue
				}
				metric, _ := strconv.Atoi(strings.TrimSpace(entry.Metric))
				nextHop, ifaceName := "", ""
				if len(entry.NextHops) > 0 {
					nextHop = strings.TrimSpace(entry.NextHops[0].To)
					ifaceName = strings.TrimSpace(entry.NextHops[0].Via)
				}
				records = append(records, map[string]any{
					"device_id":      dev.ID,
					"destination":    strings.TrimSpace(rt.Destination),
					"next_hop":       nextHop,
					"protocol":       proto,
					"metric":         metric,
					"interface_name": ifaceName,
				})
			}
		}
	}
	return records, nil
}

func routeNetconfProtoName(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "direct":
		return "connected"
	case "local":
		return "connected"
	case "static":
		return "static"
	case "is-is", "isis":
		return "isis"
	case "ospf", "ospf3":
		return "ospf"
	case "bgp":
		return "bgp"
	default:
		return ""
	}
}
