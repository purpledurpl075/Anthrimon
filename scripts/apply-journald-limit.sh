#!/bin/bash
# Anthrimon — apply journald max disk usage cap
#
# Writes a drop-in overriding SystemMaxUse and restarts systemd-journald
# (journald re-reads its config on restart; no daemon-reload needed since
# this isn't a unit file). Invoked (via sudo, see
# infra/sudoers.d/anthrimon-storage) by PUT /admin/data/retention/journal in
# api/backend/routers/admin.py.
#
# Usage: sudo /usr/local/bin/apply-journald-limit.sh <max_size_mb>

set -euo pipefail

DROPIN_DIR="/etc/systemd/journald.conf.d"
DROPIN_FILE="${DROPIN_DIR}/99-anthrimon.conf"
MB="${1:-}"

[[ "${MB}" =~ ^[0-9]{2,5}$ ]] || { echo "max_size_mb must be a 2-5 digit integer" >&2; exit 1; }
(( MB >= 64 && MB <= 16384 )) || { echo "max_size_mb must be between 64 and 16384" >&2; exit 1; }

mkdir -p "${DROPIN_DIR}"
cat > "${DROPIN_FILE}" <<EOF
# Managed by Anthrimon — Admin > Data > Storage. Do not edit by hand;
# changes will be overwritten on next save.
[Journal]
SystemMaxUse=${MB}M
EOF

systemctl restart systemd-journald

echo "journald SystemMaxUse set to ${MB}M"
