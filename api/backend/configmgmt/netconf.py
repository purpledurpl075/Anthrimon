"""Junos config push via NETCONF — the vendor-API deploy path for Junos,
parallel to how Arista eAPI / Aruba CX REST are used for those vendors
(this codebase's eAPI/REST paths are monitoring-only; this is the first
vendor-API-based *config push* path — see api_orchestrator.configure_method
for how the netconf service itself gets enabled on the device).

Scope, deliberately: DEPLOY (incremental "set" commands) only. Rollback
(restoring a full previous backup) stays on the existing SSH-CLI path
(collector.py/rollback.py, already built and verified this session) —
confirmed live against a real device that Junos NETCONF's
`action="override"` (the RPC equivalent of the CLI's `load override`, which
rollback.py already uses) REQUIRES curly-brace hierarchical config text via
`<configuration-text>`, and explicitly rejects the set-style text
config_backups stores ("internal communications error (tag
'configuration-set') expecting configuration-text"). Converting stored
backups to hierarchical format to route rollback through NETCONF too wasn't
worth the risk for this pass.

Commit workflow mirrors the SSH-CLI path exactly: `commit confirmed` (Junos
auto-reverts if nothing confirms it), a lightweight get-rpc as a
liveness/sanity check, then a plain `commit` to finalize — see
routers/config_mgmt.py's _deploy_steps docstring for the same reasoning
applied to the CLI-scraping version of this dance.
"""
from __future__ import annotations

import asyncio
import re
from xml.sax.saxutils import escape as _xml_escape

CONFIRM_TIMEOUT_MIN = 5

# The complete set of verbs valid at the start of a Junos "set"-format
# configuration statement (what `load-configuration action="set"` accepts —
# see build_deploy_rpcs). Anything else — operational commands like "show"/
# "request"/"ping", or interactive-CLI-only navigation like "edit"/"top"/
# "exit"/"run" — is not valid here: load-configuration would reject it with
# a real (severity=error) rpc-error, but that error can be buried deep in a
# 6-step NETCONF transcript. Classifying commands upfront catches this
# before any network I/O, with a clear per-line message.
_CONFIG_VERBS = frozenset({
    "set", "delete", "deactivate", "activate", "annotate",
    "insert", "rename", "copy", "protect", "unprotect", "wildcard",
})


def classify_command(line: str) -> str:
    """Classify one command line as "config" (a valid set-format Junos
    configuration statement), "operational" (a show/request/CLI-navigation
    command that doesn't belong in a set-format deploy), or "blank"."""
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return "blank"
    first_word = stripped.split(None, 1)[0].lower()
    return "config" if first_word in _CONFIG_VERBS else "operational"


def validate_config_commands(commands: list[str]) -> list[str]:
    """Return a list of human-readable problems for any non-config lines
    (empty list = all lines are valid set-format statements). Blank lines
    and '#' comments are skipped, not flagged."""
    problems = []
    for i, line in enumerate(commands, start=1):
        kind = classify_command(line)
        if kind == "operational":
            stripped = line.strip()
            first_word = stripped.split(None, 1)[0]
            problems.append(
                f'Line {i}: "{stripped}" looks like an operational command '
                f'(starts with "{first_word}"), not a Junos configuration '
                f"statement. Deploy only accepts set-format lines — "
                f'{", ".join(sorted(_CONFIG_VERBS))}.'
            )
    return problems


def _rpc_has_fatal_error(reply_xml: str) -> bool:
    """True if the reply contains an rpc-error at "error" severity. Junos
    routinely returns warning-severity rpc-error alongside a real success
    (e.g. unlicensed protocol blocks) — those must NOT be treated as failure."""
    return bool(re.search(r"<error-severity>\s*error\s*</error-severity>", reply_xml, re.IGNORECASE))


def _rpc_ok(reply_xml: str) -> bool:
    """Best-effort success check for one <rpc-reply>: no fatal-severity
    rpc-error, and some recognized success marker present. Verified live
    against real load-configuration/commit-configuration replies this
    session — see the module docstring's sibling investigation in
    routers/config_mgmt.py."""
    if _rpc_has_fatal_error(reply_xml):
        return False
    lower = reply_xml.lower()
    return (
        "<ok" in lower
        or "commit complete" in lower
        or "commit-check-success" in lower
        or "commit-success" in lower
    )


