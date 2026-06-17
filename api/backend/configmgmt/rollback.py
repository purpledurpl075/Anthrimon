"""Config rollback via device-pulls-from-HTTP.

Why this exists:
  The previous implementation pasted the saved config back to the device
  through SSH config mode, line by line.  That broke whenever a vendor
  prompted for confirmation mid-paste ("Do you want to continue (y/n)?",
  "% Warning: this will restart BGP sessions ...", etc.) because Netmiko
  has no way to know which prompt belongs to which line.  It was also
  slow — Aruba CX takes a minute or more for a few hundred lines.

How this works:
  1. The hub starts a one-shot HTTP server on the device-facing IP (a fixed
     high-port range, default 5050-5054) with a random token in the URL path,
     IP-locked to the target device.  See serve_rollback() below for why this
     beats serving through the main API / nginx.
  2. The hub SSHes to the device and runs a *vendor-specific* one-or-two
     command recipe that tells the device "fetch this config from the hub
     over HTTP and apply it" (the vendor's own replace semantics).
  3. The device does a single HTTP GET to http://<hub-ip>:<port>/<token>.
     The server serves the backup text exactly once to that source IP, flips
     its served flag, and shuts down — no second fetch is possible.
  4. The device applies the config atomically using vendor commands like
     `configure replace` (Cisco/Arista), `copy <url> running-config` (Aruba CX),
     `load override` + `commit` (Juniper).  Prompts are handled in the recipe.

This is the pattern every NMS uses for this kind of thing.  It works in
seconds, handles interactive prompts on the device side (the device
prompts itself, not Netmiko), and gives us real vendor replace semantics
on most platforms.
"""
from __future__ import annotations

import http.server
import socket
import socketserver
import struct
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Optional

import structlog

logger = structlog.get_logger(__name__)


# ── Hub-facing IP for the device ──────────────────────────────────────────────

def _hub_ip_for_device(device_ip: str) -> str:
    """Pick the local IP that's on the same routable path as the device.
    Uses a UDP 'connect' to a discard port — no packets are actually sent
    but the kernel resolves which interface/source IP would be used."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect((device_ip, 9))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception as exc:
        logger.warning("hub_ip_autodetect_failed", device_ip=device_ip, error=str(exc))
        return "0.0.0.0"


# ── One-shot HTTP server bound to a high port on the device-facing IP ─────────
#
# Why not the main API listener?  Because the main API is bound to 127.0.0.1
# and only nginx exposes it externally.  Devices doing `copy http://...`
# generally don't trust self-signed certs and don't want to deal with nginx
# proxy quirks.  An ephemeral plain-HTTP server bound to the device-facing
# IP, serving exactly one request, IP-locked to the device, is the simplest
# correct shape — no exposure window, no firewall config, no cert dance.

@dataclass
class RollbackFetcher:
    """Holds the live one-shot server (HTTP, TFTP, or SFTP) + the URL the
    device should use to fetch the config."""
    url:           str
    served_event:  threading.Event
    server:        object
    thread:        threading.Thread
    token:         str
    # For SFTP: AOS-CX rejects `sftp://user:pass@host/...` URLs, so the
    # one-shot password is carried separately and answered interactively by
    # the recipe step (see serve_rollback_sftp / _aruba_cx_recipe).
    sftp_password: Optional[str] = None

    def url_for_device(self) -> str:
        return self.url

    def wait_served(self, timeout: float) -> bool:
        return self.served_event.wait(timeout)

    def shutdown(self) -> None:
        try:
            self.server.shutdown()
        except Exception:
            pass
        try:
            self.server.server_close()
        except Exception:
            pass


import os

# Fixed port range, so firewall rules can be installer-managed.  The hub
# picks the first free port in this range when a rollback fires.  Operators
# can override via the ANTHRIMON_ROLLBACK_PORTS env var (e.g. "5050-5054").
_ROLLBACK_PORT_RANGE_DEFAULT = (5050, 5054)


def _rollback_port_range() -> tuple[int, int]:
    raw = os.environ.get("ANTHRIMON_ROLLBACK_PORTS", "")
    if raw and "-" in raw:
        try:
            lo, hi = raw.split("-", 1)
            return int(lo), int(hi)
        except ValueError:
            pass
    return _ROLLBACK_PORT_RANGE_DEFAULT


def _find_free_port(bind_ip: str) -> int:
    """Pick the first port in the configured range that's free to bind (TCP)."""
    lo, hi = _rollback_port_range()
    for p in range(lo, hi + 1):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind((bind_ip, p))
                return p
        except OSError:
            continue
    raise RuntimeError(
        f"No free rollback port in range {lo}-{hi}.  "
        f"Increase the range via ANTHRIMON_ROLLBACK_PORTS or kill stale rollback jobs."
    )


