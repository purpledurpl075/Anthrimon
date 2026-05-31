package writer

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/poller"
	"github.com/rs/zerolog"
)

// VMWriter buffers Prometheus-format metrics and flushes them to VictoriaMetrics
// using the /api/v1/import/prometheus endpoint.
//
// Wire format per line:
//
//	metric_name{label="value",...} numeric_value unix_timestamp_ms
type VMWriter struct {
	baseURL       string
	flushInterval time.Duration
	batchSize     int
	client        *http.Client
	log           zerolog.Logger

	mu  sync.Mutex
	buf []string
}

// NewVMWriter creates a writer that flushes to the given VictoriaMetrics base URL.
func NewVMWriter(baseURL string, flushInterval time.Duration, batchSize int, log zerolog.Logger) *VMWriter {
	return &VMWriter{
		baseURL:       strings.TrimRight(baseURL, "/"),
		flushInterval: flushInterval,
		batchSize:     batchSize,
		client:        &http.Client{Timeout: 10 * time.Second},
		log:           log.With().Str("component", "vm_writer").Logger(),
		buf:           make([]string, 0, batchSize),
	}
}

// Run starts the background flush loop. Blocks until ctx is cancelled.
func (w *VMWriter) Run(ctx context.Context) {
	ticker := time.NewTicker(w.flushInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			w.flush(context.Background()) // drain remaining metrics on shutdown
			return
		case <-ticker.C:
			w.flush(ctx)
		}
	}
}

// Handle implements poller.ResultHandler. Encodes poll results as Prometheus
// text lines and buffers them for the next flush.
// Encoding happens outside the lock; the lock is held only for the buffer append.
func (w *VMWriter) Handle(_ context.Context, result *poller.PollResult) error {
	lines := w.encode(result)
	if len(lines) == 0 {
		return nil
	}

	w.mu.Lock()
	w.buf = append(w.buf, lines...)
	var toFlush []string
	if len(w.buf) >= w.batchSize {
		toFlush = w.drain()
	}
	w.mu.Unlock()

	if len(toFlush) > 0 {
		if err := w.sendLines(context.Background(), toFlush); err != nil {
			w.log.Error().Err(err).Msg("eager flush to VictoriaMetrics failed")
		}
	}
	return nil
}

