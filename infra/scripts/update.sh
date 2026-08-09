#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Anthrimon Update Script
#
# Pulls latest code, stops all services, rebuilds everything (Python deps,
# Go collectors, frontend), applies new migrations, and restarts services.
#
# Usage:  sudo bash infra/scripts/update.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Colors / helpers ─────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'
BOLD='\033[1m'; RESET='\033[0m'
ok()   { echo -e "  ${GREEN}✔${RESET}  $1"; }
info() { echo -e "  ${CYAN}→${RESET}  $1"; }
warn() { echo -e "  ${YELLOW}⚠${RESET}  $1"; }
die()  { echo -e "  ${RED}✘${RESET}  $1"; exit 1; }
hdr()  { echo -e "\n${BOLD}━━━  $1  ━━━${RESET}"; }

# ── Paths ────────────────────────────────────────────────────────────────────
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REAL_USER="${SUDO_USER:-$USER}"

API_DIR="${REPO_DIR}/api"
VENV_DIR="${API_DIR}/.venv"
FRONTEND_DIR="${REPO_DIR}/frontend/dashboard"

SNMP_DIR="${REPO_DIR}/collectors/snmp"
FLOW_DIR="${REPO_DIR}/collectors/flow"
SYSLOG_DIR="${REPO_DIR}/collectors/syslog"
REMOTE_DIR="${REPO_DIR}/collectors/remote"
COLLECTOR_DIST="/var/lib/anthrimon/downloads"

SNMP_BIN="/usr/local/bin/anthrimon-snmp-collector"
FLOW_BIN="/usr/local/bin/anthrimon-flow-collector"
SYSLOG_BIN="/usr/local/bin/anthrimon-syslog-collector"

DB_NAME="anthrimon"
PG_MIGRATIONS="${REPO_DIR}/storage/migrations/postgres"
CH_MIGRATIONS="${REPO_DIR}/storage/migrations/clickhouse"

export PATH="$PATH:/usr/local/go/bin"

# ── Require root ─────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    die "This script must be run as root (sudo)"
fi

echo ""
echo -e "  ${BOLD}Anthrimon Update${RESET}"
echo -e "  ${CYAN}Repository:${RESET} ${REPO_DIR}"
echo -e "  ${CYAN}User:${RESET}       ${REAL_USER}"
echo ""

ERRORS=0

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 1: Pull latest code
# ══════════════════════════════════════════════════════════════════════════════
# Runs before anything is stopped — if this fails (diverged branch, network),
# we bail out with services still running instead of causing downtime for a
# no-op update.

hdr "Pulling latest code"

if [[ ! -d "${REPO_DIR}/.git" ]]; then
    warn "${REPO_DIR} is not a git checkout — skipping pull"
else
    if ! sudo -u "${REAL_USER}" git -C "${REPO_DIR}" diff --quiet -- \
        || ! sudo -u "${REAL_USER}" git -C "${REPO_DIR}" diff --cached --quiet --; then
        die "Uncommitted local changes in ${REPO_DIR} — commit or stash them first, then re-run"
    fi
    BEFORE_REV=$(sudo -u "${REAL_USER}" git -C "${REPO_DIR}" rev-parse --short HEAD)
    sudo -u "${REAL_USER}" git -C "${REPO_DIR}" fetch --quiet
    if ! sudo -u "${REAL_USER}" git -C "${REPO_DIR}" pull --ff-only --quiet; then
        die "git pull --ff-only failed — local branch has diverged from upstream; resolve manually and re-run"
    fi
    AFTER_REV=$(sudo -u "${REAL_USER}" git -C "${REPO_DIR}" rev-parse --short HEAD)
    if [[ "${BEFORE_REV}" == "${AFTER_REV}" ]]; then
        ok "Already up to date (${AFTER_REV})"
    else
        ok "Updated ${BEFORE_REV} → ${AFTER_REV}"
    fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 2: Stop all services
# ══════════════════════════════════════════════════════════════════════════════

hdr "Stopping services"

SERVICES=(anthrimon-api snmp-collector flow-collector syslog-collector snmptrapd)

for svc in "${SERVICES[@]}"; do
    if systemctl is-active --quiet "$svc" 2>/dev/null; then
        systemctl stop "$svc"
        ok "Stopped $svc"
    else
        info "$svc not running — skipping"
    fi
done

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 3: Update Python dependencies
# ══════════════════════════════════════════════════════════════════════════════

