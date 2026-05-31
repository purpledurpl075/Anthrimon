package collector

import (
	"context"
	"encoding/binary"
	"net"
	"sync"
	"time"

	"github.com/rs/zerolog"

	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/config"
	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/hub"
)

// FlowCollector listens for NetFlow v5/v9/IPFIX and sFlow packets and
// forwards parsed records to the hub in JSON batches.
type FlowCollector struct {
	hub         *hub.Client
	cfg         config.FlowConfig
	fwdCfg      config.ForwardConfig
	devicesByIP map[string]string // mgmt_ip → device_id
	log         zerolog.Logger

	mu      sync.RWMutex
	buf     []map[string]any
}

// NewFlowCollector creates a FlowCollector.
func NewFlowCollector(
	hubClient *hub.Client,
	cfg config.FlowConfig,
	fwdCfg config.ForwardConfig,
	devicesByIP map[string]string,
	log zerolog.Logger,
) *FlowCollector {
	return &FlowCollector{
		hub:         hubClient,
		cfg:         cfg,
		fwdCfg:      fwdCfg,
		devicesByIP: devicesByIP,
		log:         log.With().Str("component", "flow_collector").Logger(),
	}
}

// UpdateDevices replaces the IP→device_id map.
func (c *FlowCollector) UpdateDevices(devicesByIP map[string]string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.devicesByIP = devicesByIP
}

// Run starts the NetFlow and sFlow UDP listeners and the flush loop.
// It blocks until ctx is cancelled and all listeners have exited.
func (c *FlowCollector) Run(ctx context.Context) {
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); c.listenUDP(ctx, c.cfg.NetflowAddr, "netflow") }()
	go func() { defer wg.Done(); c.listenUDP(ctx, c.cfg.SflowAddr, "sflow") }()
	c.flushLoop(ctx)
	wg.Wait()
}

// listenUDP binds a UDP socket and dispatches each received datagram.
func (c *FlowCollector) listenUDP(ctx context.Context, addr, kind string) {
	conn, err := net.ListenPacket("udp", addr)
	if err != nil {
		c.log.Error().Err(err).Str("addr", addr).Str("kind", kind).Msg("listen failed")
		return
	}
	defer conn.Close()

	c.log.Info().Str("addr", addr).Str("kind", kind).Msg("listening")

	buf := make([]byte, c.cfg.BufferSize)
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		n, src, err := conn.ReadFrom(buf)
		if err != nil {
			// Timeout is expected — loop back and check ctx.
			continue
		}

		exporterIP := ""
		if udpAddr, ok := src.(*net.UDPAddr); ok {
			exporterIP = udpAddr.IP.String()
		}

		records := c.parsePacket(buf[:n], exporterIP)
		if len(records) == 0 {
			continue
		}
		c.log.Debug().Str("kind", kind).Str("src", exporterIP).
			Int("bytes", n).Int("records", len(records)).Msg("flow packet received")

		c.mu.Lock()
		c.buf = append(c.buf, records...)
		overflow := len(c.buf) >= c.fwdCfg.BatchSize
		c.mu.Unlock()

		if overflow {
			go c.flush(context.Background())
		}
	}
}

// flushLoop periodically sends buffered records to the hub.
func (c *FlowCollector) flushLoop(ctx context.Context) {
	interval := time.Duration(c.fwdCfg.FlushIntervalS) * time.Second
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			// Final flush.
			c.flush(context.Background())
			return
		case <-ticker.C:
			c.flush(ctx)
		}
	}
}

func (c *FlowCollector) flush(ctx context.Context) {
	c.mu.Lock()
	if len(c.buf) == 0 {
		c.mu.Unlock()
		return
	}
	batch := c.buf
	c.buf = nil
	c.mu.Unlock()

	if err := c.hub.PostFlows(ctx, batch); err != nil {
		c.log.Error().Err(err).Int("records", len(batch)).Msg("failed to post flows")
	} else {
		c.log.Debug().Int("records", len(batch)).Msg("flows posted")
	}
}

// parsePacket detects the flow protocol and dispatches to the appropriate
// parser. sFlow v5 encodes its version as a 4-byte uint32 (value 5) whereas
// NetFlow/IPFIX encode theirs as a 2-byte uint16, so we check the 4-byte word
// first.
func (c *FlowCollector) parsePacket(data []byte, exporterIP string) []map[string]any {
	if len(data) < 4 {
		return nil
	}

	c.mu.RLock()
	deviceID := c.devicesByIP[exporterIP]
	c.mu.RUnlock()

	// sFlow v5: bytes 0-3 as uint32 == 5 (0x00000005).
	// NetFlow v5 would have 0x0005XXXX here (count in high word), so no clash.
	if binary.BigEndian.Uint32(data[0:4]) == 5 {
		return parseSFlow5(data, exporterIP, deviceID)
	}

	version := binary.BigEndian.Uint16(data[0:2])
	switch version {
	case 5:
		return parseNetFlowV5(data, exporterIP, deviceID)
	case 9:
		return parseNetFlowGeneric(data, exporterIP, deviceID, "netflow_v9")
	case 10:
		return parseNetFlowGeneric(data, exporterIP, deviceID, "ipfix")
	default:
		return nil
	}
}