// encode builds all Prometheus-format lines for a result without holding any lock.
func (w *VMWriter) encode(result *poller.PollResult) []string {
	deviceID := result.DeviceID.String()
	var b strings.Builder
	var lines []string

	line := func(format string, args ...interface{}) {
		b.Reset()
		fmt.Fprintf(&b, format, args...)
		lines = append(lines, b.String())
	}

	if len(result.Interfaces) > 0 {
		vendor := ""
		if result.SysInfo != nil {
			vendor = result.SysInfo.DBVendorType
		}
		ts := result.Interfaces[0].PollTime.UnixMilli()
		for _, iface := range result.Interfaces {
			labels := fmt.Sprintf(
				`device_id="%s",if_index="%d",if_name="%s",vendor="%s"`,
				deviceID, iface.IfIndex, escapeLabelValue(ifName(iface)), vendor,
			)
			line(`anthrimon_if_in_octets_total{%s} %d %d`, labels, iface.InOctets, ts)
			line(`anthrimon_if_out_octets_total{%s} %d %d`, labels, iface.OutOctets, ts)
			line(`anthrimon_if_in_errors_total{%s} %d %d`, labels, iface.InErrors, ts)
			line(`anthrimon_if_out_errors_total{%s} %d %d`, labels, iface.OutErrors, ts)
			line(`anthrimon_if_in_discards_total{%s} %d %d`, labels, iface.InDiscards, ts)
			line(`anthrimon_if_out_discards_total{%s} %d %d`, labels, iface.OutDiscards, ts)
			line(`anthrimon_if_speed_bps{%s} %d %d`, labels, iface.SpeedBPS, ts)
			line(`anthrimon_if_oper_status{%s} %d %d`, labels, boolInt(iface.OperStatus == "up"), ts)
		}
	}

	if result.Health != nil {
		h := result.Health
		ts := h.PollTime.UnixMilli()
		baseLbls := fmt.Sprintf(`device_id="%s"`, deviceID)
		for _, cpu := range h.CPUSamples {
			line(`anthrimon_device_cpu_util_pct{%s,cpu_index="%d"} %.2f %d`, baseLbls, cpu.CPUIndex, cpu.LoadPct, ts)
		}
		for _, mem := range h.MemSamples {
			line(`anthrimon_device_mem_total_bytes{%s,mem_type="%s"} %d %d`, baseLbls, mem.Type, mem.TotalBytes, ts)
			line(`anthrimon_device_mem_used_bytes{%s,mem_type="%s"} %d %d`, baseLbls, mem.Type, mem.UsedBytes, ts)
		}
		for _, temp := range h.TempSamples {
			line(`anthrimon_device_temp_celsius{%s,sensor="%s"} %.1f %d`, baseLbls, escapeLabelValue(temp.SensorName), temp.Celsius, ts)
		}
		for _, opt := range h.OpticalSamples {
			metric := "anthrimon_if_dom_rx_power_dbm"
			if opt.Direction == "tx" {
				metric = "anthrimon_if_dom_tx_power_dbm"
			}
			line(`%s{%s,iface="%s"} %.4f %d`, metric, baseLbls, escapeLabelValue(opt.IfaceName), opt.PowerDBm, ts)
		}
		line(`anthrimon_device_uptime_seconds{%s} %d %d`, baseLbls, h.UptimeSecs, ts)
	}

	// ── BGP sessions ─────────────────────────────────────────────────────────
	// Push one data point per peer per poll so we have prefix-count trends,
	// update rates, and flap-count timelines in VictoriaMetrics.
	if len(result.BGPSessions) > 0 {
		pollT := result.BGPSessions[0].PollTime
		if pollT.IsZero() {
			pollT = time.Now()
		}
		ts := pollT.UnixMilli()
		for _, s := range result.BGPSessions {
			labels := fmt.Sprintf(
				`device_id="%s",peer_ip="%s",peer_asn="%d",local_asn="%d"`,
				deviceID,
				escapeLabelValue(s.PeerIP),
				s.RemoteASN,
				s.LocalASN,
			)
			// Gauge: current prefix count received from this peer
			line(`anthrimon_bgp_prefixes_received{%s} %d %d`, labels, s.PrefixesReceived, ts)
			// Counters: cumulative UPDATE message counts (monotonically increasing)
			line(`anthrimon_bgp_in_updates_total{%s} %d %d`, labels, s.InUpdates, ts)
			line(`anthrimon_bgp_out_updates_total{%s} %d %d`, labels, s.OutUpdates, ts)
			// Counter: FSM established transitions (session flap count)
			line(`anthrimon_bgp_flap_count_total{%s} %d %d`, labels, s.FlapCount, ts)
		}
	}

	// ── Probe (ICMP RTT / loss) ───────────────────────────────────────────────
	if result.ProbeResult != nil {
		pr := result.ProbeResult
		ts := pr.PollTime.UnixMilli()
		baseLbls := fmt.Sprintf(`device_id="%s"`, deviceID)
		line(`anthrimon_device_loss_pct{%s} %.1f %d`, baseLbls, pr.LossPct, ts)
		if pr.RttMin >= 0 {
			line(`anthrimon_device_rtt_ms{%s,stat="min"} %.3f %d`, baseLbls, pr.RttMin, ts)
			line(`anthrimon_device_rtt_ms{%s,stat="avg"} %.3f %d`, baseLbls, pr.RttAvg, ts)
			line(`anthrimon_device_rtt_ms{%s,stat="max"} %.3f %d`, baseLbls, pr.RttMax, ts)
		}
	}

	return lines
}

// flush drains the buffer and sends to VictoriaMetrics.
func (w *VMWriter) flush(ctx context.Context) {
	w.mu.Lock()
	lines := w.drain()
	w.mu.Unlock()

	if len(lines) == 0 {
		return
	}
	if err := w.sendLines(ctx, lines); err != nil {
		w.log.Error().Err(err).Int("lines", len(lines)).Msg("flush to VictoriaMetrics failed")
	} else {
		w.log.Debug().Int("lines", len(lines)).Msg("flushed metrics to VictoriaMetrics")
	}
}

func (w *VMWriter) sendLines(ctx context.Context, lines []string) error {
	body := strings.Join(lines, "\n") + "\n"
	url := w.baseURL + "/api/v1/import/prometheus"

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewBufferString(body))
	if err != nil {
		return fmt.Errorf("create VM request: %w", err)
	}
	req.Header.Set("Content-Type", "text/plain")

	resp, err := w.client.Do(req)
	if err != nil {
		return fmt.Errorf("send to VM: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("VM returned HTTP %d", resp.StatusCode)
	}
	return nil
}

// drain moves all buffered lines out and returns them. Caller must hold mu.
func (w *VMWriter) drain() []string {
	if len(w.buf) == 0 {
		return nil
	}
	lines := w.buf
	w.buf = make([]string, 0, w.batchSize)
	return lines
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func escapeLabelValue(s string) string {
	// Prometheus label values must not contain unescaped double-quotes or newlines.
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	return s
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
