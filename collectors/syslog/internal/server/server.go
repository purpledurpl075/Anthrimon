// Package server implements the UDP and TCP listeners for RFC 3164 and
// RFC 5424 syslog messages. A single Server instance manages one UDP socket
// and one TCP socket. Both listeners run concurrently and shut down cleanly
// when the context is cancelled.
package server

import (
	"bufio"
	"context"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"

	"github.com/purpledurpl075/anthri-mon/collectors/syslog/internal/config"
	"github.com/purpledurpl075/anthri-mon/collectors/syslog/internal/lookup"
	"github.com/purpledurpl075/anthri-mon/collectors/syslog/internal/parser"
	"github.com/purpledurpl075/anthri-mon/collectors/syslog/internal/writer"
)

// Server owns the UDP and TCP listeners and dispatches parsed syslog messages.
type Server struct {
	cfg    *config.Config
	lookup *lookup.DeviceLookup
	writer *writer.Writer
	log    zerolog.Logger
}

// NewServer constructs a Server. Call Run(ctx) to start listening.
func NewServer(cfg *config.Config, lkp *lookup.DeviceLookup, w *writer.Writer, log zerolog.Logger) *Server {
	return &Server{
		cfg:    cfg,
		lookup: lkp,
		writer: w,
		log:    log.With().Str("component", "server").Logger(),
	}
}

// Run starts both the UDP and TCP listeners and blocks until ctx is cancelled.
// It returns nil on clean shutdown; context cancellation is swallowed here.
func (s *Server) Run(ctx context.Context) error {
	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		s.listenUDP(ctx)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		s.listenTCP(ctx)
	}()

	wg.Wait()
	return nil
}

// ---------------------------------------------------------------------------
// UDP listener
// ---------------------------------------------------------------------------

// listenUDP binds a UDP socket and dispatches each datagram as a syslog
// message. Closing the connection on ctx cancellation immediately unblocks the
// ReadFrom call, mirroring the flow-collector pattern.
func (s *Server) listenUDP(ctx context.Context) {
	conn, err := net.ListenPacket("udp", s.cfg.Listener.UDPAddr)
	if err != nil {
		s.log.Error().Err(err).Str("addr", s.cfg.Listener.UDPAddr).Msg("failed to bind udp listener")
		return
	}

	// Close the connection when the context is cancelled so ReadFrom unblocks.
	go func() {
		<-ctx.Done()
		conn.Close()
	}()

	s.log.Info().Str("addr", s.cfg.Listener.UDPAddr).Msg("udp syslog listener ready")

	buf := make([]byte, s.cfg.Listener.BufferSize)
	for {
		n, remote, err := conn.ReadFrom(buf)
		if err != nil {
			if ctx.Err() != nil {
				return // clean shutdown
			}
			s.log.Debug().Err(err).Str("addr", s.cfg.Listener.UDPAddr).Msg("udp read error")
			continue
		}
		pkt := make([]byte, n)
		copy(pkt, buf[:n])
		go s.dispatchMessage(pkt, remoteToIPv4(remote))
	}
}

// ---------------------------------------------------------------------------
// TCP listener
// ---------------------------------------------------------------------------

// listenTCP binds a TCP socket and accepts connections. Each connection is
// handled in its own goroutine. When the context is cancelled the listener is
// closed which causes Accept to return an error, stopping the loop.
func (s *Server) listenTCP(ctx context.Context) {
	ln, err := net.Listen("tcp", s.cfg.Listener.TCPAddr)
	if err != nil {
		s.log.Error().Err(err).Str("addr", s.cfg.Listener.TCPAddr).Msg("failed to bind tcp listener")
		return
	}

	// Close the listener when the context is cancelled so Accept unblocks.
	go func() {
		<-ctx.Done()
		ln.Close()
	}()

	s.log.Info().Str("addr", s.cfg.Listener.TCPAddr).Msg("tcp syslog listener ready")

	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return // clean shutdown
			}
			s.log.Debug().Err(err).Str("addr", s.cfg.Listener.TCPAddr).Msg("tcp accept error")
			continue
		}
		go s.handleTCPConn(ctx, conn)
	}
}

