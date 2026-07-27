# Backup and Restore

Full-platform backup and restore, covering PostgreSQL, ClickHouse, TLS/WireGuard keys, and stored config snapshots.

## What's included

- PostgreSQL database (full dump)
- ClickHouse tables (flow/syslog/trap history — optional, can be excluded to keep the archive small)
- `/etc/anthrimon/` — environment file, TLS certs, WireGuard keys
- `/var/lib/anthrimon/` — stored device config backups/snapshots
- systemd unit files

Everything is packaged into one archive (optionally encrypted).

## Taking a backup

**Platform Admin** → **Platform Health** page → **Backup & download**. Choose whether to include ClickHouse flow/syslog history (excluding it makes for a much smaller, faster backup), then download the resulting archive.

You can also run it from the command line on the server: `anthrimon-backup`.

## Restoring

1. Upload a previously-downloaded archive via **Platform Health** → **Upload backup** (or copy it to the server manually)
2. The UI shows you the exact restore command to run
3. SSH into the server and run it: `sudo anthrimon-restore <path-to-archive>`

Restore is destructive (it replaces current data) and is intentionally CLI-only rather than a one-click UI button — review what you're restoring over before running it.