def _find_free_port_udp(bind_ip: str) -> int:
    """Pick the first port in the configured range that's free to bind (UDP).
    Same range as _find_free_port() — TCP and UDP port spaces don't collide,
    and the installer only needs to open one range per protocol."""
    lo, hi = _rollback_port_range()
    for p in range(lo, hi + 1):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind((bind_ip, p))
                return p
        except OSError:
            continue
    raise RuntimeError(
        f"No free UDP rollback port in range {lo}-{hi}.  "
        f"Increase the range via ANTHRIMON_ROLLBACK_PORTS or kill stale rollback jobs."
    )


def serve_rollback(
    config_text: str, expected_source_ip: str, timeout: float = 120.0,
) -> RollbackFetcher:
    """Start a one-shot HTTP server on the device-facing IP that will serve
    `config_text` exactly once to a request coming FROM `expected_source_ip`.
    Returns the URL the device should fetch (token-embedded path).

    Uses a fixed port range (default 5050-5054) so the installer can open the
    firewall once.  Thread is daemonized — if the caller crashes, the server
    dies with it.
    """
    bind_ip = _hub_ip_for_device(expected_source_ip)
    port    = _find_free_port(bind_ip)
    token   = uuid.uuid4().hex
    served  = threading.Event()
    served_payload = {"text": config_text}

    class _Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            # Silence the default stderr logging
            return
        def _peer_ip(self) -> str:
            xff = self.headers.get("X-Forwarded-For", "")
            return xff.split(",")[0].strip() if xff else self.client_address[0]
        def do_GET(self):
            peer = self._peer_ip()
            if not self.path.endswith(f"/{token}"):
                self.send_response(404); self.end_headers(); return
            if peer != expected_source_ip:
                logger.warning("rollback_fetch_ip_mismatch", expected=expected_source_ip, got=peer)
                self.send_response(403); self.end_headers(); return
            if served.is_set():
                self.send_response(404); self.end_headers(); return
            served.set()
            data = served_payload["text"].encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            logger.info("rollback_fetch_served", source_ip=peer, bytes=len(data))

    # Bind to the port we chose from the configured range.  Use ThreadingTCPServer
    # so each request gets its own handler, but practically there's only ever one
    # request before the served flag flips.
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    server = socketserver.ThreadingTCPServer((bind_ip, port), _Handler)
    url = f"http://{bind_ip}:{port}/{token}"

    def _serve_until_done():
        deadline = time.time() + timeout
        server.timeout = 1
        while not served.is_set() and time.time() < deadline:
            server.handle_request()
        try:
            server.server_close()
        except Exception:
            pass

    t = threading.Thread(target=_serve_until_done, daemon=True)
    t.start()
    logger.info("rollback_server_started", bind=bind_ip, port=port,
                expected_ip=expected_source_ip, timeout_s=timeout)

    return RollbackFetcher(url=url, served_event=served,
                           server=server, thread=t, token=token)


# ── One-shot TFTP server (for vendors whose `copy` doesn't speak HTTP) ────────
#
# AOS-CX's `copy <REMOTE-URL> checkpoint <NAME>` only accepts tftp:// or sftp://
# sources — http:// is rejected by the CLI parser before it ever reaches
# hpe-config (so it fails silently: no syslog event, checkpoint never created,
# and the follow-up `copy checkpoint <NAME> running-config` then fails with
# "Checkpoint <NAME> doesn't exist"). This is a minimal RFC 1350 read-only
# server: it answers exactly one RRQ from `expected_source_ip`, ignores the
# requested filename/mode and any transfer-size/blksize options (so clients
# fall back to the standard 512-byte block size per RFC 2347), and stops after
# the final short block is ACKed.

_TFTP_OPCODE_RRQ   = 1
_TFTP_OPCODE_DATA  = 3
_TFTP_OPCODE_ACK   = 4
_TFTP_BLOCK_SIZE   = 512


class _TftpServerHandle:
    """Mimics the bits of socketserver.TCPServer that RollbackFetcher.shutdown()
    calls, so one RollbackFetcher type covers both transports."""

    def __init__(self, sock: socket.socket):
        self._sock = sock
        self._stop = threading.Event()

    def shutdown(self) -> None:
        self._stop.set()
        try:
            self._sock.close()
        except Exception:
            pass

    def server_close(self) -> None:
        pass

    @property
    def stopped(self) -> bool:
        return self._stop.is_set()