// handleTCPConn reads syslog messages from a TCP connection until it is closed
// or the context is cancelled. It handles both newline-framed messages and
// RFC 6587 octet-counted framing.
//
// Octet-counting detection: if a line begins with one or more digits followed
// by a space and then '<', it is treated as "<count> <syslog-line>".
func (s *Server) handleTCPConn(ctx context.Context, conn net.Conn) {
	defer conn.Close()

	// Close connection when context is cancelled so the scanner unblocks.
	go func() {
		<-ctx.Done()
		conn.Close()
	}()

	remoteIP := remoteToIPv4(conn.RemoteAddr())

	scanner := bufio.NewScanner(conn)
	maxLine := s.cfg.Listener.BufferSize
	if maxLine <= 0 {
		maxLine = 8192
	} else if maxLine > 65536 {
		maxLine = 65536
	}
	scanner.Buffer(make([]byte, maxLine), maxLine)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		// Detect octet-counted framing: "N <syslog-line>" where N is a decimal
		// integer and the next character after the space is '<'.
		if data, ok := stripOctetCount(line); ok {
			pkt := make([]byte, len(data))
			copy(pkt, data)
			s.dispatchMessage(pkt, remoteIP)
		} else {
			pkt := make([]byte, len(line))
			copy(pkt, line)
			s.dispatchMessage(pkt, remoteIP)
		}
	}

	if err := scanner.Err(); err != nil && ctx.Err() == nil {
		s.log.Debug().Err(err).Str("remote", conn.RemoteAddr().String()).Msg("tcp connection read error")
	}
}

// stripOctetCount checks whether line begins with "<N> <syslog-msg>" octet
// counting framing (RFC 6587 §3.4.1). It returns the syslog portion and true
// if so, otherwise nil and false.
func stripOctetCount(line []byte) ([]byte, bool) {
	// Must have at least one digit, a space, and a '<'.
	i := 0
	for i < len(line) && line[i] >= '0' && line[i] <= '9' {
		i++
	}
	if i == 0 || i >= len(line) || line[i] != ' ' {
		return nil, false
	}
	rest := line[i+1:]
	if len(rest) == 0 || rest[0] != '<' {
		return nil, false
	}
	// Parse count for best-effort validation; we always accept the message.
	_, _ = strconv.Atoi(strings.TrimSpace(string(line[:i])))
	return rest, true
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

// dispatchMessage parses a raw syslog line, enriches it with device lookup
// data, and forwards it to the ClickHouse writer.
func (s *Server) dispatchMessage(data []byte, sourceIP net.IP) {
	// Resolve the platform timezone to a *time.Location for RFC 3164 parsing.
	tz := s.lookup.Timezone()
	loc, err := time.LoadLocation(tz)
	if err != nil {
		loc = time.UTC
	}

	msg := parser.Parse(data, sourceIP, loc)
	msg.DeviceID = s.lookup.Lookup(sourceIP)

	// Fill hostname from source IP if the parser did not find one.
	if msg.Hostname == "" || msg.Hostname == "-" {
		if sourceIP != nil {
			msg.Hostname = sourceIP.String()
		}
	}

	s.writer.Write(msg)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// remoteToIPv4 extracts a 4-byte IPv4 net.IP from a net.Addr.
func remoteToIPv4(addr net.Addr) net.IP {
	switch v := addr.(type) {
	case *net.UDPAddr:
		if v4 := v.IP.To4(); v4 != nil {
			return v4
		}
		return v.IP
	case *net.TCPAddr:
		if v4 := v.IP.To4(); v4 != nil {
			return v4
		}
		return v.IP
	}
	// Fallback: parse from string representation.
	host, _, err := net.SplitHostPort(addr.String())
	if err != nil {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return nil
	}
	if v4 := ip.To4(); v4 != nil {
		return v4
	}
	return ip
}

