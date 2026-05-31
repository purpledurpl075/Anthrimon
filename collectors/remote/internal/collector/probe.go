// Package collector — ICMP latency prober.
//
// ProbeCollector pings every assigned device every 30 seconds and forwards
// RTT / loss metrics to the hub via POST /api/v1/collectors/metrics.
//
// It requires CAP_NET_RAW or root privileges.  If the raw socket cannot be
// opened on startup the collector logs a warning and exits Run() immediately,
// leaving the rest of the collector functional.
package collector

import (
	"context"
	"fmt"
	"math"
	"math/rand"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"
	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"

	"github.com/purpledurpl075/anthri-mon/collectors/remote/internal/hub"
)

const (
	remoteProbeInterval = 30 * time.Second
	remoteProbeCount    = 3
	remoteProbeTimeout  = time.Second
)

// ProbeCollector pings assigned devices and forwards RTT / loss metrics to the hub.
type ProbeCollector struct {
	hubClient *hub.Client
	log       zerolog.Logger

	mu      sync.RWMutex
	devices []hub.Device
}

// NewProbeCollector creates a new ProbeCollector.
func NewProbeCollector(hubClient *hub.Client, log zerolog.Logger) *ProbeCollector {
	return &ProbeCollector{
		hubClient: hubClient,
		log:       log.With().Str("component", "probe_collector").Logger(),
	}
}

// SetDevices replaces the device list.
func (c *ProbeCollector) SetDevices(devices []hub.Device) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.devices = devices
}

// Run starts the probe loop.  Returns immediately if raw ICMP is unavailable.
func (c *ProbeCollector) Run(ctx context.Context) {
	// Capability check — try to open a raw socket once at startup.
	test, err := icmp.ListenPacket("ip4:icmp", "0.0.0.0")
	if err != nil {
		c.log.Warn().Err(err).
			Msg("ICMP raw socket unavailable — ping probing disabled (grant CAP_NET_RAW or run as root)")
		return
	}
	test.Close()
	c.log.Info().Msg("ICMP prober ready")

	ticker := time.NewTicker(remoteProbeInterval)
	defer ticker.Stop()

	c.probeAll(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.probeAll(ctx)
		}
	}
}

// probeAll pings all current devices concurrently (bounded to 32 workers).
func (c *ProbeCollector) probeAll(ctx context.Context) {
	c.mu.RLock()
	devices := make([]hub.Device, len(c.devices))
	copy(devices, c.devices)
	c.mu.RUnlock()

	if len(devices) == 0 {
		return
	}

	sem := make(chan struct{}, 32)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var lines []string

	for _, dev := range devices {
		dev := dev
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			break
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }()

			rttMin, rttAvg, rttMax, lossPct := probeHost(ctx, dev.MgmtIP)
			ts := time.Now().UnixMilli()
			did := dev.ID
			base := fmt.Sprintf(`device_id="%s"`, did)

			mu.Lock()
			lines = append(lines,
				fmt.Sprintf(`anthrimon_device_loss_pct{%s} %.1f %d`, base, lossPct, ts),
			)
			if rttMin >= 0 {
				lines = append(lines,
					fmt.Sprintf(`anthrimon_device_rtt_ms{%s,stat="min"} %.3f %d`, base, rttMin, ts),
					fmt.Sprintf(`anthrimon_device_rtt_ms{%s,stat="avg"} %.3f %d`, base, rttAvg, ts),
					fmt.Sprintf(`anthrimon_device_rtt_ms{%s,stat="max"} %.3f %d`, base, rttMax, ts),
				)
			}
			mu.Unlock()
		}()
	}
	wg.Wait()

	if len(lines) == 0 {
		return
	}
	text := strings.Join(lines, "\n") + "\n"
	if err := c.hubClient.PostMetrics(ctx, text); err != nil {
		c.log.Error().Err(err).Msg("failed to post probe metrics to hub")
	} else {
		c.log.Debug().Int("lines", len(lines)).Msg("probe metrics posted")
	}
}

// probeHost sends remoteProbeCount ICMP echo requests and returns (min, avg, max, loss%).
// rttMin == -1 when all probes were lost.
func probeHost(ctx context.Context, host string) (rttMin, rttAvg, rttMax, lossPct float64) {
	dst, err := net.ResolveIPAddr("ip4", host)
	if err != nil {
		return -1, 0, 0, 100.0
	}

	conn, err := icmp.ListenPacket("ip4:icmp", "0.0.0.0")
	if err != nil {
		return -1, 0, 0, 100.0
	}
	defer conn.Close()

	id := int(rand.Uint32() & 0xffff)
	var rtts []float64

	for seq := 0; seq < remoteProbeCount; seq++ {
		select {
		case <-ctx.Done():
			goto done
		default:
		}
		if rtt, ok := remoteProbeEcho(conn, dst, id, seq); ok {
			rtts = append(rtts, rtt)
		}
		if seq < remoteProbeCount-1 {
			time.Sleep(200 * time.Millisecond)
		}
	}

done:
	lost := remoteProbeCount - len(rtts)
	lossPct = float64(lost) / float64(remoteProbeCount) * 100.0

	if len(rtts) == 0 {
		return -1, 0, 0, lossPct
	}

	minR, maxR, sum := math.MaxFloat64, 0.0, 0.0
	for _, r := range rtts {
		sum += r
		if r < minR {
			minR = r
		}
		if r > maxR {
			maxR = r
		}
	}
	return minR, sum / float64(len(rtts)), maxR, lossPct
}

func remoteProbeEcho(conn *icmp.PacketConn, dst *net.IPAddr, id, seq int) (float64, bool) {
	msg := icmp.Message{
		Type: ipv4.ICMPTypeEcho,
		Code: 0,
		Body: &icmp.Echo{
			ID:   id & 0xffff,
			Seq:  seq & 0xffff,
			Data: []byte("anthrimon-probe"),
		},
	}
	wb, err := msg.Marshal(nil)
	if err != nil {
		return 0, false
	}
	deadline := time.Now().Add(remoteProbeTimeout)
	if err := conn.SetDeadline(deadline); err != nil {
		return 0, false
	}
	start := time.Now()
	if _, err := conn.WriteTo(wb, dst); err != nil {
		return 0, false
	}
	rb := make([]byte, 1500)
	for time.Now().Before(deadline) {
		n, _, err := conn.ReadFrom(rb)
		if err != nil {
			return 0, false
		}
		rm, err := icmp.ParseMessage(ipv4.ICMPTypeEchoReply.Protocol(), rb[:n])
		if err != nil {
			continue
		}
		if rm.Type != ipv4.ICMPTypeEchoReply {
			continue
		}
		echo, ok := rm.Body.(*icmp.Echo)
		if ok && echo.ID == (id&0xffff) && echo.Seq == (seq&0xffff) {
			return float64(time.Since(start).Microseconds()) / 1000.0, true
		}
	}
	return 0, false
}