// ─── NetFlow v5 parser ────────────────────────────────────────────────────────
//
// Header (24 bytes):
//   0-1   version (5)
//   2-3   count
//   4-7   sys_uptime
//   8-11  unix_secs
//   12-15 unix_nsecs
//   16-19 flow_sequence
//   20    engine_type
//   21    engine_id
//   22-23 sampling_interval
//
// Record (48 bytes each):
//   0-3   src_addr
//   4-7   dst_addr
//   8-11  next_hop
//   12-13 input (ifIndex)
//   14-15 output (ifIndex)
//   16-19 d_pkts
//   20-23 d_octets
//   24-27 first (uptime of first packet)
//   28-31 last  (uptime of last packet)
//   32-33 src_port
//   34-35 dst_port
//   36    pad1
//   37    tcp_flags
//   38    prot (IP protocol)
//   39    tos
//   40-41 src_as
//   42-43 dst_as
//   44    src_mask
//   45    dst_mask
//   46-47 pad2

const (
	nfV5HeaderSize = 24
	nfV5RecordSize = 48
)

func parseNetFlowV5(data []byte, exporterIP, deviceID string) []map[string]any {
	if len(data) < nfV5HeaderSize {
		return nil
	}

	count := int(binary.BigEndian.Uint16(data[2:4]))
	unixSecs := binary.BigEndian.Uint32(data[8:12])
	sysUptime := binary.BigEndian.Uint32(data[4:8]) // milliseconds

	// Sampling rate is encoded in the lower 14 bits of the sampling interval field.
	rawSampling := binary.BigEndian.Uint16(data[22:24])
	samplingRate := uint32(rawSampling & 0x3FFF)
	if samplingRate == 0 {
		samplingRate = 1
	}

	expected := nfV5HeaderSize + count*nfV5RecordSize
	if len(data) < expected {
		count = (len(data) - nfV5HeaderSize) / nfV5RecordSize
	}

	records := make([]map[string]any, 0, count)
	for i := 0; i < count; i++ {
		off := nfV5HeaderSize + i*nfV5RecordSize
		if off+nfV5RecordSize > len(data) {
			break
		}
		rec := data[off : off+nfV5RecordSize]

		srcIP := net.IP(rec[0:4]).String()
		dstIP := net.IP(rec[4:8]).String()
		inputIF := binary.BigEndian.Uint16(rec[12:14])
		outputIF := binary.BigEndian.Uint16(rec[14:16])
		packets := binary.BigEndian.Uint32(rec[16:20])
		octets := binary.BigEndian.Uint32(rec[20:24])
		firstUptime := binary.BigEndian.Uint32(rec[24:28])
		lastUptime := binary.BigEndian.Uint32(rec[28:32])
		srcPort := binary.BigEndian.Uint16(rec[32:34])
		dstPort := binary.BigEndian.Uint16(rec[34:36])
		protocol := rec[38]

		// Convert uptime-relative timestamps to absolute UTC.
		bootTime := time.Unix(int64(unixSecs), 0).Add(-time.Duration(sysUptime) * time.Millisecond)
		flowStart := bootTime.Add(time.Duration(firstUptime) * time.Millisecond)
		flowEnd := bootTime.Add(time.Duration(lastUptime) * time.Millisecond)

		r := buildFlowRecord(exporterIP, deviceID, "netflow_v5")
		r["flow_start"] = flowStart.UTC().Format(time.RFC3339Nano)
		r["flow_end"] = flowEnd.UTC().Format(time.RFC3339Nano)
		r["src_ip"] = srcIP
		r["dst_ip"] = dstIP
		r["src_port"] = int(srcPort)
		r["dst_port"] = int(dstPort)
		r["ip_protocol"] = int(protocol)
		r["bytes"] = int64(octets)
		r["packets"] = int64(packets)
		r["input_if_index"] = int(inputIF)
		r["output_if_index"] = int(outputIF)
		r["sampling_rate"] = int(samplingRate)
		records = append(records, r)
	}
	return records
}

// parseNetFlowGeneric handles v9 and IPFIX packets with minimal parsing —
// we only extract the exporter IP and note the flow type.  The hub performs
// full template-aware parsing.
func parseNetFlowGeneric(data []byte, exporterIP, deviceID, flowType string) []map[string]any {
	r := buildFlowRecord(exporterIP, deviceID, flowType)
	// Include raw byte count for observability.
	r["raw_bytes"] = len(data)
	return []map[string]any{r}
}

// buildFlowRecord returns a skeleton flow record with mandatory fields set.
func buildFlowRecord(exporterIP, deviceID, flowType string) map[string]any {
	return map[string]any{
		"collector_device_id": deviceID,
		"exporter_ip":         exporterIP,
		"flow_type":           flowType,
		"flow_start":          "",
		"flow_end":            "",
		"src_ip":              "",
		"dst_ip":              "",
		"src_port":            0,
		"dst_port":            0,
		"ip_protocol":         0,
		"bytes":               int64(0),
		"packets":             int64(0),
		"input_if_index":      0,
		"output_if_index":     0,
		"sampling_rate":       1,
	}
}
