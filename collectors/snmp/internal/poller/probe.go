package poller

import (
	"context"
	"math"
	"math/rand"
	"net"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog"
	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"

	"github.com/purpledurpl075/anthri-mon/collectors/snmp/internal/model"
)

const (
	probeCount    = 3
	probeTimeout  = time.Second
	ProbeInterval = 30 * time.Second
)

// Prober sends ICMP echo requests to measure RTT and packet loss.
// Requires CAP_NET_RAW or root.  If the socket cannot be opened on startup
// all Probe calls return nil silently — metrics are simply absent, nothing crashes.
type Prober struct {
	capable bool
	log     zerolog.Logger
}

// NewProber checks for raw-socket capability and returns a ready Prober.
func NewProber(log zerolog.Logger) *Prober {
	p := &Prober{log: log.With().Str("component", "prober").Logger()}
	conn, err := icmp.ListenPacket("ip4:icmp", "0.0.0.0")
	if err != nil {
		p.log.Warn().Err(err).
			Msg("ICMP raw socket unavailable — ping probing disabled (grant CAP_NET_RAW or run as root)")
		return p
	}
	conn.Close()
	p.capable = true
	p.log.Info().Msg("ICMP prober ready")
	return p
}

// Probe sends probeCount ICMP echo requests to host.
// Returns nil when ICMP is unavailable or host cannot be resolved.
// A result with LossPct=100 means the host did not respond (ICMP may be filtered).
func (p *Prober) Probe(ctx context.Context, deviceID uuid.UUID, host string) *model.ProbeResult {
	if !p.capable {
		return nil
	}

	result := &model.ProbeResult{
		DeviceID: deviceID,
		PollTime: time.Now(),
		RttMin:   -1,
		LossPct:  100.0,
	}

	dst, err := net.ResolveIPAddr("ip4", host)
	if err != nil {
		return result
	}

	conn, err := icmp.ListenPacket("ip4:icmp", "0.0.0.0")
	if err != nil {
		return nil
	}
	defer conn.Close()

	// Random ID per call so concurrent probers don't confuse each other's replies.
	id := int(rand.Uint32() & 0xffff)

	var rtts []float64
	for seq := 0; seq < probeCount; seq++ {
		select {
		case <-ctx.Done():
			goto done
		default:
		}
		if rtt, ok := sendEcho(conn, dst, id, seq); ok {
			rtts = append(rtts, rtt)
		}
		if seq < probeCount-1 {
			time.Sleep(200 * time.Millisecond)
		}
	}

done:
	lost := probeCount - len(rtts)
	result.LossPct = float64(lost) / float64(probeCount) * 100.0

	if len(rtts) == 0 {
		return result
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
	result.RttMin = minR
	result.RttAvg = sum / float64(len(rtts))
	result.RttMax = maxR
	return result
}

// sendEcho sends one ICMP echo request and waits up to probeTimeout for a reply.
// Returns (rttMs, true) on success.
func sendEcho(conn *icmp.PacketConn, dst *net.IPAddr, id, seq int) (float64, bool) {
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

	deadline := time.Now().Add(probeTimeout)
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