hdr "Python dependencies"

if [[ -d "${VENV_DIR}" ]]; then
    info "Upgrading pip + requirements..."
    sudo -u "${REAL_USER}" "${VENV_DIR}/bin/pip" install --quiet --upgrade pip
    sudo -u "${REAL_USER}" "${VENV_DIR}/bin/pip" install --quiet \
        -r "${API_DIR}/backend/requirements.txt"
    ok "Python dependencies updated"
else
    warn "Virtualenv not found at ${VENV_DIR} — run install.sh first"
    ERRORS=$((ERRORS + 1))
fi

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 4: Database migrations
# ══════════════════════════════════════════════════════════════════════════════

hdr "PostgreSQL migrations"

pg_su() { sudo -u postgres psql "$@"; }
_sql_esc() { printf '%s' "$1" | sed "s/'/''/g"; }

NEW_MIGRATIONS=0
for f in "${PG_MIGRATIONS}"/*.sql; do
    [[ -f "$f" ]] || continue
    fname=$(basename "$f")
    if pg_su -d "${DB_NAME}" -tAc \
        "SELECT 1 FROM schema_migrations WHERE filename='$(_sql_esc "${fname}")'" 2>/dev/null | grep -q 1; then
        continue
    else
        info "Applying ${fname}..."
        pg_su -d "${DB_NAME}" < "$f"
        pg_su -d "${DB_NAME}" -c \
            "INSERT INTO schema_migrations(filename) VALUES ('$(_sql_esc "${fname}")');"
        ok "${fname} — applied"
        NEW_MIGRATIONS=$((NEW_MIGRATIONS + 1))
    fi
done

if [[ $NEW_MIGRATIONS -eq 0 ]]; then
    ok "No new PostgreSQL migrations"
else
    ok "${NEW_MIGRATIONS} migration(s) applied"
    # Re-grant privileges after new migrations
    pg_su -d "${DB_NAME}" -c "
        GRANT ALL PRIVILEGES ON ALL TABLES    IN SCHEMA public TO anthrimon;
        GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO anthrimon;
        GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO anthrimon;
    " 2>/dev/null || true
fi

hdr "ClickHouse migrations"

for f in "${CH_MIGRATIONS}"/*.sql; do
    [[ -f "$f" ]] || continue
    fname=$(basename "$f")
    info "${fname}..."
    clickhouse-client --multiquery < "$f" 2>/dev/null
    ok "${fname} applied (or already exists)"
done

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 5: Rebuild Go collectors
# ══════════════════════════════════════════════════════════════════════════════

hdr "Go collectors"

# SNMP collector
info "Building snmp-collector..."
if sudo -u "${REAL_USER}" bash -c \
    "cd '${SNMP_DIR}' && /usr/local/go/bin/go build -o /tmp/snmp-collector-build ./cmd/snmp-collector/" 2>&1; then
    install -m 755 /tmp/snmp-collector-build "${SNMP_BIN}"
    rm -f /tmp/snmp-collector-build
    ok "snmp-collector rebuilt"
else
    warn "snmp-collector build failed"
    ERRORS=$((ERRORS + 1))
fi

# Flow collector
info "Building flow-collector..."
if sudo -u "${REAL_USER}" bash -c \
    "cd '${FLOW_DIR}' && /usr/local/go/bin/go build -o /tmp/flow-collector-build ./cmd/flow-collector/" 2>&1; then
    install -m 755 /tmp/flow-collector-build "${FLOW_BIN}"
    rm -f /tmp/flow-collector-build
    ok "flow-collector rebuilt"
else
    warn "flow-collector build failed"
    ERRORS=$((ERRORS + 1))
fi

# Syslog collector
info "Building syslog-collector..."
if sudo -u "${REAL_USER}" bash -c \
    "cd '${SYSLOG_DIR}' && /usr/local/go/bin/go build -o /tmp/syslog-collector-build ./cmd/syslog-collector/" 2>&1; then
    install -m 755 /tmp/syslog-collector-build "${SYSLOG_BIN}"
    rm -f /tmp/syslog-collector-build
    ok "syslog-collector rebuilt"
else
    warn "syslog-collector build failed"
    ERRORS=$((ERRORS + 1))
fi

# Remote collector + trap handler (cross-compiled for distribution)
info "Building remote-collector (amd64 + arm64)..."
BUILD_OK=true
for ARCH in amd64 arm64; do
    if sudo -u "${REAL_USER}" bash -c \
        "cd '${REMOTE_DIR}' && GOOS=linux GOARCH=${ARCH} CGO_ENABLED=0 \
         /usr/local/go/bin/go build -trimpath -ldflags='-s -w' \
         -o /tmp/anthrimon-remote-collector-linux-${ARCH} ./cmd/remote-collector/" 2>&1; then
        install -m 755 "/tmp/anthrimon-remote-collector-linux-${ARCH}" "${COLLECTOR_DIST}/anthrimon-remote-collector-linux-${ARCH}"
        rm -f "/tmp/anthrimon-remote-collector-linux-${ARCH}"
    else
        warn "remote-collector (${ARCH}) build failed"
        BUILD_OK=false
        ERRORS=$((ERRORS + 1))
    fi
done
# Also install amd64 as the local collector binary
if [[ -f "${COLLECTOR_DIST}/anthrimon-remote-collector-linux-amd64" ]]; then
    install -m 755 "${COLLECTOR_DIST}/anthrimon-remote-collector-linux-amd64" /usr/local/bin/anthrimon-collector
fi

info "Building trap-handler (amd64 + arm64)..."
for ARCH in amd64 arm64; do
    if sudo -u "${REAL_USER}" bash -c \
        "cd '${REMOTE_DIR}' && GOOS=linux GOARCH=${ARCH} CGO_ENABLED=0 \
         /usr/local/go/bin/go build -trimpath -ldflags='-s -w' \
         -o /tmp/anthrimon-trap-handler-linux-${ARCH} ./cmd/trap-receiver/" 2>&1; then
        install -m 755 "/tmp/anthrimon-trap-handler-linux-${ARCH}" "${COLLECTOR_DIST}/anthrimon-trap-handler-linux-${ARCH}"
        rm -f "/tmp/anthrimon-trap-handler-linux-${ARCH}"
    else
        warn "trap-handler (${ARCH}) build failed"
        ERRORS=$((ERRORS + 1))
    fi
done
# Install local amd64 trap handler
if [[ -f "${COLLECTOR_DIST}/anthrimon-trap-handler-linux-amd64" ]]; then
    install -m 755 "${COLLECTOR_DIST}/anthrimon-trap-handler-linux-amd64" /usr/local/bin/anthrimon-traphandler
fi

if [[ "$BUILD_OK" == true ]]; then
    ok "All collector binaries rebuilt"
fi

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 6: Rebuild frontend
# ══════════════════════════════════════════════════════════════════════════════

hdr "Frontend"

info "Installing npm dependencies..."
sudo -u "${REAL_USER}" bash -c "cd '${FRONTEND_DIR}' && npm install --silent" 2>&1

info "Building production bundle..."
if sudo -u "${REAL_USER}" bash -c "cd '${FRONTEND_DIR}' && npm run build" 2>&1; then
    ok "Frontend built to ${FRONTEND_DIR}/dist"
else
    warn "Frontend build failed"
    ERRORS=$((ERRORS + 1))
fi

# ══════════════════════════════════════════════════════════════════════════════
# PHASE 7: Restart services (only if no errors)
# ══════════════════════════════════════════════════════════════════════════════

hdr "Starting services"

if [[ $ERRORS -gt 0 ]]; then
    warn "${ERRORS} error(s) during build — services NOT restarted"
    warn "Fix the errors above and re-run, or start services manually"
    echo ""
    for svc in "${SERVICES[@]}"; do
        echo -e "    sudo systemctl start ${svc}"
    done
    echo ""
    exit 1
fi

systemctl daemon-reload

for svc in "${SERVICES[@]}"; do
    if systemctl is-enabled --quiet "$svc" 2>/dev/null; then
        systemctl start "$svc"
        ok "Started $svc"
    else
        info "$svc not enabled — skipping"
    fi
done

# Reload nginx in case frontend changed
nginx -t 2>/dev/null && systemctl reload nginx
ok "nginx reloaded"

# ══════════════════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════════════════

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  ${GREEN}${BOLD}Update complete${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "  Migrations:  ${NEW_MIGRATIONS} new"
echo -e "  Errors:      ${ERRORS}"
echo ""
echo -e "  ${CYAN}Verify:${RESET}"
for svc in "${SERVICES[@]}"; do
    echo -e "    systemctl status ${svc}"
done
echo ""
