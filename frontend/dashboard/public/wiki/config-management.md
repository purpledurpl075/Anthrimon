# Config Management Setup

Config management collects device configurations, tracks changes over time, diffs backups, and checks compliance against policies.

## Requirements

- An **SSH credential** linked to the device (for CLI-based collection)
- The collection account needs read-only access to `show running-config` (or equivalent)
- For Aruba CX devices, the REST API is used instead of SSH

## Adding an SSH credential

1. Go to **Credentials** → **Add Credential**
2. Select type **SSH**
3. Fill in username and password (or paste a private key)
4. Set a name and save

Then link it to the device in the Device Settings drawer (gear icon) → **Credentials** section, with a priority lower than SNMP (e.g. priority 5).

## Collection

Config collection runs automatically every hour. To trigger manually, go to the device detail page → **Config** tab → **Collect Now**.

The collected config is stored as a versioned backup. Each backup shows:
- Timestamp
- Size
- A diff against the previous backup (highlighted additions and removals)

## Compliance policies

Compliance policies check the collected config against rules. Go to **Policies** (under Analysis in the sidebar) to create them.

### Rule types

| Type | Description |
|------|-------------|
| `regex_present` | Config must match this regex pattern |
| `regex_absent` | Config must NOT match this regex pattern |
| `contains` | Config must include this literal string |
| `not_contains` | Config must not include this literal string |

### Example policies

- Ensure `service password-encryption` is present on all Cisco devices
- Ensure no `no shutdown` on management interfaces
- Ensure NTP server is configured (`ntp server`)

## ProCurve / Aruba switches

ProCurve switches do not support standard SSH exec channels. The collector uses **paramiko `invoke_shell`** to emulate an interactive terminal session. This is handled automatically — no special configuration is needed. However:

- Collection may take slightly longer (5–10 seconds) due to interactive prompting
- Ensure the SSH credential has `operator` or `manager` level access
- If collection fails with a timeout, increase the SSH timeout in the credential settings

## Viewing config history

On the device detail page → **Config** tab:

- Click any backup to view the full config
- Click **Diff** between two backups to see what changed
- Compliance results appear below each backup

## Change alerts

If a config changes between polls, a `config_change` event is recorded. Create an alert rule with metric **Config change detected** (`config_change`) under **Alert Rules** to receive notifications when any device's running config changes.

## Juniper: NETCONF instead of SSH screen-scraping

If a Juniper device has the `junos_netconf` API method enabled and reachable (Device Settings drawer → **API Methods**), config backup, compliance, and deploy all switch from SSH-CLI screen-scraping to structured NETCONF RPCs automatically — same `ssh` credential, no separate setup. Falls back to the normal Netmiko path if NETCONF isn't enabled or reachable.

## Junos operational ("show") commands

Juniper devices get a fourth config-page tab, **Operational**, next to History/Compliance/Deploy. It's for read-only `show ...` commands only — no lock, no commit, no config snapshot afterward. Quick-insert buttons cover the common ones (version, BGP summary, interfaces, route summary, alarms, chassis hardware); type or paste more, one per line. The Deploy tab will reject a `show` command pasted into it (and vice versa — Operational rejects `set`/`delete` lines) with a clear message telling you which tab to use instead. Works whether the device uses NETCONF or SSH, and whether it's hub-managed or behind a remote collector.

## Golden Config

A different feature from Compliance Policies — go to **Config** → **Golden Config** tab. Instead of pass/fail rules, you write one reference template of expected config lines (supports `{{hostname}}`, `{{mgmt_ip}}`, `{{vendor}}`, `{{device_type}}`, `{{fqdn}}` placeholders, auto-filled per device). Every matching device's latest backup gets scored as a percentage — how many template lines are actually present in the device's config — plus a list of what's missing. Runs automatically on every new backup. Use this for "how close is this device to our standard build," and Compliance Policies for "does this specific rule pass or fail."

## Config rollback

Roll a device back to a previous snapshot from its backup history — click **⟲ Rollback** next to any non-latest backup (Device page → Config tab). Only shown for vendors that support it (not ProCurve). Under the hood, the hub serves that snapshot to the device over a one-shot, locked-down HTTP (or SFTP, for Aruba CX) connection, and the device applies it as a full config replace using its own native command — this is a true replace, so anything in the running config that isn't in the snapshot gets removed. The confirmation dialog shows you a diff of what will change and requires typing the device's exact hostname before it'll proceed — that's the only safety net, so read the diff. A reason is required and goes to the audit log.

## Git config archive

Every config backup that actually changes something is committed to a local git repository automatically (one repo per tenant, one file per device) — a second, independent history alongside the diffs stored in the database. Go to **Config** → **Git Archive** tab to see repo status, and optionally set a remote (GitHub/GitLab/etc.) to mirror every commit off-box for backup purposes. Purely additive — if the remote push fails, config collection still works normally.