def serve_rollback_tftp(
    config_text: str, expected_source_ip: str, timeout: float = 120.0,
) -> RollbackFetcher:
    """Start a one-shot TFTP server on the device-facing IP that answers a
    single read request from `expected_source_ip` with `config_text`, then
    stops.  Returns a RollbackFetcher whose .url is a tftp:// URL."""
    bind_ip = _hub_ip_for_device(expected_source_ip)
    port    = _find_free_port_udp(bind_ip)
    token   = uuid.uuid4().hex
    served  = threading.Event()
    data    = config_text.encode("utf-8")

    listen_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    listen_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listen_sock.bind((bind_ip, port))
    listen_sock.settimeout(1.0)

    handle = _TftpServerHandle(listen_sock)
    url = f"tftp://{bind_ip}:{port}/{token}"

    def _send_block(xfer: socket.socket, addr, block_num: int, chunk: bytes) -> bool:
        """Send one DATA block, retrying on missing ACK.  Returns True once
        the matching ACK is received."""
        packet = struct.pack("!HH", _TFTP_OPCODE_DATA, block_num) + chunk
        for _attempt in range(5):
            xfer.sendto(packet, addr)
            try:
                ack, ack_addr = xfer.recvfrom(65536)
            except socket.timeout:
                continue
            if ack_addr[0] != addr[0]:
                continue
            if len(ack) < 4:
                continue
            opcode, ack_block = struct.unpack("!HH", ack[:4])
            if opcode == _TFTP_OPCODE_ACK and ack_block == block_num:
                return True
        return False

    def _serve_until_done():
        deadline = time.time() + timeout
        addr = None
        # Wait for a valid RRQ from the expected source.
        while time.time() < deadline and not handle.stopped:
            try:
                pkt, peer = listen_sock.recvfrom(65536)
            except socket.timeout:
                continue
            except OSError:
                break
            if peer[0] != expected_source_ip:
                logger.warning("rollback_tftp_rrq_ip_mismatch",
                               expected=expected_source_ip, got=peer[0])
                continue
            if len(pkt) < 2 or struct.unpack("!H", pkt[:2])[0] != _TFTP_OPCODE_RRQ:
                continue
            addr = peer
            break

        try:
            listen_sock.close()
        except Exception:
            pass
        if addr is None:
            return

        # New ephemeral socket for the actual transfer (its own TID, per RFC 1350).
        xfer = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        xfer.bind((bind_ip, 0))
        xfer.settimeout(5.0)
        try:
            block_num = 0
            offset = 0
            while True:
                block_num = (block_num + 1) & 0xFFFF
                chunk = data[offset:offset + _TFTP_BLOCK_SIZE]
                offset += len(chunk)
                if not _send_block(xfer, addr, block_num, chunk):
                    logger.warning("rollback_tftp_no_ack", block=block_num, peer=addr[0])
                    return
                if len(chunk) < _TFTP_BLOCK_SIZE:
                    served.set()
                    logger.info("rollback_fetch_served", source_ip=addr[0], bytes=len(data))
                    return
        finally:
            xfer.close()

    t = threading.Thread(target=_serve_until_done, daemon=True)
    t.start()
    logger.info("rollback_tftp_server_started", bind=bind_ip, port=port,
                expected_ip=expected_source_ip, timeout_s=timeout)

    return RollbackFetcher(url=url, served_event=served,
                           server=handle, thread=t, token=token)


# ── One-shot SFTP server (for AOS-CX `copy ... running-config ... overwrite`) ─
#
# `copy sftp://user@host:port/file running-config vrf <vrf> overwrite` accepts
# plain CLI text (exactly config_backups.config_text) and performs a TRUE full
# replace -- proven live by serving a copy of a device's own running-config
# with a vlan removed, applying it with `overwrite`, confirming the vlan is
# gone, then re-serving the original and confirming a byte-exact restore.
#
# AOS-CX's SFTP client has two quirks every server here must handle:
#   - canonicalize(".") must return "/" (a directory), not the served file's
#     own path -- else "local open \".\": Is a directory" / "Error downloading
#     file".
#   - stat()/lstat()/open() are called with paths like "/./<filename>" --
#     normalize via os.path.normpath().lstrip("/") (mapping "."/"" -> root)
#     before comparing to the target filename.
#
# The URL must NOT embed a password (`sftp://user:pass@host/...` is rejected
# client-side with "Failed to validate URL. Invalid user name."). AOS-CX always
# prompts for the password interactively, regardless of URL form -- the
# one-shot password is returned via RollbackFetcher.sftp_password for the
# recipe step to answer that prompt.
#
# A persisted host key is mandatory: a NEW [host]:port pair triggers a
# one-time "yes/no" host-key trust prompt (handled by the recipe's
# expect/response), but if the SAME [host]:port is later presented with a
# DIFFERENT key, AOS-CX hard-fails with "Host key verification failed" and
# there's no clean recovery short of manual `known-host` cleanup on the
# device.

_SFTP_HOST_KEY_PATH_DEFAULT = "/var/lib/anthrimon/rollback_sftp_host_key"


def _load_or_create_sftp_host_key():
    import paramiko

    path = os.environ.get("ANTHRIMON_ROLLBACK_SFTP_HOSTKEY", _SFTP_HOST_KEY_PATH_DEFAULT)
    if os.path.exists(path):
        return paramiko.RSAKey(filename=path)
    key = paramiko.RSAKey.generate(2048)
    key.write_private_key_file(path)
    os.chmod(path, 0o600)
    return key


