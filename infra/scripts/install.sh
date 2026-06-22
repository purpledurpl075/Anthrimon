#!/usr/bin/env bash
# Anthrimon — full-stack installer
# Targets Ubuntu 22.04 / 24.04 LTS (bare metal or VM)
# Usage: sudo bash infra/scripts/install.sh
#
# What this script does:
#   1.  Installs system packages (nginx, wireguard-tools, build tools, etc.)
#   2.  Installs Go 1.26.4
#   3.  Installs Node.js 20.x (via NodeSource)
#   4.  Installs Python virtualenv + API requirements
#   5.  Installs PostgreSQL 14, creates role/database
#   6.  Runs all PostgreSQL migrations + grants
#   7.  Installs ClickHouse, runs all ClickHouse migrations
#   8.  Installs VictoriaMetrics as a systemd service
#   9.  Builds the SNMP collector (Go) + installs systemd unit
#   10. Builds the flow collector (Go) + installs systemd unit
#   11. Builds the syslog collector (Go) + installs systemd unit
#   12. Builds the hub SNMP trap receiver + installs systemd unit
#   13. Builds the remote collector + trap-handler binaries (no service — needs token first)
#   14. Builds the frontend production bundle (npm)
#   14. Generates TLS certificate (self-signed CA + server cert)
#   15. Configures nginx with HTTPS
#   16. Sets up WireGuard hub interface (wg0) + sudoers grant for wg commands
#   16b. Installs anthrimon-backup / anthrimon-restore CLI + sudoers grant for tar
#   16c. Opens firewall ports 5050-5054 for config rollback (device-pulls-from-HTTP)
#   17. Installs the API systemd unit + seeds platform settings
#   18. Starts everything and prints a summary

set -euo pipefail

# ── Fixed constants ───────────────────────────────────────────────────────────

GO_VERSION="1.26.4"
GO_ARCHIVE="go${GO_VERSION}.linux-amd64.tar.gz"
GO_URL="https://go.dev/dl/${GO_ARCHIVE}"
GO_INSTALL_DIR="/usr/local"

VM_VERSION="1.96.0"
VM_BINARY="victoria-metrics-linux-amd64-v${VM_VERSION}.tar.gz"
VM_URL="https://github.com/VictoriaMetrics/VictoriaMetrics/releases/download/v${VM_VERSION}/${VM_BINARY}"
VM_INSTALL="/usr/local/bin/victoria-metrics-prod"
VM_DATA="/var/lib/victoria-metrics"

API_PORT="8001"
TLS_DIR="/etc/anthrimon/tls"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ── Colour helpers ────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

ok()   { echo -e "  ${GREEN}✔${RESET}  $*"; }
info() { echo -e "  ${CYAN}→${RESET}  $*"; }
warn() { echo -e "  ${YELLOW}!${RESET}  $*"; }
err()  { echo -e "  ${RED}✘${RESET}  $*" >&2; }
hdr()  { echo -e "\n${BOLD}━━━  $*  ━━━${RESET}"; }
die()  { err "$*"; exit 1; }

# ── Prompt helpers ────────────────────────────────────────────────────────────

ask() {
    local _var="$1" _prompt="$2" _default="$3" _input
    read -rp "$(echo -e "  ${CYAN}?${RESET}  ${_prompt} [${BOLD}${_default}${RESET}]: ")" _input </dev/tty
    printf -v "${_var}" '%s' "${_input:-${_default}}"
}

ask_secret() {
    local _var="$1" _prompt="$2" _a _b
    while true; do
        read -rsp "$(echo -e "  ${CYAN}?${RESET}  ${_prompt}: ")" _a </dev/tty; echo
        read -rsp "$(echo -e "  ${CYAN}?${RESET}  Confirm ${_prompt}: ")" _b </dev/tty; echo
        if [[ "$_a" == "$_b" ]]; then
            printf -v "${_var}" '%s' "${_a}"
            break
        fi
        warn "Passwords do not match, try again."
    done
}

ask_yn() {
    local _var="$1" _prompt="$2" _input
    read -rp "$(echo -e "  ${CYAN}?${RESET}  ${_prompt} [y/N]: ")" _input </dev/tty
    printf -v "${_var}" '%s' "${_input,,}"
}

# Escape a string for safe interpolation inside a single-quoted SQL literal.
# Doubles every single quote: O'Brien → O''Brien
_sql_esc() { printf "%s" "$1" | sed "s/'/''/g"; }

# ── Preflight ─────────────────────────────────────────────────────────────────

hdr "Preflight"
[[ $EUID -eq 0 ]] || die "Run with sudo: sudo bash $0"

REAL_USER="${SUDO_USER:-$USER}"
REAL_HOME=$(getent passwd "${REAL_USER}" | cut -d: -f6)
info "Installing for user: ${REAL_USER} (home: ${REAL_HOME})"

if ! grep -qE 'Ubuntu (22|24)\.04' /etc/os-release 2>/dev/null; then
    warn "This script targets Ubuntu 22.04 / 24.04 LTS. Continuing anyway."
fi
ok "Preflight passed"

# ── Configuration prompts ─────────────────────────────────────────────────────

hdr "Configuration"
echo -e "  Press Enter to accept the ${BOLD}default${RESET} shown in brackets.\n"

DETECTED_IP=$(hostname -I | awk '{print $1}')

ask    DB_USER      "PostgreSQL role name"             "anthrimon"
ask    DB_NAME      "PostgreSQL database name"         "anthrimon"

echo -e "  ${CYAN}→${RESET}  Leave the database password blank to generate a random one."
ask_secret DB_PASS  "Database password"
if [[ -z "${DB_PASS}" ]]; then
    DB_PASS=$(openssl rand -base64 18 | tr -dc 'a-zA-Z0-9' | head -c 24)
    ok "Generated random database password"
fi

ask    BASE_URL     "Public base URL (used in alert emails and collector config)" \
                    "https://${DETECTED_IP}"
BASE_URL="${BASE_URL%/}"

ask    NETFLOW_PORT "NetFlow / IPFIX UDP listen port"  "2055"
ask    SFLOW_PORT   "sFlow UDP listen port"            "6343"

