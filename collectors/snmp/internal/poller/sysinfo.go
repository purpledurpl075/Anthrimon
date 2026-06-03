// Package poller implements the per-device SNMP polling logic.
package poller

import (
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/client"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/model"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/oid"
	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/vendor"
)

// PollSysInfo fetches the RFC 1213 system group scalars from the device and
// runs vendor auto-detection using the returned sysObjectID and sysDescr.
// This is always the first poll on any device — results drive which OIDs are
// used for subsequent interface and health polls.
func PollSysInfo(s *client.Session, deviceID uuid.UUID) (*model.DeviceInfo, error) {
	scalarOIDs := []string{
		oid.SysDescr,
		oid.SysObjectID,
		oid.SysUpTime,
		oid.SysContact,
		oid.SysName,
		oid.SysLocation,
	}

	pdus, err := s.Get(scalarOIDs)
	if err != nil {
		return nil, err
	}

	info := &model.DeviceInfo{
		DeviceID: deviceID,
		PollTime: time.Now().UTC(),
	}

	for _, pdu := range pdus {
		switch {
		case endsWith(pdu.Name, oid.SysDescr):
			info.SysDescr = client.PDUString(pdu)
		case endsWith(pdu.Name, oid.SysObjectID):
			info.SysObjectID = client.PDUString(pdu)
		case endsWith(pdu.Name, oid.SysUpTime):
			info.SysUpTimeTicks = uint32(client.PDUUint64(pdu))
		case endsWith(pdu.Name, oid.SysContact):
			info.SysContact = client.PDUString(pdu)
		case endsWith(pdu.Name, oid.SysName):
			info.SysName = client.PDUString(pdu)
		case endsWith(pdu.Name, oid.SysLocation):
			info.SysLocation = client.PDUString(pdu)
		}
	}

	// Auto-detect vendor from the received OID and sysDescr.
	if p := vendor.Detect(info.SysObjectID, info.SysDescr); p != nil {
		info.VendorName = p.Name
		info.DBVendorType = p.DBVendorType
		info.DBDeviceType = p.DBDeviceType
	} else {
		info.VendorName = "unknown"
		info.DBVendorType = "unknown"
	}

	info.OSVersion, info.Platform = parseSysDescr(info.DBVendorType, info.SysDescr)
	info.SysLocationStr = info.SysLocation
	info.SysContactStr  = info.SysContact

	return info, nil
}

