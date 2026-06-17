# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The hub API and dashboard share a single platform version. The remote
collector is versioned independently (see `collectors/remote/cmd/remote-collector/main.go`).

## [Unreleased]

### Added

- **Custom Dashboards**: a new top-level "Dashboards" section, separate from
  Overview, where users can create, rename, clone, delete, and (operator+)
  share named dashboards built from a drag-and-resize widget grid. Includes
  the 21 existing Overview widgets plus four new generic "metric" widgets —
  Gauge, Stat, Graph, and Text Note — configurable against any accessible
  device/interface and a small built-in metric registry (CPU/memory/RTT/loss/
  temperature, interface bandwidth/utilization/errors). Dashboards have their
  own time-range and refresh-interval controls, per-widget PNG export, four
  starter templates (NOC Overview, Capacity Planning, Routing Health, Syslog &
  Bandwidth), and a fullscreen Kiosk mode (`/dashboards/kiosk?ids=...&interval=`)
  that auto-cycles through selected dashboards.
- **Dashboards as home**: the separate "Overview" page has been removed —
  `/` now redirects to the user's default dashboard, and the sidebar's
  "Dashboards" item expands into a quick-access dropdown listing the user's
  own and tenant-shared dashboards (with default/shared badges and a
  "+N more" link to the full list).

### Fixed

- An alert that an operator **acknowledged** and whose underlying condition
  *later cleared on its own* (without anyone clicking "resolve") stayed
  `acknowledged` forever. Since the alert-dedup check treats `acknowledged`
  the same as `open`/`suppressed`, this stale alert permanently blocked a
  fresh alert from being created the next time the same condition recurred —
  at best producing a silent re-notify of the original, now-stale alert.
  Acknowledged alerts now auto-resolve once their condition clears and stays
  clear for the rule's `stable_for_seconds` (the same stability gate `open`
  alerts already use), freeing the fingerprint so a future recurrence creates
  a fresh, visible alert.
- **BGP session collection for Arista devices (eAPI)**: `bgp_sessions` was
  17 days stale for vEOS5-8 — the remote collector never collected BGP
  session state for these devices, so `bgp_session_down` alerts could never
  fire. The collector now issues `show ip bgp summary vrf all` over eAPI
  alongside the existing IS-IS/STP/route collection and posts the results to
  `/api/v1/collectors/bgp-sessions`. Remote collector bumped to `0.3.30`.
- A device that lost **all** of its IS-IS neighbors (e.g. both uplinks down)
  never had its own `isis_neighbors` rows updated — `parseISISNeighbors`
  returned an empty list, so the collector skipped the post entirely and the
  device's adjacencies stayed stuck at their last "up" state (the reciprocal
  side's rows updated correctly, since it still had other neighbors). IS-IS
  adjacency posts are now per-device (`{"device_id", "neighbors"}`) and
  always sent, even when empty, so the hub can mark a fully-isolated device's
  adjacencies down.
- The remote collector's eAPI poll interval for Arista IS-IS/BGP/STP/routes
  was a fixed 5 minutes, so after a topology change it could take up to 5
  minutes before the collector even saw the new state (the alert engine
  itself evaluates every 15s with no added delay). Lowered to 60 seconds,
  matching the SNMP poller's cadence — worst-case alert latency for
  IS-IS/BGP changes on these devices drops from ~5 minutes to ~60-75s.
  Remote collector bumped to `0.3.31`.
- The same "device now has zero X" gap fixed for IS-IS above also affected
  **BGP sessions**, **OSPF neighbors**, and **route tables** across all three
  collection paths (Arista eAPI, ArubaOS-CX REST, and the standalone SNMP
  collector). A device that lost all of its BGP peers, all of its OSPF
  neighbors, or its entire route table kept showing the last-known "up"
  state/routes forever, so `bgp_session_down`, OSPF neighbor-down, and
  route-missing alerts could never (re-)fire for it. BGP/OSPF/route posts
  are now per-device (`{"device_id", ...}`) and always sent, even when empty:
  - Stale BGP sessions are marked `idle` (`bgp_session_state` has no `down`
    value, and `eval_bgp_session_down` only treats `established`/`unknown`
    as healthy).
  - Stale OSPF neighbors are marked `down`.
  - Routes already had upsert-then-purge mark-and-sweep; it just needed the
    early-return-on-empty removed.

  The standalone SNMP collector (`collectors/snmp`) had the same four gaps
  (IS-IS, OSPF, BGP, routes): a successful-but-empty poll returned a bare
  `nil`, indistinguishable from "poll failed", so the writer's `len(x) > 0`
  gates skipped the already-correct mark-down/sweep logic entirely. The
  poller now coalesces a successful empty poll to `[]` and the writer gates
  on `!= nil`; `upsertOSPFNeighbours` and `upsertBGPSessions` gained the same
  mark-down/mark-stale logic as their hub-side counterparts. Remote collector
  bumped to `0.3.32`, SNMP collector bumped to `0.1.6`.