def build_deploy_rpcs(commands: list[str], confirm_timeout_min: int = CONFIRM_TIMEOUT_MIN) -> list[dict]:
    """Build the RPC sequence for an incremental Junos config deploy:
    lock -> load-configuration(action=set) -> commit-confirmed -> sanity
    check -> commit -> unlock. Returns the wire-format list expected by the
    collector's /netconf executor ({"body": ..., "timeout_s": ...})."""
    config_set = "\n".join(c.strip() for c in commands if c.strip())
    return [
        {"body": "<lock><target><candidate/></target></lock>", "timeout_s": 10},
        {
            "body": (
                '<load-configuration action="set" format="text">'
                f"<configuration-set>{_xml_escape(config_set)}</configuration-set>"
                "</load-configuration>"
            ),
            "timeout_s": 20,
        },
        {
            "body": (
                "<commit-configuration><confirmed/>"
                f"<confirm-timeout>{confirm_timeout_min}</confirm-timeout>"
                "</commit-configuration>"
            ),
            "timeout_s": 30,
        },
        {"body": "<get-software-information/>", "timeout_s": 10},
        {"body": "<commit-configuration/>", "timeout_s": 30},
        {"body": "<unlock><target><candidate/></target></unlock>", "timeout_s": 10},
    ]


def _format_output(rpcs: list[dict], replies: list[str]) -> str:
    parts = []
    for i, reply in enumerate(replies):
        label = rpcs[i]["body"][:60] if i < len(rpcs) else "?"
        parts.append(f"$ {label}\n{reply}")
    return "\n\n".join(parts)


def _interpret_deploy(rpcs: list[dict], replies: list[str], transport_error: str | None) -> tuple[str, bool]:
    """Turn a raw NETCONF exec result into (output_text, success)."""
    output = _format_output(rpcs, replies)
    if transport_error:
        return output + f"\n\n!! transport error: {transport_error}", False

    # replies: [lock, load-configuration, commit-confirmed, sanity, commit, unlock]
    if len(replies) < 6:
        return output + "\n\n!! sequence did not complete (fewer replies than expected)", False

    load_ok = _rpc_ok(replies[1])
    confirm_ok = _rpc_ok(replies[2])
    final_commit_ok = _rpc_ok(replies[4])

    if not load_ok:
        return output, False
    if not confirm_ok:
        return output, False
    if not final_commit_ok:
        return output + "\n\n!! confirming commit did not succeed — device will auto-rollback in "\
                         f"{CONFIRM_TIMEOUT_MIN} minutes", False
    return output, True


async def deploy_via_collector(*, wg_ip: str, api_key_hash: str, device_ip: str,
                               username: str, password: str, commands: list[str]) -> tuple[str, bool]:
    """Deploy config to a collector-managed Junos device over NETCONF.
    Returns (output_text, success)."""
    from . import proxy as _proxy

    rpcs = build_deploy_rpcs(commands)
    try:
        data = await _proxy.netconf_exec(
            wg_ip=wg_ip, api_key_hash=api_key_hash, device_ip=device_ip,
            username=username, password=password, rpcs=rpcs,
        )
    except Exception as exc:
        return f"!! netconf-exec request failed: {exc}", False
    return _interpret_deploy(rpcs, data.get("replies", []), data.get("error"))


def _netconf_exec_sync(host: str, username: str, password: str, rpcs: list[dict]) -> tuple[list[str], str | None]:
    """Open the SSH "netconf" subsystem directly with paramiko (synchronous
    — run via loop.run_in_executor), exchange hellos, and send each rpc in
    sequence. Returns (replies, transport_error). Shared by the deploy and
    operational-command paths — see deploy_direct_sync's docstring for why
    there's no TOFU host-key pinning here.
    """
    import socket
    import paramiko

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            hostname=host, port=830, username=username, password=password,
            timeout=15, look_for_keys=False, allow_agent=False,
        )
    except Exception as exc:
        return [], f"netconf ssh connect failed: {exc}"

    replies: list[str] = []
    transport_error = None
    try:
        transport = client.get_transport()
        chan = transport.open_session()
        chan.invoke_subsystem("netconf")
        chan.settimeout(20)

        def read_until_eom(timeout: float) -> str:
            buf = b""
            chan.settimeout(timeout)
            deadline_exc = None
            try:
                while b"]]>]]>" not in buf:
                    chunk = chan.recv(8192)
                    if not chunk:
                        break
                    buf += chunk
            except socket.timeout as exc:
                deadline_exc = exc
            text = buf.split(b"]]>]]>")[0].decode("utf-8", errors="replace")
            if deadline_exc and not text:
                raise TimeoutError("netconf read timed out with no data")
            return text

        read_until_eom(10)  # server hello, discarded
        my_hello = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">\n'
            "  <capabilities><capability>urn:ietf:params:netconf:base:1.0</capability></capabilities>\n"
            "</hello>\n]]>]]>"
        )
        chan.send(my_hello)

        for i, rpc in enumerate(rpcs):
            msg_id = i + 1
            req = (
                '<?xml version="1.0" encoding="UTF-8"?>\n'
                f'<rpc message-id="{msg_id}" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">\n'
                f"{rpc['body']}\n</rpc>\n]]>]]>"
            )
            try:
                chan.send(req)
                reply = read_until_eom(rpc.get("timeout_s") or 20)
                replies.append(reply)
            except Exception as exc:
                transport_error = str(exc)
                break
    finally:
        client.close()

    return replies, transport_error