echo ""
echo -e "  ${BOLD}Summary:${RESET}"
echo -e "  DB role/database  : ${CYAN}${DB_USER}${RESET} / ${CYAN}${DB_NAME}${RESET}"
echo -e "  DB password       : ${CYAN}(set)${RESET}"
echo -e "  Public URL        : ${CYAN}${BASE_URL}${RESET}"
echo -e "  NetFlow port      : ${CYAN}${NETFLOW_PORT}${RESET}"
echo -e "  sFlow port        : ${CYAN}${SFLOW_PORT}${RESET}"
echo ""
ask_yn _CONFIRM "Proceed with installation?"
[[ "${_CONFIRM}" == "y" ]] || die "Aborted."

# ── 1. System packages ────────────────────────────────────────────────────────

hdr "System packages"
apt-get update -qq
apt-get install -y -qq \
    curl wget gnupg2 ca-certificates lsb-release apt-transport-https \
    git build-essential openssl zstd \
    python3 python3-pip python3-venv python3-dev \
    libpq-dev postgresql-client \
    nginx \
    wireguard wireguard-tools \
    snmptrapd \
    net-tools iproute2 traceroute mtr iputils-ping \
    jq unzip
ok "System packages installed"

# ── 2. Go ─────────────────────────────────────────────────────────────────────

hdr "Go ${GO_VERSION}"
export PATH="$PATH:/usr/local/go/bin"
if go version 2>/dev/null | grep -q "${GO_VERSION}"; then
    ok "Go ${GO_VERSION} already installed"
else
    info "Downloading ${GO_ARCHIVE}..."
    TMP_GO=$(mktemp -d)
    curl -fsSL "${GO_URL}" -o "${TMP_GO}/${GO_ARCHIVE}"
    # Fetch expected sha256 from go.dev's JSON manifest (same TLS channel as download site)
    _GO_SHA_SCRIPT='
import json,sys
data=json.load(sys.stdin)
for v in data:
    if v.get("version")=="go'"${GO_VERSION}"'":
        for f in v.get("files",[]):
            if f.get("filename")=="'"${GO_ARCHIVE}"'":
                print(f["sha256"]); break
'
    _GO_SHA256=$(curl -fsSL "https://go.dev/dl/?mode=json" | python3 -c "${_GO_SHA_SCRIPT}" 2>/dev/null)
    if [[ -z "${_GO_SHA256}" ]]; then
        _GO_SHA256=$(curl -fsSL "https://go.dev/dl/?mode=json&include=all" | python3 -c "${_GO_SHA_SCRIPT}" 2>/dev/null)
    fi
    if [[ -z "${_GO_SHA256}" ]]; then
        die "Could not fetch sha256 for ${GO_ARCHIVE} from go.dev — aborting"
    fi
    echo "${_GO_SHA256}  ${TMP_GO}/${GO_ARCHIVE}" | sha256sum -c - \
        || die "Go download checksum mismatch — aborting"
    rm -rf "${GO_INSTALL_DIR}/go"
    tar -C "${GO_INSTALL_DIR}" -xzf "${TMP_GO}/${GO_ARCHIVE}"
    rm -rf "${TMP_GO}"
    cat > /etc/profile.d/go.sh <<'EOF'
export PATH=$PATH:/usr/local/go/bin
EOF
    chmod 644 /etc/profile.d/go.sh
    ok "Go ${GO_VERSION} installed"
fi

# ── 3. Node.js 20.x ──────────────────────────────────────────────────────────

hdr "Node.js 20.x"
if node --version 2>/dev/null | grep -q '^v20\.'; then
    ok "Node.js $(node --version) already installed"
else
    info "Adding NodeSource repo for Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
    apt-get install -y -qq nodejs
    ok "Node.js $(node --version) installed"
fi

# ── 4. Python virtualenv + requirements ──────────────────────────────────────

hdr "Python — virtualenv + requirements"
API_DIR="${REPO_DIR}/api"
VENV_DIR="${API_DIR}/.venv"

# pydantic-core requires Python ≤ 3.13.  If the system python3 is 3.14+,
# install Python 3.12 from deadsnakes and use that for the venv.
_PY_MAJOR=$(python3 -c 'import sys; print(sys.version_info.minor)' 2>/dev/null || echo 0)
if (( _PY_MAJOR >= 14 )); then
    info "System Python is 3.${_PY_MAJOR} — installing Python 3.12 for compatibility..."
    if ! command -v python3.12 &>/dev/null; then
        add-apt-repository -y ppa:deadsnakes/ppa >/dev/null 2>&1
        apt-get update -qq
        apt-get install -y -qq python3.12 python3.12-venv python3.12-dev
    fi
    _PYTHON=python3.12
    ok "Using Python 3.12 for virtualenv"
else
    _PYTHON=python3
fi

if [[ ! -d "${VENV_DIR}" ]]; then
    info "Creating virtualenv..."
    sudo -u "${REAL_USER}" "${_PYTHON}" -m venv "${VENV_DIR}"
elif [[ -n "${_PYTHON}" && "${_PYTHON}" != "python3" ]]; then
    # Recreate venv if we switched Python versions
    _VENV_PY=$("${VENV_DIR}/bin/python3" -c 'import sys; print(sys.version_info.minor)' 2>/dev/null || echo 0)
    if (( _VENV_PY >= 14 )); then
        info "Recreating virtualenv with ${_PYTHON}..."
        rm -rf "${VENV_DIR}"
        sudo -u "${REAL_USER}" "${_PYTHON}" -m venv "${VENV_DIR}"
    fi
fi
info "Installing Python requirements..."
sudo -u "${REAL_USER}" "${VENV_DIR}/bin/pip" install --quiet --upgrade pip
sudo -u "${REAL_USER}" "${VENV_DIR}/bin/pip" install --quiet \
    -r "${API_DIR}/backend/requirements.txt"
ok "Python requirements installed"

# ── 5. PostgreSQL 14 ─────────────────────────────────────────────────────────

hdr "PostgreSQL 14"
if ! dpkg -l postgresql-14 2>/dev/null | grep -q '^ii'; then
    info "Adding PostgreSQL apt repo..."
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        | gpg --dearmor -o /usr/share/keyrings/postgresql.gpg
    echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] \
https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list
    apt-get update -qq
    apt-get install -y -qq postgresql-14 postgresql-client-14
    ok "PostgreSQL 14 installed"
else
    ok "PostgreSQL 14 already installed"
fi

