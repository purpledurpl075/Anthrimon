package server

// One-shot SFTP server for collector-managed AOS-CX rollback (#41).
//
// AOS-CX's `copy sftp://<user>@<host>:<port>/<file> running-config vrf <vrf>
// overwrite` does a true full-replace from plain CLI text. This file hosts
// that one file (anthrimon_rb) on the collector's device-facing IP, exactly
// once, IP-locked to the device — mirroring startConfigServer's one-shot HTTP
// server but speaking SFTP-over-SSH since AOS-CX rejects sftp://user:pass@
// URLs (the password must be supplied at the interactive prompt instead).
//
// AOS-CX's SFTP client canonicalizes "." to "/" and stats "/." as a
// directory before fetching the file. sftp.NewRequestServer's default
// cleanPathWithBase normalization (base "/") already turns "." and "/./X"
// into "/" and "/X" for both Realpath and Open/Stat/Lstat requests, so the
// Handlers below only ever see "/" or "/anthrimon_rb" — no custom
// canonicalize code needed.

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

const (
	sftpRollbackFilename   = "anthrimon_rb"
	sftpAcceptTimeout      = 120 * time.Second
	sftpHostKeyPathDefault = "/etc/anthrimon/rollback_sftp_host_key"
)

// ── one-shot SFTP server ───────────────────────────────────────────────────

type sftpServer struct {
	url      string
	password string
	ln       net.Listener

	mu     sync.Mutex
	conn   net.Conn
	served bool
}

func (ss *sftpServer) wasServed() bool {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	return ss.served
}

func (ss *sftpServer) shutdown() {
	_ = ss.ln.Close()
	ss.mu.Lock()
	c := ss.conn
	ss.mu.Unlock()
	if c != nil {
		_ = c.Close()
	}
}

// startSFTPServer hosts `text` as /anthrimon_rb on the device-facing IP
// (ports 5050-5054), served exactly once over SFTP to expectedSrc, using a
// random one-shot username/password. The returned URL has no embedded
// password (AOS-CX rejects sftp://user:pass@host URLs) — callers send
// ss.password at the interactive password prompt instead.
func startSFTPServer(deviceIP, expectedSrc, text string) (*sftpServer, error) {
	bindIP := outboundIPTo(deviceIP)
	var ln net.Listener
	var port int
	for p := 5050; p <= 5054; p++ {
		l, err := net.Listen("tcp", fmt.Sprintf("%s:%d", bindIP, p))
		if err == nil {
			ln, port = l, p
			break
		}
	}
	if ln == nil {
		return nil, fmt.Errorf("no free port in 5050-5054 on %s", bindIP)
	}

	hostKey, err := loadOrCreateSFTPHostKey()
	if err != nil {
		_ = ln.Close()
		return nil, fmt.Errorf("sftp host key: %w", err)
	}

	user, err := randHex(8)
	if err != nil {
		_ = ln.Close()
		return nil, err
	}
	pass, err := randHex(16)
	if err != nil {
		_ = ln.Close()
		return nil, err
	}

	ss := &sftpServer{
		url:      fmt.Sprintf("sftp://%s@%s:%d/%s", user, bindIP, port, sftpRollbackFilename),
		password: pass,
		ln:       ln,
	}

	cfg := &ssh.ServerConfig{
		PasswordCallback: func(c ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
			if c.User() == user && string(password) == pass {
				return nil, nil
			}
			return nil, fmt.Errorf("invalid credentials")
		},
	}
	cfg.AddHostKey(hostKey)

	go serveSFTPRollback(ss, cfg, expectedSrc, []byte(text))
	return ss, nil
}

func randHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// serveSFTPRollback accepts connections until one from expectedSrc arrives
// (or sftpAcceptTimeout elapses), then handles exactly that one connection.
func serveSFTPRollback(ss *sftpServer, cfg *ssh.ServerConfig, expectedSrc string, data []byte) {
	defer ss.shutdown()
	deadline := time.Now().Add(sftpAcceptTimeout)
	for {
		if tcpLn, ok := ss.ln.(*net.TCPListener); ok {
			_ = tcpLn.SetDeadline(deadline)
		}
		conn, err := ss.ln.Accept()
		if err != nil {
			return
		}
		peer := conn.RemoteAddr().String()
		if h, _, err := net.SplitHostPort(peer); err == nil {
			peer = h
		}
		if expectedSrc != "" && peer != expectedSrc {
			_ = conn.Close()
			continue
		}
		if tcpConn, ok := conn.(*net.TCPConn); ok {
			_ = tcpConn.SetDeadline(time.Now().Add(sftpAcceptTimeout))
		}
		ss.mu.Lock()
		ss.conn = conn
		ss.mu.Unlock()
		handleSFTPConn(conn, cfg, ss, data)
		return
	}
}

