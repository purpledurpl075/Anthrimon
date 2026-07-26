// Package netconf implements a minimal NETCONF 1.0 client transport over
// SSH — just enough to drive Junos: connect, exchange <hello>, and send/
// receive <rpc>/<rpc-reply> framed with the "]]>]]>" end-of-message marker
// (RFC 4742 / NETCONF 1.0 base framing, which is what Junos uses regardless
// of the newer chunked-framing capability it also advertises).
//
// Verified live against a Junos EX3300 (15.1R7-S2): the SSH "netconf"
// subsystem, hello/capabilities exchange, and this EOM framing all work
// exactly as documented. All Junos-specific RPC bodies and reply parsing
// live in the callers (collector/netconf_juniper.go for monitoring,
// server/netconf.go + the hub's configmgmt/netconf.py for config push) —
// this package only knows how to move XML in and out.
package netconf

import (
	"fmt"
	"io"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

const eom = "]]>]]>"

const helloXML = `<?xml version="1.0" encoding="UTF-8"?>
<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
  <capabilities>
    <capability>urn:ietf:params:netconf:base:1.0</capability>
  </capabilities>
</hello>
` + eom

// Session is one open NETCONF-over-SSH connection.
type Session struct {
	client    *ssh.Client
	sshSess   *ssh.Session
	stdin     io.Writer
	ch        chan []byte
	nextMsgID int
}

// Dial connects to host:port, authenticates with username/password, opens
// the "netconf" SSH subsystem, and completes the <hello> exchange. The
// server's own <hello> (with its capability list) is read and discarded —
// callers that need it should use DialWithHello instead.
func Dial(host string, port int, username, password string, timeout time.Duration) (*Session, error) {
	s, _, err := DialWithHello(host, port, username, password, timeout)
	return s, err
}

// DialWithHello is Dial but also returns the server's raw <hello> XML, for
// callers that want to inspect advertised capabilities.
func DialWithHello(host string, port int, username, password string, timeout time.Duration) (*Session, string, error) {
	cfg := &ssh.ClientConfig{
		User: username,
		Auth: []ssh.AuthMethod{
			ssh.Password(password),
			ssh.KeyboardInteractive(func(_, _ string, questions []string, _ []bool) ([]string, error) {
				ans := make([]string, len(questions))
				for i := range ans {
					ans[i] = password
				}
				return ans, nil
			}),
		},
		// Junos NETCONF listens on its own port (830) specifically for
		// automation access; TOFU pinning (used for the CLI/show-run SSH
		// path) isn't wired up for this port and isn't worth the extra
		// surface here — same trust model as the collector's other
		// device-facing transports that don't pin (e.g. configexec.go).
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), //nolint:gosec
		Timeout:         timeout,
	}

	addr := fmt.Sprintf("%s:%d", host, port)
	client, err := ssh.Dial("tcp", addr, cfg)
	if err != nil {
		return nil, "", fmt.Errorf("netconf dial %s: %w", addr, err)
	}

	sshSess, err := client.NewSession()
	if err != nil {
		client.Close()
		return nil, "", fmt.Errorf("netconf session: %w", err)
	}

	stdin, err := sshSess.StdinPipe()
	if err != nil {
		sshSess.Close()
		client.Close()
		return nil, "", fmt.Errorf("netconf stdin: %w", err)
	}
	stdout, err := sshSess.StdoutPipe()
	if err != nil {
		sshSess.Close()
		client.Close()
		return nil, "", fmt.Errorf("netconf stdout: %w", err)
	}

	if err := sshSess.RequestSubsystem("netconf"); err != nil {
		sshSess.Close()
		client.Close()
		return nil, "", fmt.Errorf("netconf subsystem: %w", err)
	}

	s := &Session{
		client:    client,
		sshSess:   sshSess,
		stdin:     stdin,
		ch:        make(chan []byte, 512),
		nextMsgID: 1,
	}
	go s.pump(stdout)

	serverHello, err := s.readUntilEOM(timeout)
	if err != nil {
		s.Close()
		return nil, "", fmt.Errorf("netconf server hello: %w", err)
	}

	if _, err := io.WriteString(stdin, helloXML); err != nil {
		s.Close()
		return nil, "", fmt.Errorf("netconf client hello: %w", err)
	}

	return s, serverHello, nil
}

// pump continuously reads from r into a buffered channel until EOF/error.
func (s *Session) pump(r io.Reader) {
	defer close(s.ch)
	buf := make([]byte, 8192)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			data := make([]byte, n)
			copy(data, buf[:n])
			s.ch <- data
		}
		if err != nil {
			return
		}
	}
}

// readUntilEOM accumulates from the pump channel until the "]]>]]>" marker
// appears, returning everything before it (the marker itself is discarded).
func (s *Session) readUntilEOM(timeout time.Duration) (string, error) {
	var buf []byte
	deadline := time.After(timeout)
	for {
		select {
		case data, ok := <-s.ch:
			if !ok {
				return string(buf), io.EOF
			}
			buf = append(buf, data...)
			if idx := strings.Index(string(buf), eom); idx >= 0 {
				return string(buf[:idx]), nil
			}
		case <-deadline:
			return string(buf), fmt.Errorf("timeout waiting for %q (got %d bytes)", eom, len(buf))
		}
	}
}

// RPC sends one <rpc>...</rpc> request (body is the inner XML — the
// operation element(s), no <rpc> wrapper) and returns the raw <rpc-reply>
// XML (including its own wrapper, for callers that want to unmarshal the
// whole thing). message-id is assigned automatically and not meaningful to
// callers since this client only ever has one request in flight at a time.
func (s *Session) RPC(body string, timeout time.Duration) (string, error) {
	msgID := s.nextMsgID
	s.nextMsgID++
	req := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<rpc message-id="%d" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">
%s
</rpc>
%s`, msgID, body, eom)

	if _, err := io.WriteString(s.stdin, req); err != nil {
		return "", fmt.Errorf("netconf write rpc: %w", err)
	}
	reply, err := s.readUntilEOM(timeout)
	if err != nil {
		return reply, fmt.Errorf("netconf read reply: %w", err)
	}
	return reply, nil
}

// Close ends the NETCONF session and the underlying SSH connection. Safe to
// call multiple times.
func (s *Session) Close() {
	if s.sshSess != nil {
		_ = s.sshSess.Close()
	}
	if s.client != nil {
		_ = s.client.Close()
	}
}
