#!/bin/bash
# Anthrimon — apply VictoriaMetrics retention period
#
# VictoriaMetrics only reads -retentionPeriod at startup, so changing it
# requires rewriting the systemd unit and restarting the service. Invoked
# (via sudo, see infra/sudoers.d/anthrimon-storage) by
# PUT /admin/data/retention/metrics in api/backend/routers/admin.py.
#
# Usage: sudo /usr/local/bin/apply-vm-retention.sh <months>

set -euo pipefail

UNIT_FILE="/etc/systemd/system/victoria-metrics.service"
MONTHS="${1:-}"

[[ "${MONTHS}" =~ ^[0-9]{1,3}$ ]] || { echo "months must be a 1-3 digit integer" >&2; exit 1; }
(( MONTHS >= 1 && MONTHS <= 120 )) || { echo "months must be between 1 and 120" >&2; exit 1; }
[[ -f "${UNIT_FILE}" ]] || { echo "${UNIT_FILE} not found" >&2; exit 1; }

sed -i -E "s/-retentionPeriod=[0-9]+/-retentionPeriod=${MONTHS}/" "${UNIT_FILE}"

systemctl daemon-reload
systemctl restart victoria-metrics

echo "VictoriaMetrics retention set to ${MONTHS} months"