def deploy_direct_sync(host: str, username: str, password: str, commands: list[str]) -> tuple[str, bool]:
    """Deploy config to a hub-managed Junos device over NETCONF."""
    rpcs = build_deploy_rpcs(commands)
    replies, transport_error = _netconf_exec_sync(host, username, password, rpcs)
    return _interpret_deploy(rpcs, replies, transport_error)


# ── Operational (read-only "show") commands ─────────────────────────────────

def build_operational_rpcs(commands: list[str], timeout_s: int = 30) -> list[dict]:
    """Build one <command> RPC per operational command line. format="text"
    returns human-readable CLI output (what a user would see interactively)
    rather than structured XML."""
    return [
        {"body": f'<command format="text">{_xml_escape(c.strip())}</command>', "timeout_s": timeout_s}
        for c in commands if c.strip()
    ]


def _extract_command_output(reply_xml: str) -> str:
    """Pull the <output>...</output> text out of a format="text" op-command
    rpc-reply. Falls back to the raw reply if the tag isn't present (e.g.
    the device returned an rpc-error instead of output)."""
    m = re.search(r"<output>(.*?)</output>", reply_xml, re.DOTALL)
    if not m:
        return reply_xml.strip()
    import html
    return html.unescape(m.group(1)).strip()


def _interpret_operational(
    commands: list[str], replies: list[str], transport_error: str | None,
) -> tuple[str, bool]:
    """Turn raw op-command NETCONF replies into (output_text, success). No
    lock/commit/confirm dance — each command is independent, so success
    means every command got a non-fatal reply."""
    clean = [c.strip() for c in commands if c.strip()]
    if transport_error:
        partial = "\n\n".join(
            f"$ {cmd}\n{_extract_command_output(r)}" for cmd, r in zip(clean, replies)
        )
        return (partial + "\n\n" if partial else "") + f"!! transport error: {transport_error}", False

    ok = True
    parts = []
    for i, cmd in enumerate(clean):
        if i >= len(replies):
            ok = False
            parts.append(f"$ {cmd}\n!! no reply (sequence stopped early)")
            continue
        reply = replies[i]
        if _rpc_has_fatal_error(reply):
            ok = False
        parts.append(f"$ {cmd}\n{_extract_command_output(reply)}")
    return "\n\n".join(parts), ok


async def run_operational_via_collector(*, wg_ip: str, api_key_hash: str, device_ip: str,
                                        username: str, password: str, commands: list[str]) -> tuple[str, bool]:
    """Run read-only operational commands on a collector-managed Junos
    device over NETCONF. Returns (output_text, success)."""
    from . import proxy as _proxy

    rpcs = build_operational_rpcs(commands)
    if not rpcs:
        return "!! no commands given", False
    try:
        data = await _proxy.netconf_exec(
            wg_ip=wg_ip, api_key_hash=api_key_hash, device_ip=device_ip,
            username=username, password=password, rpcs=rpcs,
        )
    except Exception as exc:
        return f"!! netconf-exec request failed: {exc}", False
    return _interpret_operational(commands, data.get("replies", []), data.get("error"))


def run_operational_direct_sync(host: str, username: str, password: str, commands: list[str]) -> tuple[str, bool]:
    """Run read-only operational commands on a hub-managed Junos device over
    NETCONF (synchronous — run via loop.run_in_executor)."""
    rpcs = build_operational_rpcs(commands)
    if not rpcs:
        return "!! no commands given", False
    replies, transport_error = _netconf_exec_sync(host, username, password, rpcs)
    return _interpret_operational(commands, replies, transport_error)
