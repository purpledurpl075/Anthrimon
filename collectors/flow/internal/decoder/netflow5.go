// Package decoder provides decoders for NetFlow v5, NetFlow v9, IPFIX, and sFlow v5.
package decoder

import (
	"encoding/binary"
	"fmt"
	"net"
	"time"

	"github.com/purpledurpl075/anthri-mon/collectors/flow/internal/model"
)

const (
	nf5HeaderLen = 24
	nf5RecordLen = 48
)

// ParseNetFlow5 decodes a NetFlow v5 UDP payload and returns the decoded flow
// records. exporterIP is the source address of the UDP packet.
func ParseNetFlow5(pkt []byte, exporterIP net.IP) ([]model.FlowRecord, error) {
	if len(pkt) < nf5HeaderLen {
		return nil, fmt.Errorf("netflow v5: packet too short for header (%d bytes)", len(pkt))
	}

	version := binary.BigEndian.Uint16(pkt[0:2])
	if version != 5 {
		return nil, fmt.Errorf("netflow v5: unexpected version %d", version)
	}

	count := int(binary.BigEndian.Uint16(pkt[2:4]))
	sysUptime := binary.BigEndian.Uint32(pkt[4:8])   // milliseconds
	unixSecs := binary.BigEndian.Uint32(pkt[8:12])
	// unixNsecs := binary.BigEndian.Uint32(pkt[12:16]) // not needed
	// flowSeq   := binary.BigEndian.Uint32(pkt[16:20])
	// engineType := pkt[20]
	// engineID   := pkt[21]
	samplingInterval := binary.BigEndian.Uint16(pkt[22:24])
	samplingRate := uint32(samplingInterval & 0x3FFF)
	if samplingRate == 0 || samplingRate > 1000000 {
		samplingRate = 1
	}

	expected := nf5HeaderLen + count*nf5RecordLen
	if len(pkt) < expected {
		return nil, fmt.Errorf("netflow v5: packet too short: need %d bytes for %d records, have %d",
			expected, count, len(pkt))
	}

	// Base wall-clock time: the router's unix_secs field represents the wall
	// clock at the moment the packet was sent.  The first/last fields are
	// millisecond uptime offsets; we convert them to absolute UTC times via:
	//   abs = unixSecs + (uptime_ms_at_event - sysUptime_ms) / 1000
	baseTime := time.Unix(int64(unixSecs), 0).UTC()

	records := make([]model.FlowRecord, 0, count)
	for i := 0; i < count; i++ {
		off := nf5HeaderLen + i*nf5RecordLen
		r := pkt[off : off+nf5RecordLen]

		srcAddr := net.IP{r[0], r[1], r[2], r[3]}
		dstAddr := net.IP{r[4], r[5], r[6], r[7]}
		nextHop := net.IP{r[8], r[9], r[10], r[11]}
		inputIf := uint32(binary.BigEndian.Uint16(r[12:14]))
		outputIf := uint32(binary.BigEndian.Uint16(r[14:16]))
		dPkts := uint64(binary.BigEndian.Uint32(r[16:20]))
		dOctets := uint64(binary.BigEndian.Uint32(r[20:24]))
		first := binary.BigEndian.Uint32(r[24:28]) // ms uptime
		last := binary.BigEndian.Uint32(r[28:32])  // ms uptime
		srcPort := binary.BigEndian.Uint16(r[32:34])
		dstPort := binary.BigEndian.Uint16(r[34:36])
		// pad1 = r[36]
		tcpFlags := r[37]
		protocol := r[38]
		tos := r[39]
		srcAS := uint32(binary.BigEndian.Uint16(r[40:42]))
		dstAS := uint32(binary.BigEndian.Uint16(r[42:44]))
		srcMask := r[44]
		dstMask := r[45]
		// pad2 = r[46:48]

		// Convert uptime-relative ms to absolute UTC.
		flowStart := uptimeToTime(baseTime, sysUptime, first)
		flowEnd := uptimeToTime(baseTime, sysUptime, last)

		records = append(records, model.FlowRecord{
			ExporterIP:    cloneIP(exporterIP),
			FlowType:      "netflow_v5",
			FlowStart:     flowStart,
			FlowEnd:       flowEnd,
			SrcIP:         srcAddr,
			DstIP:         dstAddr,
			NextHop:       nextHop,
			SrcPort:       srcPort,
			DstPort:       dstPort,
			IPProtocol:    protocol,
			TCPFlags:      tcpFlags,
			TOS:           tos,
			DSCP:          tos >> 2,
			Bytes:         dOctets,
			Packets:       dPkts,
			InputIfIndex:  inputIf,
			OutputIfIndex: outputIf,
			SrcASN:        srcAS,
			DstASN:        dstAS,
			SrcPrefixLen:  srcMask,
			DstPrefixLen:  dstMask,
			SamplingRate:  samplingRate,
		})
	}
	return records, nil
}

// uptimeToTime converts a millisecond sysUptime offset to an absolute UTC time.
// baseTime is the wall clock at sysUptime (in ms). eventUptime is the uptime
// offset (in ms) at the flow event.
func uptimeToTime(baseTime time.Time, sysUptimeMs, eventUptimeMs uint32) time.Time {
	// delta can be negative if eventUptime wrapped or is slightly ahead; clamp.
	deltaMs := int64(eventUptimeMs) - int64(sysUptimeMs)
	return baseTime.Add(time.Duration(deltaMs) * time.Millisecond)
}

// cloneIP returns a copy of ip to avoid aliasing into shared packet buffers.
func cloneIP(ip net.IP) net.IP {
	if ip == nil {
		return nil
	}
	c := make(net.IP, len(ip))
	copy(c, ip)
	return c
}