// parseSysDescr extracts os_version and platform from sysDescr using
// vendor-specific patterns. Returns empty strings if not recognisable.
func parseSysDescr(dbVendor, sysDescr string) (osVersion, platform string) {
	d := strings.TrimSpace(sysDescr)
	switch dbVendor {
	case "arista":
		// "Arista Networks EOS version 4.23.13M-2GB running on an Arista Networks DCS-7150S-64-CL"
		// "Linux vEOS5 4.9.122.Ar-... x86_64"  (virtual EOS)
		if m := regexp.MustCompile(`EOS\s+version\s+(\S+)`).FindStringSubmatch(d); len(m) > 1 {
			osVersion = strings.Split(m[1], "-")[0] // strip "-2GB" suffix
		}
		if m := regexp.MustCompile(`running on an? Arista Networks (\S+)`).FindStringSubmatch(d); len(m) > 1 {
			platform = m[1]
		} else if strings.HasPrefix(d, "Linux") {
			platform = "vEOS"
		}

	case "cisco_ios", "cisco_iosxe":
		// "Cisco IOS Software, Version 15.7(3)M4, RELEASE SOFTWARE"
		// "Cisco IOS XE Software, Version 17.09.04a"
		if m := regexp.MustCompile(`[Vv]ersion\s+([\d\w\.\(\)]+)`).FindStringSubmatch(d); len(m) > 1 {
			osVersion = m[1]
		}
		if m := regexp.MustCompile(`(?i)cisco\s+(\S+)\s+(?:chassis|switch|router)`).FindStringSubmatch(d); len(m) > 1 {
			platform = m[1]
		}

	case "cisco_iosxr":
		// "Cisco IOS XR Software, Version 7.5.2"
		// "Cisco IOS Software, IOSv Software (VIOS-ADVENTERPRISEK9-M), Version 15.9(3)M6"
		if m := regexp.MustCompile(`Version\s+([\d\.]+)`).FindStringSubmatch(d); len(m) > 1 {
			osVersion = m[1]
		}
		if m := regexp.MustCompile(`IOS\s+\S+\s+Software,\s+(\S+)\s+Software`).FindStringSubmatch(d); len(m) > 1 {
			platform = m[1]
		} else if m := regexp.MustCompile(`(?i)cisco\s+(\S+)\s+(?:chassis|switch|router)`).FindStringSubmatch(d); len(m) > 1 {
			platform = m[1]
		}

	case "cisco_nxos":
		// "Cisco NX-OS(tm) n9000, Software (n9000-dk9), Version 10.2(3)"
		if m := regexp.MustCompile(`Version\s+([\d\w\.\(\)]+)`).FindStringSubmatch(d); len(m) > 1 {
			osVersion = m[1]
		}
		if m := regexp.MustCompile(`(?i)nx-os[^ ]* ([a-z][0-9]+)`).FindStringSubmatch(d); len(m) > 1 {
			platform = m[1]
		}

	case "juniper":
		// "Juniper Networks, Inc. mx480 internet router, kernel JUNOS 21.4R3-S4, ..."
		if m := regexp.MustCompile(`JUNOS\s+([\d\w\.\-]+)`).FindStringSubmatch(d); len(m) > 1 {
			osVersion = m[1]
		}
		if m := regexp.MustCompile(`(?i)juniper networks, inc\. (\S+)`).FindStringSubmatch(d); len(m) > 1 {
			platform = m[1]
		}

	case "fortios":
		// "FortiGate-100F v7.4.4,build2662,241018 (GA)"
		if m := regexp.MustCompile(`v([\d\.]+),`).FindStringSubmatch(d); len(m) > 1 {
			osVersion = "v" + m[1]
		}
		if m := regexp.MustCompile(`^(FortiGate-\S+)\s`).FindStringSubmatch(d); len(m) > 1 {
			platform = m[1]
		}

	case "procurve":
		// "HP J9727A 2920-24G Switch, revision WB.16.10.0022, ROM WB.16.01..."
		if m := regexp.MustCompile(`revision\s+(\S+)`).FindStringSubmatch(d); len(m) > 1 {
			osVersion = strings.TrimSuffix(m[1], ",")
		}
		if m := regexp.MustCompile(`HP\s+\S+\s+(\S+)\s+Switch`).FindStringSubmatch(d); len(m) > 1 {
			platform = m[1] // e.g. "2920-24G"
		}

	case "aruba_cx":
		// Physical: "Aruba-CX 6300M, revision XX.10.12.0001, ..."
		// Virtual:  "HPE ANW ABC123 AOS-CX_OVA Virtual.10.16.1006"
		if m := regexp.MustCompile(`revision\s+(\S+)`).FindStringSubmatch(d); len(m) > 1 {
			osVersion = strings.TrimSuffix(m[1], ",")
		} else if m := regexp.MustCompile(`AOS-CX[_-]OVA\s+Virtual\.([\d\.]+)`).FindStringSubmatch(d); len(m) > 1 {
			osVersion = m[1]
		}
		if m := regexp.MustCompile(`Aruba-CX\s+(\S+)`).FindStringSubmatch(d); len(m) > 1 {
			platform = strings.TrimSuffix(m[1], ",")
		} else if strings.Contains(d, "AOS-CX_OVA") {
			platform = "AOS-CX OVA"
		}

	case "aruba_ap":
		// "ArubaOS (MODEL: 635), Version 8.12.0.0-8.12.0.0 SSR"
		if m := regexp.MustCompile(`\(MODEL:\s*([^)]+)\)`).FindStringSubmatch(d); len(m) > 1 {
			platform = "AP-" + strings.TrimSpace(m[1])
		}
		if m := regexp.MustCompile(`Version\s+([\d\.]+)`).FindStringSubmatch(d); len(m) > 1 {
			osVersion = m[1]
		}

	case "ubiquiti":
		// "Ubiquiti UniFi UCG-Fiber 5.1.12 Linux 5.4.213 ipq9574"
		if m := regexp.MustCompile(`UniFi\s+(\S+)\s+([\d\.]+)`).FindStringSubmatch(d); len(m) > 2 {
			platform = m[1]
			osVersion = m[2]
		}
	}
	return
}

// PollSysUpTime fetches only the sysUpTime scalar (1.3.6.1.2.1.1.3.0).
// Used on interface poll ticks where only the uptime counter is needed for
// ifLastChange calculations — avoids a full 6-OID PollSysInfo round-trip.
func PollSysUpTime(s *client.Session) (uint32, error) {
	pdus, err := s.Get([]string{oid.SysUpTime})
	if err != nil {
		return 0, err
	}
	if len(pdus) == 0 {
		return 0, nil
	}
	return uint32(client.PDUUint64(pdus[0])), nil
}

// endsWith is a loose OID suffix match that handles leading dots from gosnmp.
func endsWith(pduName, oidSuffix string) bool {
	// gosnmp returns names like ".1.3.6.1.2.1.1.1.0"
	// oidSuffix may or may not have a leading dot — strip both and compare suffix.
	name := trimDot(pduName)
	suffix := trimDot(oidSuffix)
	return name == suffix
}

func trimDot(s string) string {
	if len(s) > 0 && s[0] == '.' {
		return s[1:]
	}
	return s
}