- The mark-stale/mark-down logic added above for BGP sessions and OSPF
  neighbors had a knock-on bug: it unconditionally bumped
  `last_state_change` to `NOW()` for every currently-up row (correct for
  rows that are about to be marked stale and stay that way), but the
  immediately-following upsert's `last_state_change` CASE — for rows still
  present and unchanged — fell back to that *same, just-clobbered* column
  instead of the true prior value. The net effect was that `last_state_change`
  (and therefore the BGP "Up" duration / `uptime_seconds`-derived display)
  reset to "now" on *every* poll for every steady-state session/neighbor,
  across both the hub's REST-state writer (`_write_bgp`/`_write_ospf`) and
  the standalone SNMP collector (`upsertBGPSessions`/`upsertOSPFNeighbours`).
  Both now additionally snapshot `last_state_change` before marking
  stale/down and restore that snapshotted value when the CASE determines no
  real transition occurred. SNMP collector bumped to `0.1.7`.
- Three remaining 5-minute polling intervals were lowered to 60 seconds,
  matching the cadence already used by SNMP and Arista eAPI polling: the
  hub's eAPI IS-IS collector, the hub's REST routing-state collector
  (ArubaOS-CX BGP/OSPF/routes), and the remote collector's ArubaOS-CX REST
  collection cadence.
- An alert could be **escalated** to a higher severity on the same cycle its
  condition cleared, immediately followed by an auto-resolve (e.g.
  "ESCALATED → CRITICAL" then "RESOLVED" moments later). The escalation check
  now skips any alert whose fingerprint is no longer in the
  actively-breaching set for the cycle.
- New `operator`/`readonly` users could see almost nothing — just devices
  with no assigned site (2 of 19 in the lab) — and none of their bandwidth
  data. Per-site device scoping (`accessible_device_ids_subquery` and
  friends in `dependencies.py`) was already enforced for any non-admin user,
  but there is no UI yet to grant a user access to specific sites
  (`PUT /users/{id}/site-roles` has no frontend). Site-scoping is now
  opt-in: a user with zero per-site role grants sees the whole tenant (as
  every user effectively did before), and only becomes site-restricted once
  an admin explicitly grants them access to specific sites.
