# Licensing

Anthrimon's core platform — device monitoring, alerting, flow, syslog, traps, topology, config management — is **free, with no license required**. A small number of add-on modules (currently **Advanced Reports**) are license-gated on top of that.

## Checking your license status

Go to **Platform** → **License** tab. This shows whether a license is currently active, which modules it covers, and its expiry date.

## Applying a license

1. **Platform** → **License** → **Download license request** — this exports a fingerprint of this specific machine
2. Send the downloaded file to get a signed license issued for it
3. Back in the **License** tab, **Apply a license** and upload the file you receive
4. Licensed modules unlock immediately — no restart needed

To remove a license and revert to the free tier, use **Remove license** in the same tab.

## Moving to new hardware

Licenses are node-locked — they're only valid for the specific machine fingerprint they were issued against. If you move your install to new hardware (or the fingerprint otherwise changes), the license stops matching and licensed modules quietly fall back to free-tier behavior — nothing breaks, the paid features just stop being available until you request and apply a new license for the new machine.

## What happens without a license

Nothing licensed is required for day-to-day monitoring. Licensed features (like Advanced Reports) show as locked in the sidebar with a link to request a license, instead of being unusable errors.