systemctl enable postgresql
systemctl start postgresql
ok "PostgreSQL service running"

pg_su() { sudo -u postgres bash -c 'cd /tmp && psql "$@"' -- "$@"; }

if pg_su -tAc "SELECT 1 FROM pg_roles WHERE rolname='$(_sql_esc "${DB_USER}")'" 2>/dev/null | grep -q 1; then
    ok "Role '${DB_USER}' exists"
else
    info "Creating role '${DB_USER}'..."
    pg_su -c "CREATE ROLE \"$(_sql_esc "${DB_USER}")\" WITH LOGIN PASSWORD '$(_sql_esc "${DB_PASS}")';"
    ok "Role created"
fi

if pg_su -tAc "SELECT 1 FROM pg_database WHERE datname='$(_sql_esc "${DB_NAME}")'" 2>/dev/null | grep -q 1; then
    ok "Database '${DB_NAME}' exists"
else
    info "Creating database '${DB_NAME}'..."
    pg_su -c "CREATE DATABASE \"$(_sql_esc "${DB_NAME}")\" OWNER \"$(_sql_esc "${DB_USER}")\";"
    ok "Database created"
fi

# ── 6. PostgreSQL migrations ──────────────────────────────────────────────────

hdr "PostgreSQL migrations"
PG_MIGRATIONS="${REPO_DIR}/storage/migrations/postgres"

pg_su -d "${DB_NAME}" -c "
    CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT now()
    );
" 2>/dev/null