class _SftpServerHandle:
    """Mimics the bits of socketserver.TCPServer that RollbackFetcher.shutdown()
    calls, so one RollbackFetcher type covers all transports."""

    def __init__(self, sock: socket.socket):
        self._sock = sock
        self._stop = threading.Event()

    def shutdown(self) -> None:
        self._stop.set()
        try:
            self._sock.close()
        except Exception:
            pass

    def server_close(self) -> None:
        pass

    @property
    def stopped(self) -> bool:
        return self._stop.is_set()


def _make_rollback_sftp_server_interface(data: bytes, filename: str, served: threading.Event):
    import paramiko

    class _Handle(paramiko.SFTPHandle):
        def __init__(self, flags: int = 0):
            super().__init__(flags)

        def stat(self):
            attr = paramiko.SFTPAttributes()
            attr.st_size = len(data)
            attr.st_mode = 0o100644
            return attr

        def read(self, offset, length):
            return data[offset:offset + length]

        def close(self):
            return paramiko.SFTP_OK

    class _Interface(paramiko.SFTPServerInterface):
        def _norm(self, path: str) -> str:
            norm = os.path.normpath(path).lstrip("/")
            return "" if norm == "." else norm

        def stat(self, path):
            norm = self._norm(path)
            attr = paramiko.SFTPAttributes()
            if norm == filename:
                attr.st_size = len(data)
                attr.st_mode = 0o100644
                attr.filename = filename
                return attr
            if norm == "":
                attr.st_mode = 0o40755
                attr.filename = "/"
                return attr
            return paramiko.SFTP_NO_SUCH_FILE

        def lstat(self, path):
            return self.stat(path)

        def open(self, path, flags, attr):
            if self._norm(path) != filename:
                return paramiko.SFTP_NO_SUCH_FILE
            served.set()
            return _Handle()

        def canonicalize(self, path):
            return "/" if path in ("", ".", "/") else path

        def list_folder(self, path):
            return paramiko.SFTP_OP_UNSUPPORTED

        def remove(self, path):
            return paramiko.SFTP_OP_UNSUPPORTED

        def rename(self, oldpath, newpath):
            return paramiko.SFTP_OP_UNSUPPORTED

        def mkdir(self, path, attr):
            return paramiko.SFTP_OP_UNSUPPORTED

        def rmdir(self, path):
            return paramiko.SFTP_OP_UNSUPPORTED

        def chattr(self, path, attr):
            return paramiko.SFTP_OK

    return _Interface


def serve_rollback_sftp(
    config_text: str, expected_source_ip: str, timeout: float = 120.0,
) -> RollbackFetcher:
    """Start a one-shot SFTP server on the device-facing IP that serves
    `config_text` as a single file ("anthrimon_rb") to one SSH connection
    from `expected_source_ip`, authenticated with a random one-shot
    user/password, then stops.  Returns a RollbackFetcher whose .url is an
    `sftp://user@host:port/anthrimon_rb` URL (no embedded password — see
    module notes above) and whose .sftp_password is the password to answer
    AOS-CX's interactive password prompt."""
    import paramiko

    bind_ip  = _hub_ip_for_device(expected_source_ip)
    port     = _find_free_port(bind_ip)
    user     = uuid.uuid4().hex
    passwd   = uuid.uuid4().hex
    filename = "anthrimon_rb"
    served   = threading.Event()
    data     = config_text.encode("utf-8")
    host_key = _load_or_create_sftp_host_key()

    listen_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listen_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listen_sock.bind((bind_ip, port))
    listen_sock.listen(1)
    listen_sock.settimeout(1.0)

    handle = _SftpServerHandle(listen_sock)
    url = f"sftp://{user}@{bind_ip}:{port}/{filename}"

    class _SSHServer(paramiko.ServerInterface):
        def check_channel_request(self, kind, chanid):
            if kind == "session":
                return paramiko.OPEN_SUCCEEDED
            return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

        def check_auth_password(self, username, password):
            if username == user and password == passwd:
                return paramiko.AUTH_SUCCESSFUL
            return paramiko.AUTH_FAILED

        def get_allowed_auths(self, username):
            return "password"

    sftp_interface = _make_rollback_sftp_server_interface(data, filename, served)

    def _serve_until_done():
        deadline = time.time() + timeout
        client_sock = None
        addr = None
        while time.time() < deadline and not handle.stopped:
            try:
                client_sock, addr = listen_sock.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            if addr[0] != expected_source_ip:
                logger.warning("rollback_sftp_connect_ip_mismatch",
                               expected=expected_source_ip, got=addr[0])
                try:
                    client_sock.close()
                except Exception:
                    pass
                client_sock = None
                continue
            break

        try:
            listen_sock.close()
        except Exception:
            pass
        if client_sock is None:
            return

        transport = paramiko.Transport(client_sock)
        try:
            transport.add_server_key(host_key)
            transport.set_subsystem_handler("sftp", paramiko.SFTPServer, sftp_si=sftp_interface)
            transport.start_server(server=_SSHServer())
            chan = transport.accept(30)
            if chan is None:
                return
            sub_deadline = time.time() + timeout
            while transport.is_active() and not served.is_set() and time.time() < sub_deadline:
                time.sleep(0.2)
            if served.is_set():
                logger.info("rollback_fetch_served", source_ip=addr[0], bytes=len(data))
            time.sleep(0.5)  # let AOS-CX finish reading before we tear down
        finally:
            try:
                transport.close()
            except Exception:
                pass
            try:
                client_sock.close()
            except Exception:
                pass

    t = threading.Thread(target=_serve_until_done, daemon=True)
    t.start()
    logger.info("rollback_sftp_server_started", bind=bind_ip, port=port,
                expected_ip=expected_source_ip, timeout_s=timeout)

    return RollbackFetcher(url=url, served_event=served,
                           server=handle, thread=t, token=user,
                           sftp_password=passwd)


