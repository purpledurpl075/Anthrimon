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