- The "NOC Overview", "Capacity Planning", and "Syslog & Bandwidth" starter
  dashboard templates had a final row of widgets that didn't sum to 12 grid
  columns (e.g. NOC Overview's last row only filled 8 of 12), leaving a large
  empty gap on the right side of the dashboard grid. Widget widths in that row
  now sum to 12 for all affected templates.

- The Addresses page now resolves the switch port for end-devices on
  non-default VLANs (e.g. `10.0.2.8`). The SNMP collector previously only
  walked `dot1dTpFdbTable` (BRIDGE-MIB), which on VLAN-aware switches only
  reflects the default VLAN's forwarding table; per-VLAN entries are now
  also read from `dot1qTpFdbTable` (Q-BRIDGE-MIB) and merged in.
- AOS-CX (Aruba CX) configuration rollback no longer fails with
  `Checkpoint <name> doesn't exist` / `checkpointNotFound`, for both
  hub-managed and collector-managed devices. AOS-CX's
  `copy <url> checkpoint <name>` only accepts `tftp://`/`sftp://` sources and
  silently rejects `http://` before it reaches the config subsystem, so the
  checkpoint was never created — and AOS-CX checkpoints are a JSON blob, not
  the plain CLI text our backups store. Rollback now uses
  `copy sftp://<user>@<host>:<port>/<file> running-config vrf <vrf> overwrite`,
  a true full-replace that accepts plain CLI text directly (no
  checkpoint/JSON conversion). Both the hub and the remote collector host a
  one-shot SFTP server (with a persisted RSA host key, so repeat rollbacks to
  the same device don't re-trigger the SSH host-key prompt) to serve the
  backup to the device; the SFTP password is supplied at the interactive
  prompt rather than embedded in the URL, since AOS-CX rejects
  `sftp://user:pass@host` URLs. Remote collector bumped to `0.3.22`.
- Collector-managed AOS-CX rollback (e.g. `ArubaCX9`) no longer hangs at
  AOS-CX's SSH host-key trust prompt (`Please type 'yes', 'no' or the
  fingerprint:`). AOS-CX's `copy ... running-config vrf <vrf> overwrite`
  echoes the command immediately but then goes silent for ~1.7s before its
  "Copying configuration: [\|/-]" spinner (and any host-key prompt) appears
  — longer than the collector's 400ms idle-detection floor, so the recipe
  step's read returned before the prompt existed, the `yes` response was
  never sent, and a later step's command ended up being fed to AOS-CX as an
  invalid answer to the still-pending prompt. Recipe steps can now set a
  `min_wait` floor that delays idle-detection past this gap; the AOS-CX
  rollback recipe's copy step sets `min_wait=4.0`. Remote collector bumped
  to `0.3.23`.
- Remote collectors' own periodic `show running-config` capture
  (`SSHConfigCollector`, separate from the hub-delegated collection above) no
  longer leaves a stray `Current configuration:` / `Building configuration...`
  header line in stored backups. AOS-CX's `copy ... overwrite` rejects that
  line as invalid config ("Some of the configuration lines from the file were
  NOT applied"), so roughly half of the periodically-collected backups for
  collector-managed AOS-CX devices (alternating with the hub-delegated
  collection, which already stripped this header) were unusable as rollback
  targets. `cleanOutput` now strips these header lines, matching the hub's
  `_BANNER_NOISE` filter. Remote collector bumped to `0.3.24`.
- CDP neighbor data is now correctly parsed and shown in the topology view
  and per-device Neighbors tab. The SNMP collector's `cdpCacheTable` walk
  read every column one position too low (an off-by-one against
  CISCO-CDP-MIB), so `remote_device_id` was populated with the neighbor's
  software-version banner instead of its `cdpCacheDeviceId` (hostname). This
  meant CDP neighbors could never be matched to a known device, so CDP-only
  links (e.g. between the lab's Cisco IOS-XR routers) were silently dropped
  from the topology graph.
- SNMP trap details (Syslog page and per-device Traps tab) now resolve
  well-known OIDs to readable names instead of showing raw dotted numbers.
  Trap OIDs and varbind OIDs are matched against a small built-in dictionary
  covering IF-MIB/BRIDGE-MIB/Q-BRIDGE-MIB table columns and the
  ARISTA-BRIDGE-EXT-MIB notifications, so e.g. trap OID
  `1.3.6.1.4.1.30065.3.2.0.2` now shows as `aristaMacLearn` and varbind OID
  `1.3.6.1.2.1.17.7.1.2.2.1.2.20.80.0.0.1.0.3` as `dot1qTpFdbPort.20.80.0.0.1.0.3`.
  The trap handler's enterprise-trap table also gained specific entries for
  `aristaMacMove`/`aristaMacLearn`/`aristaMacAge` (previously all lumped
  under the generic `arista.trap` category).

## [0.9.0] - 2026-06-11

### Security

- Closed a cross-tenant configuration vector where any tenant admin could
  edit a single global settings blob that controlled alerting and
  notification behavior for *every* tenant (notification pause, business-hours
  suppression, device-down thresholds, storm protection, alert retention,
  platform branding, and the WireGuard collector endpoint).

### Changed

- Split platform configuration into two tiers:
  - **Platform-wide settings** (`/platform/settings`, platform admin only):
    base URL, platform name, timezone, AbuseIPDB API key, WireGuard public
    endpoint, plus org-wide defaults for alerting/notification behavior.
  - **Per-tenant alerting overrides** (`/admin/settings/alerting`, tenant
    admin): device-down threshold, storm protection, auto-close, alert
    retention, notification pause, and business-hours scheduling, each
    falling back to the platform-wide default when not overridden.
- Removed three unused legacy settings (`alert_eval_interval_s`,
  `default_renotify_s`, duplicate `session_timeout_hours`).

### Added

- `CHANGELOG.md` and platform version tracking (hub API + dashboard now
  report `0.9.0`; the remote collector continues to version independently).

Changes prior to this point are not itemized in this changelog; see
`git log` for history.