func handleSFTPConn(conn net.Conn, cfg *ssh.ServerConfig, ss *sftpServer, data []byte) {
	defer conn.Close()
	sconn, chans, reqs, err := ssh.NewServerConn(conn, cfg)
	if err != nil {
		return
	}
	defer sconn.Close()
	go ssh.DiscardRequests(reqs)

	for newChan := range chans {
		if newChan.ChannelType() != "session" {
			_ = newChan.Reject(ssh.UnknownChannelType, "unsupported channel type")
			continue
		}
		channel, requests, err := newChan.Accept()
		if err != nil {
			return
		}
		go func(in <-chan *ssh.Request) {
			for req := range in {
				ok := req.Type == "subsystem" && len(req.Payload) >= 4 && string(req.Payload[4:]) == "sftp"
				if req.WantReply {
					_ = req.Reply(ok, nil)
				}
			}
		}(requests)

		rs := sftp.NewRequestServer(channel, newRollbackSFTPHandlers(data, ss))
		_ = rs.Serve()
		_ = rs.Close()
		_ = channel.Close()
	}
}

// ── host key persistence ───────────────────────────────────────────────────

// loadOrCreateSFTPHostKey loads the persisted RSA host key, generating one on
// first use. AOS-CX hard-fails ("Host key verification failed") on a 2nd
// rollback to the same [host]:port if the host key changed, so this MUST be
// stable across rollbacks.
func loadOrCreateSFTPHostKey() (ssh.Signer, error) {
	path := os.Getenv("ANTHRIMON_ROLLBACK_SFTP_HOSTKEY")
	if path == "" {
		path = sftpHostKeyPathDefault
	}

	if data, err := os.ReadFile(path); err == nil {
		return ssh.ParsePrivateKey(data)
	}

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(key),
	})
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, pemBytes, 0o600); err != nil {
		return nil, err
	}
	return ssh.ParsePrivateKey(pemBytes)
}

// ── SFTP handlers: serve /anthrimon_rb read-only at the root ──────────────

type rollbackFileInfo struct {
	name    string
	size    int64
	mode    os.FileMode
	modTime time.Time
}

func (fi *rollbackFileInfo) Name() string       { return fi.name }
func (fi *rollbackFileInfo) Size() int64        { return fi.size }
func (fi *rollbackFileInfo) Mode() os.FileMode  { return fi.mode }
func (fi *rollbackFileInfo) ModTime() time.Time { return fi.modTime }
func (fi *rollbackFileInfo) IsDir() bool        { return fi.mode.IsDir() }
func (fi *rollbackFileInfo) Sys() any           { return nil }

type rollbackListerAt []os.FileInfo

func (l rollbackListerAt) ListAt(ls []os.FileInfo, offset int64) (int, error) {
	if offset >= int64(len(l)) {
		return 0, io.EOF
	}
	n := copy(ls, l[offset:])
	if n < len(ls) {
		return n, io.EOF
	}
	return n, nil
}

// rollbackSFTPHandlers implements sftp.Handlers for a single read-only file
// at the SFTP root. Filelist answers Stat/Lstat for "/" (a directory) and
// "/anthrimon_rb" (the file); Fileread serves the file's contents and marks
// ss.served on the first (and only expected) read-open.
type rollbackSFTPHandlers struct {
	data    []byte
	ss      *sftpServer
	modTime time.Time
}

func newRollbackSFTPHandlers(data []byte, ss *sftpServer) sftp.Handlers {
	h := &rollbackSFTPHandlers{data: data, ss: ss, modTime: time.Now()}
	return sftp.Handlers{FileGet: h, FilePut: h, FileCmd: h, FileList: h}
}

func (h *rollbackSFTPHandlers) Fileread(r *sftp.Request) (io.ReaderAt, error) {
	if r.Filepath != "/"+sftpRollbackFilename {
		return nil, os.ErrNotExist
	}
	h.ss.mu.Lock()
	h.ss.served = true
	h.ss.mu.Unlock()
	return bytes.NewReader(h.data), nil
}

func (h *rollbackSFTPHandlers) Filewrite(r *sftp.Request) (io.WriterAt, error) {
	return nil, sftp.ErrSSHFxOpUnsupported
}

func (h *rollbackSFTPHandlers) Filecmd(r *sftp.Request) error {
	return sftp.ErrSSHFxOpUnsupported
}

func (h *rollbackSFTPHandlers) Filelist(r *sftp.Request) (sftp.ListerAt, error) {
	switch r.Filepath {
	case "/":
		if r.Method == "List" {
			return rollbackListerAt{
				&rollbackFileInfo{name: sftpRollbackFilename, size: int64(len(h.data)), mode: 0o644, modTime: h.modTime},
			}, nil
		}
		return rollbackListerAt{
			&rollbackFileInfo{name: "/", mode: os.ModeDir | 0o755, modTime: h.modTime},
		}, nil
	case "/" + sftpRollbackFilename:
		return rollbackListerAt{
			&rollbackFileInfo{name: sftpRollbackFilename, size: int64(len(h.data)), mode: 0o644, modTime: h.modTime},
		}, nil
	default:
		return nil, os.ErrNotExist
	}
}