# Vendors whose `copy` command doesn't accept http:// sources for config
# files — see serve_rollback_tftp() above.
_TFTP_VENDORS: set[str] = set()

# Vendors whose `copy` command needs SFTP -- see serve_rollback_sftp() above.
_SFTP_VENDORS = {"aruba_cx"}


def serve_rollback_for_vendor(
    vendor_key: str, config_text: str, expected_source_ip: str, timeout: float = 120.0,
) -> RollbackFetcher:
    """Pick the one-shot transport (HTTP, TFTP, or SFTP) the vendor's `copy`
    command can actually fetch from."""
    if vendor_key in _SFTP_VENDORS:
        return serve_rollback_sftp(config_text, expected_source_ip, timeout=timeout)
    if vendor_key in _TFTP_VENDORS:
        return serve_rollback_tftp(config_text, expected_source_ip, timeout=timeout)
    return serve_rollback(config_text, expected_source_ip, timeout=timeout)


# ── Vendor recipes ────────────────────────────────────────────────────────────

@dataclass
class RecipeStep:
    """One step in a rollback recipe.

    - `command`: the line to send.
    - `expect`: if set, regex the device output is expected to land on before
      the next step.  Used for confirmation prompts.
    - `response`: what to send when `expect` matches.
    - `delay`: extra wait (seconds) after sending, for slow commands like
      `configure replace`.
    - `expect2`/`response2`/`delay2`: an optional SECOND prompt/response pair,
      checked against the latest output after the `expect`/`response` pair (if
      any) has been handled.  Needed for AOS-CX's `copy ... running-config ...
      overwrite`, which may show a one-time host-key "yes/no" prompt followed
      by a password prompt -- or, if the host key is already trusted, go
      straight to the password prompt.  Checking `expect2` against "whatever
      we've read so far" handles both orderings with one recipe.
    - `min_wait`: collector-side only (Go `runConfigSession`/`readFor`); a
      floor (seconds) before idle-detection can end this step's first read
      and its post-`response` read, for commands that echo immediately but
      then go silent for over a second before their real output starts.
      Ignored by `run_recipe` (Netmiko's `send_command_timing` doesn't need
      it). 0 means "use the collector's default".
    """
    command:   str
    expect:    Optional[str] = None
    response:  Optional[str] = None
    delay:     float = 1.0
    expect2:   Optional[str] = None
    response2: Optional[str] = None
    delay2:    float = 1.0
    min_wait:  float = 0.0


@dataclass
class Recipe:
    """A complete vendor rollback recipe.

    `steps` runs inside the device's current mode (we don't pre-enter
    configure terminal — the recipe decides whether it needs to).
    """
    steps:     list[RecipeStep] = field(default_factory=list)
    # Whether the device exposes the result of the apply on the next prompt
    # (operator wants to see this for the audit trail).
    show_running_after: bool = False


# ── VRF handling for the HTTP transfer ────────────────────────────────────────
#
# The device pulls the rollback config over HTTP from the hub.  Which routing
# table (global vs a VRF) it uses for that fetch is decided by the device, not
# the hub.  We resolve the VRF that the device's *monitored* IP actually lives
# in (from the polled interface table — see _resolve_mgmt_vrf in the router) and
# steer the transfer onto that table so the fetch is reliable instead of
# silently egressing the wrong interface.
#
#   - Aruba CX / NX-OS / Arista:  `copy` takes an inline `vrf <name>` token.
#   - Cisco IOS/IOS-XE:           `copy http` has no inline VRF — we point the
#                                 HTTP client at the monitored interface so it
#                                 inherits that interface's VRF.
#   - IOS-XR / Juniper:           best-effort; their mgmt fetch uses the mgmt
#                                 plane / default instance.  We surface the
#                                 detected VRF in logs for the audit trail.

