#!/usr/bin/env bash
# Builds/installs the latest nginx via VirtuBox's nginx-ee
# (https://github.com/VirtuBox/nginx-ee) — source compile with a minimal
# module set (default + brotli; no naxsi/rtmp/redis/memcached, no
# --libressl/HTTP-3 — not needed for a plain reverse-proxy-to-uvicorn +
# static-SPA setup). Shared by infra/scripts/install.sh and the standalone
# scripts/setup-nginx.sh so both paths get the same treatment.
#
# Always tracks nginx-ee's master branch (no commit pin, by design — see
# WIKI.md) fetched directly from raw.githubusercontent.com rather than the
# README's vtb.cx shortener (same content, one fewer opaque redirect hop).
#
# nginx-ee has no idempotency of its own (every invocation is a full
# multi-minute recompile) and doesn't touch/hold the distro nginx package on
# a vanilla server, so both are handled here:
#   - skip entirely if nginx already exists and isn't the apt package
#     (i.e. nginx-ee already built it in a previous run)
#   - if the apt nginx package IS installed (fresh box, or an existing
#     install predating this change), cleanly remove it first (not purge —
#     leaves /etc/nginx in place) so the compile doesn't land on top of
#     files dpkg still thinks it owns
#   - apt-mark hold nginx afterward so a later `apt upgrade`/install can't
#     silently reintroduce the distro package over the compiled binary
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

ok()   { echo -e "  ${GREEN}✔${RESET}  $*"; }
info() { echo -e "  ${CYAN}→${RESET}  $*"; }
warn() { echo -e "  ${YELLOW}!${RESET}  $*"; }
err()  { echo -e "  ${RED}✘${RESET}  $*" >&2; }
die()  { err "$*"; exit 1; }

[[ $EUID -eq 0 ]] || die "install-nginx-ee.sh must be run as root"

if command -v nginx >/dev/null 2>&1 && ! dpkg -l nginx 2>/dev/null | grep -q '^ii'; then
    ok "nginx already installed via nginx-ee ($(nginx -v 2>&1 | sed 's/^nginx version: //')) — skipping rebuild"
    exit 0
fi

if dpkg -l nginx 2>/dev/null | grep -q '^ii'; then
    info "Removing apt-managed nginx package (keeping /etc/nginx)..."
    systemctl stop nginx 2>/dev/null || true
    apt-get remove -y nginx
    ok "apt nginx package removed"
fi

info "Building nginx via nginx-ee (this takes a few minutes)..."
bash <(curl -fsSL https://raw.githubusercontent.com/VirtuBox/nginx-ee/master/nginx-build.sh) --stable
ok "nginx-ee build complete: $(nginx -v 2>&1 | sed 's/^nginx version: //')"

apt-mark hold nginx >/dev/null 2>&1 || true
ok "nginx package name held — apt upgrade/install can't override the compiled binary"
