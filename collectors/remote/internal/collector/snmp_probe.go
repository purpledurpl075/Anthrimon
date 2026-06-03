package collector

// snmp_probe.go — on-demand SNMP identity probe and CIDR sweep helpers.
// Used by the control server's /probe and /sweep endpoints.
// Vendor detection mirrors api/backend/snmp_probe.py exactly.

import (
	"context"
	"fmt"
	"net/netip"
	"strings"
	"sync"
	"time"

	"github.com/gosnmp/gosnmp"
)

// ProbeResult holds SNMP identity data from a single-device probe.
type ProbeResult struct {
	IP          string `json:"ip"`
	Hostname    string `json:"hostname"`
	Vendor      string `json:"vendor"`
	SysDescr    string `json:"sys_descr"`
	SysObjectID string `json:"sys_object_id"`
}

// CredSpec describes one set of SNMP credentials for a probe or sweep.
type CredSpec struct {
	Version   string `json:"version"`   // "snmp_v2c" or "snmp_v3"
	Community string `json:"community"` // v2c only
	Username  string `json:"username"`  // v3 only
	AuthKey   string `json:"auth_key"`
	PrivKey   string `json:"priv_key"`
	AuthProto string `json:"auth_proto"`
	PrivProto string `json:"priv_proto"`
}

var _svpVendorPrefixes = []struct{ prefix, vendor string }{
	{"1.3.6.1.4.1.2636.", "juniper"},
	{"1.3.6.1.4.1.30065.", "arista"},
	{"1.3.6.1.4.1.12356.", "fortios"},
	{"1.3.6.1.4.1.47196.", "aruba_cx"},
	{"1.3.6.1.4.1.11.", "procurve"},
	{"1.3.6.1.4.1.9.12.", "cisco_nxos"},
	{"1.3.6.1.4.1.9.6.", "cisco_iosxe"},
	{"1.3.6.1.4.1.9.1.", "cisco_ios"},
	{"1.3.6.1.4.1.9.", "cisco_ios"},
}

var _svpDescrOverrides = []struct{ oidVendor, pattern, corrected string }{
	{"cisco_ios", "NX-OS", "cisco_nxos"},
	{"cisco_ios", "IOS-XR", "cisco_iosxr"},
}

// detectVendor mirrors Python detect_vendor() in api/backend/snmp_probe.py.
func detectVendor(sysObjectID, sysDescr string) string {
	vendor := "unknown"
	for _, vp := range _svpVendorPrefixes {
		if strings.HasPrefix(sysObjectID, vp.prefix) {
			vendor = vp.vendor
			break
		}
	}
	upper := strings.ToUpper(sysDescr)
	for _, ov := range _svpDescrOverrides {
		if vendor == ov.oidVendor && strings.Contains(upper, strings.ToUpper(ov.pattern)) {
			vendor = ov.corrected
			break
		}
	}
	return vendor
}

func buildProbeSession(ip string, port int, cred CredSpec, timeout time.Duration) *gosnmp.GoSNMP {
	g := &gosnmp.GoSNMP{
		Target:  ip,
		Port:    uint16(port),
		Timeout: timeout,
		Retries: 0,
		MaxOids: 60,
	}
	if strings.EqualFold(cred.Version, "snmp_v3") {
		g.Version = gosnmp.Version3

		ap := gosnmp.NoAuth
		switch strings.ToUpper(cred.AuthProto) {
		case "MD5":
			ap = gosnmp.MD5
		case "SHA":
			ap = gosnmp.SHA
		case "SHA224":
			ap = gosnmp.SHA224
		case "SHA256":
			ap = gosnmp.SHA256
		case "SHA384":
			ap = gosnmp.SHA384
		case "SHA512":
			ap = gosnmp.SHA512
		}

		pp := gosnmp.NoPriv
		switch strings.ToUpper(cred.PrivProto) {
		case "DES":
			pp = gosnmp.DES
		case "AES":
			pp = gosnmp.AES
		case "AES192":
			pp = gosnmp.AES192
		case "AES256":
			pp = gosnmp.AES256
		}

		msgFlags := gosnmp.NoAuthNoPriv
		if cred.AuthKey != "" {
			msgFlags = gosnmp.AuthNoPriv
		}
		if cred.PrivKey != "" {
			msgFlags = gosnmp.AuthPriv
		}

		g.SecurityModel = gosnmp.UserSecurityModel
		g.MsgFlags = msgFlags
		g.SecurityParameters = &gosnmp.UsmSecurityParameters{
			UserName:                 cred.Username,
			AuthenticationProtocol:  ap,
			AuthenticationPassphrase: cred.AuthKey,
			PrivacyProtocol:         pp,
			PrivacyPassphrase:       cred.PrivKey,
		}
	} else {
		g.Version = gosnmp.Version2c
		community := cred.Community
		if community == "" {
			community = "public"
		}
		g.Community = community
	}
	return g
}