def _is_global_vrf(vrf: Optional[str]) -> bool:
    """True when the monitored IP is in the global table (no VRF token needed).
    Treats the common 'global table' aliases as global."""
    return vrf is None or vrf.strip().lower() in {"", "default", "global"}


def _aruba_cx_recipe(url: str, save: bool, vrf: Optional[str], source_if: Optional[str],
                      sftp_password: Optional[str] = None) -> Recipe:
    # `copy <url> running-config vrf <vrf> overwrite` is a TRUE full replace --
    # proven live: config items absent from the source ARE removed, and a
    # round-trip (remove a vlan, apply, restore, apply) reproduced the original
    # running-config byte-for-byte. It also accepts plain CLI text -- exactly
    # config_backups.config_text -- so unlike the checkpoint primitive (which
    # demands AOS-CX's internal JSON checkpoint format) no capture/schema
    # changes are needed.
    #
    # Prompt sequence (see serve_rollback_sftp / Phase 0 findings):
    #   1. One-time host-key "yes/no" trust prompt for a NEW [host]:port -- not
    #      shown again once that port's host key is trusted.
    #   2. "<user>@<host>'s password:" -- always shown; the URL deliberately
    #      omits the password (AOS-CX rejects `user:pass@host` for this
    #      destination), so it's always answered here.
    #   3. No further prompts -- `overwrite` itself suppresses the usual
    #      replace-confirmation, ending in "Copying configuration: [Success]"
    #      or "[Failure]".
    # `expect`/`response` handles the host-key prompt if it appears;
    # `expect2`/`response2` is checked against whatever's been read so far,
    # so it matches the password prompt whether or not the host-key prompt
    # appeared first.
    #
    # `copy` ALWAYS requires an explicit VRF token; use the VRF the monitored IP
    # lives in (from the polled interface table), falling back to 'mgmt' — the
    # CX out-of-band mgmt port (where the monitored IP usually lives) isn't in
    # ifTable, so detection commonly returns nothing for CX.
    vrf_name = vrf.strip() if (vrf and vrf.strip()) else "mgmt"
    steps = [
        RecipeStep(
            command=f"copy {url} running-config vrf {vrf_name} overwrite",
            expect=r"yes/no|authenticity|fingerprint",
            # AOS-CX echoes this command almost instantly, then goes SILENT
            # for ~1.7s before the "Copying configuration: [\|/-]" spinner
            # starts -- longer than the collector's default 400ms
            # idle-detection floor. Without min_wait, readFor returns right
            # after the echo (before "yes/no"/"fingerprint" ever appears),
            # the expect regex never matches, "yes" is never sent, and a
            # LATER step's command gets fed to AOS-CX as a bogus answer to
            # the still-pending host-key prompt. min_wait=4.0 gives readFor
            # enough runway to ride out the pre-spinner gap and the spinner
            # itself, so it actually observes the prompt (or [Success]/
            # [Failure] if no host-key prompt is shown). delay=12.0 remains
            # the outer cap, now meaningful since the floor lets us survive
            # to see what's really there.
            response="yes", delay=12.0, min_wait=4.0,
            expect2=r"[Pp]assword:",
            response2=sftp_password or "", delay2=20.0,
        ),
    ]
    if save:
        steps.append(RecipeStep(command="write memory", delay=2.0))
    return Recipe(steps=steps, show_running_after=True)


def _arista_recipe(url: str, save: bool, vrf: Optional[str], source_if: Optional[str],
                    sftp_password: Optional[str] = None) -> Recipe:
    # EOS implements the same `configure replace` UX as Cisco IOS — uses
    # smart-diff and applies only the deltas atomically.  `force` skips the
    # confirmation prompt.  Runs from privileged exec.  EOS `copy` accepts an
    # inline `vrf <name>` token when the monitored IP is in a VRF.
    copy_cmd = f"copy {url} flash:anthrimon-rb.cfg"
    if not _is_global_vrf(vrf):
        copy_cmd += f" vrf {vrf.strip()}"
    return Recipe(steps=[
        RecipeStep(command=copy_cmd, delay=3.0),
        RecipeStep(command="configure replace flash:anthrimon-rb.cfg force", delay=8.0),
        RecipeStep(command="delete flash:anthrimon-rb.cfg",
                   expect=r"(y/n)|confirm|Proceed", response="y", delay=1.0),
        *([RecipeStep(command="write memory", delay=2.0)] if save else []),
    ])