for f in "${PG_MIGRATIONS}"/*.sql; do
    [[ -f "$f" ]] || continue
    fname=$(basename "$f")
    if pg_su -d "${DB_NAME}" -tAc \
        "SELECT 1 FROM schema_migrations WHERE filename='$(_sql_esc "${fname}")'" 2>/dev/null | grep -q 1; then
        ok "${fname} — already applied"
    else
        info "Applying ${fname}..."
        pg_su -d "${DB_NAME}" < "$f"
        pg_su -d "${DB_NAME}" -c \
            "INSERT INTO schema_migrations(filename) VALUES ('$(_sql_esc "${fname}")');"
        ok "${fname} — applied"
    fi
done

# Grant ALL privileges on every table/sequence/function in one pass after all
# migrations have run. This covers both freshly-applied and already-applied
# migrations — tables created by any migration will be granted here.
info "Granting database privileges to ${DB_USER}..."
pg_su -d "${DB_NAME}" -c "
    GRANT ALL PRIVILEGES ON ALL TABLES    IN SCHEMA public TO \"$(_sql_esc "${DB_USER}")\";
    GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO \"$(_sql_esc "${DB_USER}")\";
    GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO \"$(_sql_esc "${DB_USER}")\";
" 2>/dev/null || true

# Ensure any future objects (created by later migrations or pg_su commands)
# are also automatically accessible to the app role.
pg_su -d "${DB_NAME}" -c "
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
        GRANT ALL ON TABLES    TO \"$(_sql_esc "${DB_USER}")\";
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
        GRANT ALL ON SEQUENCES TO \"$(_sql_esc "${DB_USER}")\";
    ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
        GRANT ALL ON FUNCTIONS TO \"$(_sql_esc "${DB_USER}")\";
" 2>/dev/null || true
ok "Database privileges granted"

# ── 7. ClickHouse ─────────────────────────────────────────────────────────────

hdr "ClickHouse"
if ! dpkg -l clickhouse-server 2>/dev/null | grep -q '^ii'; then
    info "Adding ClickHouse apt repo..."
    curl -fsSL 'https://packages.clickhouse.com/rpm/lts/repodata/repomd.xml.key' \
        | gpg --dearmor -o /usr/share/keyrings/clickhouse-keyring.gpg
    echo "deb [signed-by=/usr/share/keyrings/clickhouse-keyring.gpg arch=amd64] \
https://packages.clickhouse.com/deb stable main" \
        > /etc/apt/sources.list.d/clickhouse.list
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y clickhouse-server clickhouse-client
    ok "ClickHouse installed"
else
    ok "ClickHouse already installed"
fi

systemctl enable clickhouse-server
systemctl start clickhouse-server
for i in $(seq 1 10); do
    clickhouse-client --query "SELECT 1" &>/dev/null && break || sleep 2
done

info "Applying ClickHouse migrations..."
CH_MIGRATIONS="${REPO_DIR}/storage/migrations/clickhouse"
for f in "${CH_MIGRATIONS}"/*.sql; do
    [[ -f "$f" ]] || continue
    fname=$(basename "$f")
    info "  ${fname}..."
    clickhouse-client --multiquery < "$f" 2>/dev/null \
        && ok "${fname} applied (or already exists)" \
        || warn "${fname} returned errors (tables may already exist)"
done

# ── 8. VictoriaMetrics ────────────────────────────────────────────────────────

hdr "VictoriaMetrics ${VM_VERSION}"
if [[ -x "${VM_INSTALL}" ]]; then
    ok "VictoriaMetrics already installed at ${VM_INSTALL}"
else
    info "Downloading VictoriaMetrics v${VM_VERSION}..."
    TMP_VM=$(mktemp -d)
    _VM_SHA256_URL="https://github.com/VictoriaMetrics/VictoriaMetrics/releases/download/v${VM_VERSION}/victoria-metrics-linux-amd64-v${VM_VERSION}_checksums.txt"
    _VM_SHA256=$(curl -fsSL "${_VM_SHA256_URL}" 2>/dev/null | grep "${VM_BINARY}" | awk '{print $1}')
    if [[ -z "${_VM_SHA256}" ]]; then
        die "Could not fetch sha256 for VictoriaMetrics v${VM_VERSION} — aborting"
    fi
    curl -fsSL "${VM_URL}" -o "${TMP_VM}/${VM_BINARY}"
    echo "${_VM_SHA256}  ${TMP_VM}/${VM_BINARY}" | sha256sum -c - \
        || die "VictoriaMetrics download checksum mismatch — aborting"
    tar -xzf "${TMP_VM}/${VM_BINARY}" -C "${TMP_VM}"
    install -m 755 "${TMP_VM}/victoria-metrics-prod" "${VM_INSTALL}"
    rm -rf "${TMP_VM}"
    ok "VictoriaMetrics installed at ${VM_INSTALL}"
fi

mkdir -p "${VM_DATA}"
chown -R "${REAL_USER}":"${REAL_USER}" "${VM_DATA}"

cat > /etc/systemd/system/victoria-metrics.service <<EOF
[Unit]
Description=VictoriaMetrics time-series database
After=network.target

[Service]
User=${REAL_USER}
ExecStart=${VM_INSTALL} \\
    -storageDataPath=${VM_DATA} \\
    -httpListenAddr=:8428 \\
    -retentionPeriod=12
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable victoria-metrics
systemctl restart victoria-metrics
ok "VictoriaMetrics service running"

# Collector binaries are installed to /usr/local/bin/ so they survive git
# operations (clean, checkout, reset) on the repo directory.
# Each service also has an ExecStartPre that rebuilds from source automatically
# if the binary is ever missing — self-healing on next systemctl start.

SNMP_BIN="/usr/local/bin/anthrimon-snmp-collector"
FLOW_BIN="/usr/local/bin/anthrimon-flow-collector"
SYSLOG_BIN="/usr/local/bin/anthrimon-syslog-collector"

# ── 9. SNMP collector ─────────────────────────────────────────────────────────

hdr "SNMP collector"
SNMP_DIR="${REPO_DIR}/collectors/snmp"
info "Building snmp-collector..."
sudo -u "${REAL_USER}" bash -c "cd '${SNMP_DIR}' && /usr/local/go/bin/go build -o /tmp/snmp-collector-build ./cmd/snmp-collector/"
install -m 755 /tmp/snmp-collector-build "${SNMP_BIN}"
rm -f /tmp/snmp-collector-build
ok "snmp-collector installed to ${SNMP_BIN}"

SNMP_YAML="${SNMP_DIR}/snmp-collector.yaml"
if [[ ! -f "${SNMP_YAML}" ]]; then
    cat > "${SNMP_YAML}" <<EOF
log:
  level: info

database:
  dsn: "postgres://${DB_USER}:${DB_PASS}@127.0.0.1/${DB_NAME}?sslmode=disable"
  max_conns: 5
  min_conns: 1

snmp:
  timeout_seconds: 10
  retries: 3

polling:
  default_interval_s: 15
  health_multiplier: 1
  device_refresh_s: 30
  max_concurrent_devices: 500

metrics:
  victoriametrics_url: "http://localhost:8428"
  flush_interval: 10s
  batch_size: 500
EOF
    chown "${REAL_USER}":"${REAL_USER}" "${SNMP_YAML}"
    ok "snmp-collector.yaml written"
else
    ok "snmp-collector.yaml already exists — skipping"
fi

cat > /etc/systemd/system/snmp-collector.service <<EOF
[Unit]
Description=Anthrimon SNMP collector
After=network.target postgresql.service victoria-metrics.service

[Service]
User=${REAL_USER}
ExecStartPre=/bin/bash -c 'test -x ${SNMP_BIN} || (cd ${SNMP_DIR} && /usr/local/go/bin/go build -o ${SNMP_BIN} ./cmd/snmp-collector/)'
ExecStart=${SNMP_BIN} --config ${SNMP_YAML}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable snmp-collector
systemctl restart snmp-collector
ok "snmp-collector service running"

# ── 10. Flow collector ────────────────────────────────────────────────────────

hdr "Flow collector"
FLOW_DIR="${REPO_DIR}/collectors/flow"
info "Building flow-collector..."
sudo -u "${REAL_USER}" bash -c "cd '${FLOW_DIR}' && /usr/local/go/bin/go build -o /tmp/flow-collector-build ./cmd/flow-collector/"
install -m 755 /tmp/flow-collector-build "${FLOW_BIN}"
rm -f /tmp/flow-collector-build
ok "flow-collector installed to ${FLOW_BIN}"

FLOW_YAML="${FLOW_DIR}/flow-collector.yaml"
if [[ ! -f "${FLOW_YAML}" ]]; then
    cat > "${FLOW_YAML}" <<EOF
log:
  level: info

database:
  dsn: "postgres://${DB_USER}:${DB_PASS}@127.0.0.1/${DB_NAME}?sslmode=disable"
  max_conns: 3

clickhouse:
  dsn: "clickhouse://localhost:9000/default"
  max_conns: 5

listener:
  netflow_addr: ":${NETFLOW_PORT}"
  sflow_addr:   ":${SFLOW_PORT}"
  buffer_size:  65535

writer:
  batch_size:       2000
  flush_interval_s: 5

lookup:
  device_refresh_s: 300
EOF
    chown "${REAL_USER}":"${REAL_USER}" "${FLOW_YAML}"
    ok "flow-collector.yaml written"
else
    ok "flow-collector.yaml already exists — skipping"
fi

cat > /etc/systemd/system/flow-collector.service <<EOF
[Unit]
Description=Anthrimon flow collector (NetFlow v5/v9, IPFIX, sFlow v5)
After=network.target postgresql.service clickhouse-server.service

[Service]
User=${REAL_USER}
ExecStartPre=/bin/bash -c 'test -x ${FLOW_BIN} || (cd ${FLOW_DIR} && /usr/local/go/bin/go build -o ${FLOW_BIN} ./cmd/flow-collector/)'
ExecStart=${FLOW_BIN} --config ${FLOW_YAML}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable flow-collector
systemctl restart flow-collector
ok "flow-collector service running"

# ── 11. Syslog collector ──────────────────────────────────────────────────────

hdr "Syslog collector"
SYSLOG_DIR="${REPO_DIR}/collectors/syslog"
info "Building syslog-collector..."
sudo -u "${REAL_USER}" bash -c "cd '${SYSLOG_DIR}' && /usr/local/go/bin/go build -o /tmp/syslog-collector-build ./cmd/syslog-collector/"
install -m 755 /tmp/syslog-collector-build "${SYSLOG_BIN}"
rm -f /tmp/syslog-collector-build
ok "syslog-collector installed to ${SYSLOG_BIN}"

SYSLOG_YAML="${SYSLOG_DIR}/syslog-collector.yaml"
if [[ ! -f "${SYSLOG_YAML}" ]]; then
    cat > "${SYSLOG_YAML}" <<EOF
log:
  level: info

database:
  dsn: "postgres://${DB_USER}:${DB_PASS}@127.0.0.1/${DB_NAME}?sslmode=disable"
  max_conns: 3

clickhouse:
  dsn: "clickhouse://localhost:9000/default"

listener:
  udp_addr: ":514"
  tcp_addr: ":514"
  buffer_size: 65535

writer:
  batch_size:       1000
  flush_interval_s: 30

lookup:
  device_refresh_s: 300
EOF
    chown "${REAL_USER}":"${REAL_USER}" "${SYSLOG_YAML}"
    ok "syslog-collector.yaml written"
else
    ok "syslog-collector.yaml already exists — skipping"
fi

cat > /etc/systemd/system/syslog-collector.service <<EOF
[Unit]
Description=Anthrimon syslog collector (RFC 3164 + RFC 5424)
After=network.target postgresql.service clickhouse-server.service

[Service]
User=${REAL_USER}
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
ExecStartPre=/bin/bash -c 'test -x ${SYSLOG_BIN} || (cd ${SYSLOG_DIR} && /usr/local/go/bin/go build -o ${SYSLOG_BIN} ./cmd/syslog-collector/)'
ExecStart=${SYSLOG_BIN} --config ${SYSLOG_YAML}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable syslog-collector
systemctl restart syslog-collector
ok "syslog-collector service running"

# ── 12. Hub SNMP trap receiver ────────────────────────────────────────────────

hdr "Hub SNMP trap receiver"

# The hub uses snmptrapd (net-snmp) on :162 — same as remote collectors.
# snmptrapd handles v1/v2c/v3 (including Cisco authPriv) and calls
# anthrimon-traphandler which POSTs decoded traps to the hub API.
TRAP_ENV="/etc/anthrimon/trap-receiver.env"
REMOTE_COL_DIR="${REPO_DIR}/collectors/remote"

mkdir -p /etc/anthrimon

# Provision a hub-local API key for the trap handler to authenticate with.
if [[ -f "${TRAP_ENV}" ]] && grep -q "ANTHRIMON_TRAP_API_KEY=" "${TRAP_ENV}"; then
    ok "Hub trap API key already provisioned — skipping"
else
    TRAP_API_KEY=$(openssl rand -hex 32)
    TRAP_KEY_HASH=$(printf '%s' "${TRAP_API_KEY}" | sha256sum | awk '{print $1}')
    TENANT_ID=$(pg_su -d "${DB_NAME}" -tAc "SELECT id FROM tenants LIMIT 1" 2>/dev/null | tr -d '[:space:]')

    if [[ -z "${TENANT_ID}" ]]; then
        warn "No tenant found — cannot provision trap API key (run after first login)"
    else
        _TOKEN_HASH=$(openssl rand -hex 32)
        pg_su -d "${DB_NAME}" -c "
            INSERT INTO remote_collectors
                (tenant_id, name, token_hash, api_key_hash, status, capabilities, registered_at)
            VALUES
                ('$(_sql_esc "${TENANT_ID}")'::uuid, 'hub-trap-receiver',
                 '$(_sql_esc "${_TOKEN_HASH}")',
                 '$(_sql_esc "${TRAP_KEY_HASH}")',
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
ANTHRIMON_TRAP_HUB_URL=http://127.0.0.1:${API_PORT}
EOF
        chmod 600 "${TRAP_ENV}"
        ok "Hub trap API key provisioned"
    fi
fi

# Stop anthrimon-trap-receiver if it is running (replaced by snmptrapd).
systemctl stop anthrimon-trap-receiver 2>/dev/null || true
systemctl disable anthrimon-trap-receiver 2>/dev/null || true

# Give snmptrapd the hub API key so anthrimon-traphandler can POST traps.
mkdir -p /etc/systemd/system/snmptrapd.service.d
cat > /etc/systemd/system/snmptrapd.service.d/anthrimon.conf <<EOF
[Service]
EnvironmentFile=-${TRAP_ENV}
EOF

systemctl daemon-reload
systemctl enable snmptrapd
systemctl restart snmptrapd
ok "snmptrapd enabled on :162 (trap handler inherits API key from ${TRAP_ENV})"

# ── 13. Remote collector (build only) ────────────────────────────────────────
# Builds linux/amd64 and linux/arm64 binaries.  The hub-local binary (amd64)
# is installed system-wide so the hub itself can run a collector if needed.
# Both binaries are also stored in COLLECTOR_DIST so the API can serve them as
# downloadable deployment packages from the UI.
# The service is NOT started here — it requires a registration token first.

hdr "Remote collector (build only)"
REMOTE_DIR="${REPO_DIR}/collectors/remote"
COLLECTOR_DIST="/var/lib/anthrimon/downloads"
mkdir -p "${COLLECTOR_DIST}"
chown "${REAL_USER}":"${REAL_USER}" /var/lib/anthrimon
chown "${REAL_USER}":"${REAL_USER}" "${COLLECTOR_DIST}"

info "Building anthrimon-remote-collector (linux/amd64)..."
sudo -u "${REAL_USER}" bash -c \
  "cd '${REMOTE_DIR}' && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
   /usr/local/go/bin/go build -trimpath -ldflags='-s -w' \
   -o /tmp/anthrimon-remote-collector-linux-amd64 ./cmd/remote-collector/"
install -m 755 /tmp/anthrimon-remote-collector-linux-amd64 "${COLLECTOR_DIST}/anthrimon-remote-collector-linux-amd64"
install -m 755 /tmp/anthrimon-remote-collector-linux-amd64 /usr/local/bin/anthrimon-collector
rm -f /tmp/anthrimon-remote-collector-linux-amd64
ok "linux/amd64 → ${COLLECTOR_DIST}/anthrimon-remote-collector-linux-amd64"

info "Building anthrimon-remote-collector (linux/arm64)..."
sudo -u "${REAL_USER}" bash -c \
  "cd '${REMOTE_DIR}' && GOOS=linux GOARCH=arm64 CGO_ENABLED=0 \
   /usr/local/go/bin/go build -trimpath -ldflags='-s -w' \
   -o /tmp/anthrimon-remote-collector-linux-arm64 ./cmd/remote-collector/"
install -m 755 /tmp/anthrimon-remote-collector-linux-arm64 "${COLLECTOR_DIST}/anthrimon-remote-collector-linux-arm64"
rm -f /tmp/anthrimon-remote-collector-linux-arm64
ok "linux/arm64 → ${COLLECTOR_DIST}/anthrimon-remote-collector-linux-arm64"

info "Building anthrimon-trap-handler (linux/amd64)..."
sudo -u "${REAL_USER}" bash -c \
  "cd '${REMOTE_DIR}' && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
   /usr/local/go/bin/go build -trimpath -ldflags='-s -w' \
   -o /tmp/anthrimon-trap-handler-linux-amd64 ./cmd/trap-handler/"
install -m 755 /tmp/anthrimon-trap-handler-linux-amd64 "${COLLECTOR_DIST}/anthrimon-trap-handler-linux-amd64"
install -m 755 /tmp/anthrimon-trap-handler-linux-amd64 /usr/local/bin/anthrimon-traphandler
rm -f /tmp/anthrimon-trap-handler-linux-amd64
ok "linux/amd64 → ${COLLECTOR_DIST}/anthrimon-trap-handler-linux-amd64"

info "Building anthrimon-trap-handler (linux/arm64)..."
sudo -u "${REAL_USER}" bash -c \
  "cd '${REMOTE_DIR}' && GOOS=linux GOARCH=arm64 CGO_ENABLED=0 \
   /usr/local/go/bin/go build -trimpath -ldflags='-s -w' \
   -o /tmp/anthrimon-trap-handler-linux-arm64 ./cmd/trap-handler/"
install -m 755 /tmp/anthrimon-trap-handler-linux-arm64 "${COLLECTOR_DIST}/anthrimon-trap-handler-linux-arm64"
rm -f /tmp/anthrimon-trap-handler-linux-arm64
ok "linux/arm64 → ${COLLECTOR_DIST}/anthrimon-trap-handler-linux-arm64"

mkdir -p /etc/anthrimon
if [[ ! -f "/etc/anthrimon/remote-collector.yaml" ]]; then
    cat > /etc/anthrimon/remote-collector.yaml <<EOF
hub_url: "${BASE_URL}"
token: ""
ca_cert: "/etc/anthrimon/tls/ca.crt"
state_file: "/etc/anthrimon/collector-state.json"

snmp:
  polling_interval_s: 60
  max_concurrent: 20
  timeout_seconds: 10
  retries: 2

flow:
  netflow_addr: ":2055"
  sflow_addr: ":6343"
  buffer_size: 65535

syslog:
  udp_addr: ":514"
  tcp_addr: ":514"

forward:
  batch_size: 500
  flush_interval_s: 10

log:
  level: info
EOF
    chown "${REAL_USER}":"${REAL_USER}" /etc/anthrimon/remote-collector.yaml
    ok "Remote collector config written to /etc/anthrimon/remote-collector.yaml"
fi

if [[ ! -f "/etc/anthrimon/collector.env" ]]; then
    cat > /etc/anthrimon/collector.env <<'EOF'
# Paste the registration token from Anthrimon UI → Configuration → Collectors → New
# ANTHRIMON_TOKEN=paste-token-here
EOF
    chmod 600 /etc/anthrimon/collector.env
    ok "Env template written to /etc/anthrimon/collector.env"
fi

cp "${REMOTE_DIR}/remote-collector.service" /etc/systemd/system/anthrimon-collector.service
systemctl daemon-reload
warn "anthrimon-collector NOT started — register a collector in the UI first, then:"
warn "  1. Edit /etc/anthrimon/collector.env and set ANTHRIMON_TOKEN"
warn "  2. sudo systemctl enable --now anthrimon-collector"

# ── 13. Frontend production build ─────────────────────────────────────────────

hdr "Frontend production build"
FRONTEND_DIR="${REPO_DIR}/frontend/dashboard"
info "Installing npm dependencies..."
sudo -u "${REAL_USER}" bash -c "cd '${FRONTEND_DIR}' && npm install --silent"
info "Building production bundle..."
sudo -u "${REAL_USER}" bash -c "cd '${FRONTEND_DIR}' && npm run build"
ok "Frontend built to ${FRONTEND_DIR}/dist"

# ── 14. TLS (self-signed CA + server certificate) ─────────────────────────────

hdr "TLS certificates"
bash "${REPO_DIR}/scripts/setup-tls.sh"
# The API process (REAL_USER) needs to read ca.crt to include it in collector
# deployment packages.  Keep the private key root-only; only open the CA cert.
chmod 755 "${TLS_DIR}"
chmod 644 "${TLS_DIR}/ca.crt"

# ── 15. nginx ─────────────────────────────────────────────────────────────────

hdr "nginx"

# Grant nginx traversal access to the dist directory
chmod o+x "${REAL_HOME}" \
          "${REPO_DIR}" \
          "${REPO_DIR}/frontend" \
          "${FRONTEND_DIR}" \
          "${FRONTEND_DIR}/dist"

nginx -t && systemctl reload nginx
ok "nginx running with HTTPS"

# ── 16. WireGuard hub (wg0) ───────────────────────────────────────────────────

hdr "WireGuard hub"
bash "${REPO_DIR}/scripts/setup-wireguard.sh"

# Grant the API user passwordless sudo for the specific wg commands it needs
# (reading pubkey/port, adding/removing peers, saving config).
SUDOERS_DST="/etc/sudoers.d/anthrimon-wg"
sed "s/__API_USER__/${REAL_USER}/g" \
    "${REPO_DIR}/infra/anthrimon-wg-sudoers" > "${SUDOERS_DST}"
chmod 440 "${SUDOERS_DST}"
visudo -cf "${SUDOERS_DST}" && ok "sudoers rule written: ${SUDOERS_DST}" \
    || { rm -f "${SUDOERS_DST}"; warn "sudoers syntax check failed — skipping"; }

# ── 16b. Backup tool (CLI + sudoers for tar) ─────────────────────────────────

hdr "Backup tool"

# Make anthrimon-backup / anthrimon-restore callable from anywhere — both as
# CLI tools for ops staff and as targets for the API service when an admin
# clicks the "Backup & download" button on the Platform Health page.
install -m 0755 "${REPO_DIR}/scripts/anthrimon-backup"     /usr/local/bin/anthrimon-backup
install -m 0755 "${REPO_DIR}/scripts/anthrimon-restore"    /usr/local/bin/anthrimon-restore
install -m 0755 "${REPO_DIR}/scripts/show_suppression.py"  /usr/local/bin/anthrimon-show-suppression
ok "anthrimon-backup / anthrimon-restore / anthrimon-show-suppression installed to /usr/local/bin"

# Staging dir for backups uploaded via the UI.  Owned by the API user so the
# API can write to it; readable by root so the restore CLI (run as root via
# sudo) can pick them up.
install -d -m 0755 -o "${REAL_USER}" -g "${REAL_USER}" /var/lib/anthrimon/uploaded-backups
ok "backup upload staging dir: /var/lib/anthrimon/uploaded-backups"

# Sudoers grant so the API user (running non-interactively) can sudo tar to
# read root-owned files like TLS keys and .env files during a backup.
BACKUP_SUDOERS_DST="/etc/sudoers.d/anthrimon-backup"
sed "s/__API_USER__/${REAL_USER}/g" \
    "${REPO_DIR}/infra/sudoers.d/anthrimon-backup" > "${BACKUP_SUDOERS_DST}"
chmod 440 "${BACKUP_SUDOERS_DST}"
visudo -cf "${BACKUP_SUDOERS_DST}" && ok "sudoers rule written: ${BACKUP_SUDOERS_DST}" \
    || { rm -f "${BACKUP_SUDOERS_DST}"; warn "sudoers syntax check failed — skipping"; }

# ── 16c. Config rollback firewall (device-pulls-from-HTTP) ───────────────────

hdr "Config rollback firewall"

# Config rollback works by spinning up an ephemeral one-shot server on the hub
# bound to the device-facing IP, telling the device "fetch config from this
# URL", and tearing the server down after one request.  The server picks a
# port from this range — open it so devices can reach it.  Most vendors fetch
# over HTTP (TCP); AOS-CX's `copy ... checkpoint` only accepts tftp:// (UDP),
# so both protocols are opened on the same range.
ROLLBACK_PORTS_LOW=5050
ROLLBACK_PORTS_HIGH=5054
ROLLBACK_PORT_RANGE="${ROLLBACK_PORTS_LOW}:${ROLLBACK_PORTS_HIGH}"

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow ${ROLLBACK_PORT_RANGE}/tcp comment "anthrimon config rollback" >/dev/null 2>&1 \
        && ok "ufw rule added: ${ROLLBACK_PORT_RANGE}/tcp" \
        || warn "ufw allow failed — open ${ROLLBACK_PORT_RANGE}/tcp manually if rollback fails to reach devices"
    ufw allow ${ROLLBACK_PORT_RANGE}/udp comment "anthrimon config rollback (tftp)" >/dev/null 2>&1 \
        && ok "ufw rule added: ${ROLLBACK_PORT_RANGE}/udp" \
        || warn "ufw allow failed — open ${ROLLBACK_PORT_RANGE}/udp manually if AOS-CX rollback fails"
elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
    firewall-cmd --permanent --add-port=${ROLLBACK_PORT_RANGE//:/-}/tcp >/dev/null 2>&1 \
        && firewall-cmd --reload >/dev/null 2>&1 \
        && ok "firewalld rule added: ${ROLLBACK_PORT_RANGE//:/-}/tcp" \
        || warn "firewalld add-port failed — open ${ROLLBACK_PORT_RANGE//:/-}/tcp manually"
    firewall-cmd --permanent --add-port=${ROLLBACK_PORT_RANGE//:/-}/udp >/dev/null 2>&1 \
        && firewall-cmd --reload >/dev/null 2>&1 \
        && ok "firewalld rule added: ${ROLLBACK_PORT_RANGE//:/-}/udp" \
        || warn "firewalld add-port failed — open ${ROLLBACK_PORT_RANGE//:/-}/udp manually"
else
    info "No active host firewall detected — rollback port range ${ROLLBACK_PORT_RANGE//:/-} (tcp+udp) left open by default"
fi

# Ensure the port range is also visible to the API process as an env hint.
# (Default in code is 5050-5054 so this is redundant in normal installs, but
# explicit env makes operator overrides easier.)
ROLLBACK_ENV_DROPIN="/etc/systemd/system/anthrimon-api.service.d/rollback-ports.conf"
mkdir -p "$(dirname "${ROLLBACK_ENV_DROPIN}")"
cat > "${ROLLBACK_ENV_DROPIN}" <<EOF
[Service]
Environment="ANTHRIMON_ROLLBACK_PORTS=${ROLLBACK_PORTS_LOW}-${ROLLBACK_PORTS_HIGH}"
EOF
chmod 644 "${ROLLBACK_ENV_DROPIN}"
ok "rollback port range written to ${ROLLBACK_ENV_DROPIN}"

# ── 17. API systemd unit ──────────────────────────────────────────────────────

hdr "Anthrimon API"

# Preserve or generate secrets.
# The service file stores them as:  Environment="KEY=value"
# Strip everything up to and including the = sign, then strip any surrounding quotes.
_extract_env() { grep -oP "(?<=${1}=)[^\"]+" /etc/systemd/system/anthrimon-api.service 2>/dev/null || true; }

if grep -q "ANTHRIMON_ENCRYPTION_KEY" /etc/systemd/system/anthrimon-api.service 2>/dev/null; then
    ENCRYPTION_KEY=$(_extract_env ANTHRIMON_ENCRYPTION_KEY)
    JWT_SECRET=$(_extract_env JWT_SECRET_KEY)
    # Fall back to fresh generation if either value is empty or wrong length
    if [[ ${#ENCRYPTION_KEY} -ne 64 ]]; then
        ENCRYPTION_KEY=$(openssl rand -hex 32)
        warn "Encryption key was missing or malformed — regenerated (existing credentials will need re-saving)"
    fi
    if [[ ${#JWT_SECRET} -lt 32 ]]; then
        JWT_SECRET=$(openssl rand -hex 32)
        warn "JWT secret was missing or too short — regenerated (all sessions will be invalidated)"
    fi
    ok "Secrets preserved (or regenerated where invalid)"
else
    ENCRYPTION_KEY=$(openssl rand -hex 32)
    JWT_SECRET=$(openssl rand -hex 32)
    ok "Generated new encryption and JWT secrets"
fi

cat > /etc/systemd/system/anthrimon-api.service <<EOF
[Unit]
Description=Anthrimon FastAPI backend
After=network.target postgresql.service

[Service]
User=${REAL_USER}
WorkingDirectory=${REPO_DIR}/api
Environment="ANTHRIMON_ENCRYPTION_KEY=${ENCRYPTION_KEY}"
Environment="JWT_SECRET_KEY=${JWT_SECRET}"
Environment="DB_HOST=127.0.0.1"
Environment="DB_USER=${DB_USER}"
Environment="DB_PASSWORD=${DB_PASS}"
Environment="DB_NAME=${DB_NAME}"
ExecStart=${VENV_DIR}/bin/python3 -m uvicorn backend.main:app --host 127.0.0.1 --port ${API_PORT}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# The unit embeds ANTHRIMON_ENCRYPTION_KEY / JWT_SECRET_KEY / DB_PASSWORD as
# Environment= lines. systemd unit files are created world-readable (0644) by
# default, which would let any local user read these secrets. systemd (PID 1)
# reads units as root regardless of mode, so 0600 is safe and closes the leak.
chmod 600 /etc/systemd/system/anthrimon-api.service

systemctl daemon-reload
systemctl enable anthrimon-api
systemctl restart anthrimon-api
ok "anthrimon-api service running"

# ── Licensing ──────────────────────────────────────────────────────────────────
hdr "Licensing"
# The license file lives under the service-owned state dir so Platform Admin
# uploads persist in place without root. Absent = free tier; no key needed to run.
install -d -m 0750 -o "${REAL_USER}" -g "${REAL_USER}" /var/lib/anthrimon
ok "license dir ready: /var/lib/anthrimon (free tier until a license is uploaded)"

# anthrimon-licensing CLI — print this host's fingerprint (to request a license)
# or show current license status. Callable by ops staff from anywhere.
cat > /usr/local/bin/anthrimon-licensing <<EOF
#!/usr/bin/env bash
cd "${API_DIR}" && exec "${VENV_DIR}/bin/python3" -m backend.licensing "\$@"
EOF
chmod 0755 /usr/local/bin/anthrimon-licensing
ok "anthrimon-licensing CLI installed to /usr/local/bin"

# Print this host's license fingerprint so the admin can request a license now.
LIC_FP="$(cd "${API_DIR}" && "${VENV_DIR}/bin/python3" -m backend.licensing --print-machine-id 2>/dev/null || true)"
[[ -n "${LIC_FP}" ]] && ok "License fingerprint for this host: ${LIC_FP}"

# Seed platform settings (base_url; abuseipdb_api_key left blank — set in UI)
info "Setting platform base_url to ${BASE_URL}..."
pg_su -d "${DB_NAME}" -c "
    INSERT INTO system_settings (key, value)
    VALUES ('platform', jsonb_build_object('base_url', '${BASE_URL}', 'abuseipdb_api_key', ''))
    ON CONFLICT (key) DO UPDATE
        SET value = system_settings.value
                    || jsonb_build_object('base_url', '${BASE_URL}');
" 2>/dev/null && ok "Platform base_url set" || warn "Could not set base_url (set it in UI → Settings → Platform)"

# ── Summary ───────────────────────────────────────────────────────────────────

IP=$(hostname -I | awk '{print $1}')
HUB_PUBKEY=$(wg show wg0 public-key 2>/dev/null || echo "(wg0 not up)")

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${GREEN}${BOLD}  Anthrimon is live${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  Dashboard    ${CYAN}${BASE_URL}/${RESET}"
echo -e "  API docs     ${CYAN}${BASE_URL}/api/docs${RESET}"
echo -e "  CA cert      ${BOLD}${TLS_DIR}/ca.crt${RESET}"
echo ""
echo -e "  WireGuard hub:"
echo -e "    Interface  ${CYAN}wg0 @ 10.100.0.1/24${RESET}"
echo -e "    Pubkey     ${CYAN}${HUB_PUBKEY}${RESET}"
echo -e "    Ensure UDP ${BOLD}51820${RESET} is open inbound for remote collectors"
echo ""
echo -e "  Services managed by systemd:"
echo -e "    ${BOLD}systemctl status anthrimon-api${RESET}"
echo -e "    ${BOLD}systemctl status snmp-collector${RESET}"
echo -e "    ${BOLD}systemctl status flow-collector${RESET}"
echo -e "    ${BOLD}systemctl status syslog-collector${RESET}"
echo -e "    ${BOLD}systemctl status snmptrapd${RESET}"
echo -e "    ${BOLD}systemctl status nginx${RESET}"
echo -e "    ${BOLD}systemctl status victoria-metrics${RESET}"
echo -e "    ${BOLD}systemctl status clickhouse-server${RESET}"
echo -e "    ${BOLD}systemctl status postgresql${RESET}"
echo -e "    ${BOLD}systemctl status wg-quick@wg0${RESET}"
echo ""
echo -e "  Flow / syslog export targets:"
echo -e "    NetFlow / IPFIX  ${BOLD}${IP}:${NETFLOW_PORT}${RESET} (UDP)"
echo -e "    sFlow            ${BOLD}${IP}:${SFLOW_PORT}${RESET} (UDP)"
echo -e "    Syslog           ${BOLD}${IP}:514${RESET} (UDP/TCP)"
echo -e "    SNMP traps       ${BOLD}${IP}:162${RESET} (UDP)"
echo ""
echo -e "  Remote collector:"
echo -e "    Collector  ${BOLD}/usr/local/bin/anthrimon-collector${RESET}"
echo -e "    Trap hdlr  ${BOLD}/usr/local/bin/anthrimon-traphandler${RESET}"
echo -e "    Dist dir   ${BOLD}${COLLECTOR_DIST}/${RESET}"
echo -e "    To deploy at a remote site:"
echo -e "      1. Register in UI → Configuration → Collectors → New"
echo -e "      2. Set ANTHRIMON_TOKEN in /etc/anthrimon/collector.env"
echo -e "      3. ${BOLD}systemctl enable --now anthrimon-collector${RESET}"
echo ""
echo -e "  Threat intelligence (optional):"
echo -e "    Add AbuseIPDB API key in UI → Settings → Platform"
echo -e "    Free key at ${CYAN}https://www.abuseipdb.com/register${RESET}"
echo ""
echo -e "  Secrets: ${BOLD}/etc/systemd/system/anthrimon-api.service${RESET}"
echo ""