// runSNMPProbe connects the session, fetches the three identity OIDs, and
// returns a *ProbeResult (nil if unreachable or SNMP error).
func runSNMPProbe(g *gosnmp.GoSNMP, ip string) *ProbeResult {
	if err := g.ConnectIPv4(); err != nil {
		return nil
	}
	defer g.Conn.Close()

	result, err := g.Get([]string{oidSysDescr, oidSysObjectID, oidSysName})
	if err != nil || result == nil || len(result.Variables) < 2 {
		return nil
	}

	sysDescr := pduString(result.Variables[0])
	sysOID := strings.TrimPrefix(pduString(result.Variables[1]), ".")
	sysName := ip
	if len(result.Variables) >= 3 {
		if n := pduString(result.Variables[2]); n != "" {
			sysName = n
		}
	}

	return &ProbeResult{
		IP:          ip,
		Hostname:    sysName,
		Vendor:      detectVendor(sysOID, sysDescr),
		SysDescr:    sysDescr,
		SysObjectID: sysOID,
	}
}

// ProbeOne tries each CredSpec in order and returns the first successful
// ProbeResult and the matched credential index. Returns (nil, -1) on failure.
func ProbeOne(ip string, port int, creds []CredSpec, timeout time.Duration) (*ProbeResult, int) {
	for i, cred := range creds {
		g := buildProbeSession(ip, port, cred, timeout)
		if r := runSNMPProbe(g, ip); r != nil {
			return r, i
		}
	}
	return nil, -1
}

// SweepResult holds the aggregate outcome of a CIDR sweep.
type SweepResult struct {
	Total   int            `json:"total"`
	Scanned int            `json:"scanned"`
	Found   []*ProbeResult `json:"found"`
}

// SweepCIDR probes every usable host in cidr (network and broadcast excluded).
// Each host is tried against creds in order; first success wins.
// maxConcurrent limits parallel goroutines. ctx cancellation stops new probes.
func SweepCIDR(ctx context.Context, cidr string, port int, creds []CredSpec, timeout time.Duration, maxConcurrent int) (*SweepResult, error) {
	prefix, err := netip.ParsePrefix(cidr)
	if err != nil {
		return nil, fmt.Errorf("invalid CIDR %q: %w", cidr, err)
	}
	prefix = prefix.Masked()

	var hosts []netip.Addr
	for addr := prefix.Addr().Next(); prefix.Contains(addr); addr = addr.Next() {
		if isIPv4Broadcast(addr, prefix) {
			break
		}
		hosts = append(hosts, addr)
	}

	sr := &SweepResult{Total: len(hosts)}
	if len(hosts) == 0 {
		return sr, nil
	}

	sem := make(chan struct{}, maxConcurrent)
	var mu sync.Mutex
	var wg sync.WaitGroup

	for _, addr := range hosts {
		if ctx.Err() != nil {
			break
		}
		wg.Add(1)
		go func(a netip.Addr) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			pr, _ := ProbeOne(a.String(), port, creds, timeout)

			mu.Lock()
			sr.Scanned++
			if pr != nil {
				sr.Found = append(sr.Found, pr)
			}
			mu.Unlock()
		}(addr)
	}
	wg.Wait()
	return sr, nil
}

// isIPv4Broadcast reports whether addr is the broadcast address of prefix.
func isIPv4Broadcast(addr netip.Addr, prefix netip.Prefix) bool {
	if !addr.Is4() {
		return false
	}
	bits := prefix.Bits()
	if bits >= 31 {
		return false
	}
	a := addr.As4()
	ipInt := uint32(a[0])<<24 | uint32(a[1])<<16 | uint32(a[2])<<8 | uint32(a[3])
	hostMask := ^uint32(0) >> uint(bits)
	return (ipInt & hostMask) == hostMask
}