def _cisco_ios_recipe(url: str, save: bool, vrf: Optional[str], source_if: Optional[str],
                       sftp_password: Optional[str] = None) -> Recipe:
    # IOS' configure replace runs from privileged exec.  `force` is supposed
    # to skip the confirmation, but some platforms (older 15.x) still ask —
    # we expect the prompt and answer y just in case.
    #
    # IOS `copy http` has no inline VRF keyword.  When the monitored IP is in a
    # VRF, point the HTTP client at the monitored interface so the fetch uses
    # that interface's VRF.  (This leaves `ip http client source-interface` set
    # — it reflects the real mgmt path and is harmless, but will show in the
    # next config diff.)
    pre: list[RecipeStep] = []
    if not _is_global_vrf(vrf) and source_if:
        pre = [
            RecipeStep(command="configure terminal", delay=1.0),
            RecipeStep(command=f"ip http client source-interface {source_if}", delay=1.0),
            RecipeStep(command="end", delay=1.0),
        ]
    return Recipe(steps=[
        *pre,
        RecipeStep(
            command=f"copy {url} flash:anthrimon-rb.cfg",
            expect=r"Destination filename|filename", response="", delay=3.0,
        ),
        RecipeStep(
            command="configure replace flash:anthrimon-rb.cfg force",
            expect=r"(want to proceed|Enter Y|sure you want)", response="y",
            delay=10.0,
        ),
        RecipeStep(command="delete /force flash:anthrimon-rb.cfg", delay=1.0),
        *([RecipeStep(command="write memory", delay=2.0)] if save else []),
    ])


def _cisco_nxos_recipe(url: str, save: bool, vrf: Optional[str], source_if: Optional[str],
                        sftp_password: Optional[str] = None) -> Recipe:
    # NX-OS doesn't have a `force` keyword for `configure replace`; it always
    # prompts.  The prompt text is "Do you want to proceed?".  NX-OS `copy`
    # accepts an inline `vrf <name>` token (mgmt typically uses 'management').
    copy_cmd = f"copy {url} bootflash:anthrimon-rb.cfg"
    if not _is_global_vrf(vrf):
        copy_cmd += f" vrf {vrf.strip()}"
    return Recipe(steps=[
        RecipeStep(command=copy_cmd, delay=3.0),
        RecipeStep(command="configure replace bootflash:anthrimon-rb.cfg",
                   expect=r"(y/n|want to proceed|continue)",
                   response="y", delay=12.0),
        RecipeStep(command="delete bootflash:anthrimon-rb.cfg no-prompt", delay=1.0),
        *([RecipeStep(command="copy running-config startup-config", delay=2.0)] if save else []),
    ])


def _cisco_iosxr_recipe(url: str, save: bool, vrf: Optional[str], source_if: Optional[str],
                         sftp_password: Optional[str] = None) -> Recipe:
    # IOS-XR uses a candidate-then-commit model.  `load` stages the URL into
    # candidate; `commit replace` swaps running atomically.
    # `commit replace` prompts: "This commit will replace or remove the entire
    # running configuration.  This operation can take a long time...
    # Do you wish to proceed? [no]:" — respond `yes`.
    # IOS-XR fetches over the management plane; `load` takes no inline VRF.
    # The detected VRF is logged for the audit trail by the caller.
    return Recipe(steps=[
        RecipeStep(command="configure terminal", delay=1.0),
        RecipeStep(command=f"load {url}", delay=5.0),
        RecipeStep(command="commit replace",
                   expect=r"(y/n|yes/no|Proceed|wish to proceed)",
                   response="yes", delay=15.0),
        RecipeStep(command="exit", delay=1.0),
    ])


def _juniper_recipe(url: str, save: bool, vrf: Optional[str], source_if: Optional[str],
                     sftp_password: Optional[str] = None) -> Recipe:
    # Junos has one unified config — no separate startup save needed.
    # `commit` writes to both candidate AND active simultaneously.
    # Must enter config mode (`configure`) before `load`.
    # Junos fetches over its default routing instance; `load override` takes no
    # inline routing-instance.  The detected VRF is logged for the audit trail.
    return Recipe(steps=[
        RecipeStep(command="configure exclusive", delay=2.0),  # exclusive lock prevents concurrent edits
        RecipeStep(command=f"load override {url}", delay=5.0),
        RecipeStep(command="commit and-quit", delay=15.0),
    ])


def _procurve_recipe(url: str, save: bool, vrf: Optional[str], source_if: Optional[str],
                      sftp_password: Optional[str] = None) -> Recipe:
    # ProCurve's HTTP support is limited to firmware download, not config.
    # Force the operator to use TFTP for ProCurve — set up via platform
    # settings, since the URL shape is different.
    raise NotImplementedError(
        "ProCurve rollback requires TFTP server setup; HTTP copy isn't supported "
        "by ProCurve firmware. This vendor needs a separate implementation."
    )


# ── Dispatcher ────────────────────────────────────────────────────────────────

