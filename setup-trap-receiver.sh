#!/usr/bin/env bash
# setup-trap-receiver.sh — install and provision the Anthrimon hub SNMP trap receiver
#
# Run once on the hub after the main install:
#   sudo bash setup-trap-receiver.sh
#
# Safe to re-run: skips provisioning if an API key already exists.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRAP_BIN="/usr/local/bin/anthrimon-trap-receiver"
TRAP_ENV="/etc/anthrimon/trap-receiver.env"
API_PORT="8001"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

ok()   { echo -e "  ${GREEN}✔${RESET}  $*"; }
info() { echo -e "  ${CYAN}→${RESET}  $*"; }
warn() { echo -e "  ${YELLOW}!${RESET}  $*"; }
die()  { echo -e "  ${RED}✘${RESET}  $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run with sudo: sudo bash $0"

REAL_USER="${SUDO_USER:-$USER}"

echo -e "\n${BOLD}━━━  Anthrimon hub SNMP trap receiver  ━━━${RESET}\n"

# ── 1. Build binary ───────────────────────────────────────────────────────────

info "Building anthrimon-trap-receiver..."
sudo -u "${REAL_USER}" bash -c \
  "cd '${REPO_DIR}/collectors/remote' && \
   /usr/local/go/bin/go build -o /tmp/anthrimon-trap-receiver-build ./cmd/trap-receiver/"
install -m 755 /tmp/anthrimon-trap-receiver-build "${TRAP_BIN}"
rm -f /tmp/anthrimon-trap-receiver-build
ok "Binary installed to ${TRAP_BIN}"

# ── 2. Provision API key ──────────────────────────────────────────────────────

mkdir -p /etc/anthrimon

if [[ -f "${TRAP_ENV}" ]] && grep -q "ANTHRIMON_TRAP_API_KEY=" "${TRAP_ENV}"; then
    ok "API key already provisioned at ${TRAP_ENV} — skipping"
else
    info "Provisioning hub-trap-receiver API key..."

    # Resolve DB credentials from the running API service file
    DB_USER=$(grep -oP '(?<=DB_USER=)[^\s"]+' /etc/systemd/system/anthrimon-api.service 2>/dev/null || echo "anthrimon")
    DB_PASS=$(grep -oP '(?<=DB_PASSWORD=)[^\s"]+' /etc/systemd/system/anthrimon-api.service 2>/dev/null || echo "")
    DB_NAME=$(grep -oP '(?<=DB_NAME=)[^\s"]+' /etc/systemd/system/anthrimon-api.service 2>/dev/null || echo "anthrimon")

    psql_cmd() {
        PGPASSWORD="${DB_PASS}" psql -U "${DB_USER}" -h 127.0.0.1 -d "${DB_NAME}" "$@"
    }

    TENANT_ID=$(psql_cmd -tAc "SELECT id FROM tenants LIMIT 1" 2>/dev/null | tr -d '[:space:]')
    [[ -n "${TENANT_ID}" ]] || die "No tenant found in database — is the API running and seeded?"

    TRAP_API_KEY=$(openssl rand -hex 32)
    TRAP_KEY_HASH=$(printf '%s' "${TRAP_API_KEY}" | sha256sum | awk '{print $1}')
    TOKEN_HASH=$(openssl rand -hex 32)

    psql_cmd -c "
        INSERT INTO remote_collectors
            (tenant_id, name, token_hash, api_key_hash, status, capabilities, registered_at)
        VALUES
            ('${TENANT_ID}', 'hub-trap-receiver',
             '${TOKEN_HASH}',
             '${TRAP_KEY_HASH}',
             'online',
             '[\"traps\"]',
             NOW())
        ON CONFLICT (tenant_id, name) DO UPDATE
            SET api_key_hash = EXCLUDED.api_key_hash,
                status       = 'online',
                updated_at   = NOW();
    " 2>/dev/null

    cat > "${TRAP_ENV}" <<EOF
ANTHRIMON_TRAP_API_KEY=${TRAP_API_KEY}
EOF
    chmod 600 "${TRAP_ENV}"
    ok "API key written to ${TRAP_ENV}"
fi

# ── 3. Install systemd service ────────────────────────────────────────────────

info "Installing systemd service..."

cat > /etc/systemd/system/anthrimon-trap-receiver.service <<EOF
[Unit]
Description=Anthrimon Hub SNMP Trap Receiver
After=network-online.target anthrimon-api.service
Wants=network-online.target

[Service]
User=root
EnvironmentFile=${TRAP_ENV}
Environment="ANTHRIMON_TRAP_HUB_URL=http://127.0.0.1:${API_PORT}"
Environment="ANTHRIMON_TRAP_ADDR=:162"
ExecStart=${TRAP_BIN}
Restart=on-failure
RestartSec=10
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now anthrimon-trap-receiver
ok "anthrimon-trap-receiver enabled and started"

# ── 4. Verify ─────────────────────────────────────────────────────────────────

sleep 2
if systemctl is-active --quiet anthrimon-trap-receiver; then
    ok "Service is running"
else
    warn "Service did not start cleanly — check: journalctl -u anthrimon-trap-receiver -n 30"
    exit 1
fi

echo -e "\n${GREEN}${BOLD}  Done.${RESET} Hub trap receiver listening on UDP :162"
echo -e "  Point SNMP trap destinations to this host and traps will appear in Logging → Traps\n"