_VENDOR_RECIPES = {
    "aruba_cx":     _aruba_cx_recipe,
    "arista":       _arista_recipe,
    "cisco_ios":    _cisco_ios_recipe,
    "cisco_iosxe":  _cisco_ios_recipe,
    "cisco_iosxr":  _cisco_iosxr_recipe,
    "cisco_nxos":   _cisco_nxos_recipe,
    "juniper":      _juniper_recipe,
    # procurve omitted on purpose — see _procurve_recipe
}


def supported_vendors() -> set[str]:
    return set(_VENDOR_RECIPES.keys())


def build_recipe(
    vendor_key: str, url: str, save: bool,
    vrf: Optional[str] = None, source_if: Optional[str] = None,
    sftp_password: Optional[str] = None,
) -> Recipe:
    """Build the vendor rollback recipe.

    `vrf` / `source_if` describe the routing context of the device's monitored
    IP (resolved from the polled interface table).  They steer the device's
    HTTP fetch onto the correct table so the transfer is reliable — see the
    per-vendor recipes and _is_global_vrf above.

    `sftp_password` is only used by `_aruba_cx_recipe` (the SFTP one-shot
    password to answer AOS-CX's interactive password prompt); all other
    vendors ignore it.
    """
    builder = _VENDOR_RECIPES.get(vendor_key)
    if builder is None:
        raise ValueError(
            f"Rollback is not implemented for vendor '{vendor_key}'. "
            f"Supported: {sorted(supported_vendors())}.  "
            f"ProCurve and FortiOS would need different protocols (TFTP for ProCurve, "
            f"vendor API for FortiOS) and aren't yet supported."
        )
    return builder(url, save, vrf, source_if, sftp_password)


# ── Recipe execution (Netmiko) ────────────────────────────────────────────────

def run_recipe(
    host: str, port: int, vendor_key: str, cred_data: dict, recipe: Recipe,
) -> str:
    """Run the recipe over SSH using Netmiko.  Handles per-step expect prompts
    so device-side confirmations don't deadlock the session."""
    from .hostkeys import pinned_connect_handler

    # Reuse the existing deploy's vendor → netmiko driver map.
    from .collector import _NETMIKO_TYPE
    device_type = _NETMIKO_TYPE.get(vendor_key, "cisco_ios")
    is_procurve = vendor_key in {"hp_procurve", "procurve"}

    conn_params = {
        "device_type":         device_type,
        "host":                host,
        "port":                port,
        "username":            cred_data.get("username", ""),
        "password":            cred_data.get("password", ""),
        "timeout":             60 if is_procurve else 60,
        "conn_timeout":        30,
        "auth_timeout":        30,
        "banner_timeout":      30,
        "fast_cli":            False,
        "global_delay_factor": 2,
    }
    if cred_data.get("enable_secret"):
        conn_params["secret"] = cred_data["enable_secret"]
    elif vendor_key in {"arista", "cisco_ios", "cisco_iosxe", "cisco_iosxr",
                        "cisco_nxos", "aruba_cx"}:
        conn_params["secret"] = cred_data.get("password", "")

    output_parts: list[str] = []
    with pinned_connect_handler(**conn_params) as conn:
        # Enable / privileged exec — recipes don't enter config mode explicitly;
        # most vendors' replace commands are run from exec.
        try:
            conn.enable()
        except Exception:
            pass

        import re as _re
        for step in recipe.steps:
            line_prefix = f"$ {step.command}"
            try:
                out = conn.send_command_timing(
                    step.command,
                    strip_prompt=False, strip_command=False,
                    last_read=step.delay,
                )
                # If the expected prompt appeared, send the response.
                if step.expect and _re.search(step.expect, out or "", _re.IGNORECASE):
                    out2 = conn.send_command_timing(
                        step.response or "",
                        strip_prompt=False, strip_command=False,
                        last_read=step.delay,
                    )
                    out = (out or "") + (out2 or "")
                # Second prompt/response pair, checked against whatever's been
                # read so far -- handles AOS-CX's optional host-key prompt
                # followed by a password prompt (see _aruba_cx_recipe).
                if step.expect2 and _re.search(step.expect2, out or "", _re.IGNORECASE):
                    out3 = conn.send_command_timing(
                        step.response2 or "",
                        strip_prompt=False, strip_command=False,
                        last_read=step.delay2,
                    )
                    out = (out or "") + (out3 or "")
            except Exception as exc:
                output_parts.append(f"{line_prefix}\n!! step failed: {exc}")
                raise
            if step.response2:
                out = (out or "").replace(step.response2, "********")
            output_parts.append(f"{line_prefix}\n{out or ''}")
            if step.delay > 0:
                time.sleep(min(step.delay, 0.5))  # tiny safety pause; main wait is in send_command_timing

        if recipe.show_running_after:
            try:
                out = conn.send_command("show running-config",
                                        read_timeout=30, strip_prompt=False)
                output_parts.append(f"$ show running-config\n{out[:4000]}")
            except Exception:
                pass

    return "\n".join(output_parts).strip()
