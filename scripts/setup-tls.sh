#!/bin/bash
# Generate self-signed CA + hub server certificate for Anthrimon.
# The CA cert is what collectors and browsers need to trust the hub.
#
# Outputs:
#   /etc/anthrimon/tls/ca.crt          — CA certificate (distribute to collectors)
#   /etc/anthrimon/tls/ca.key          — CA private key  (keep on hub only)
#   /etc/anthrimon/tls/server.crt      — Hub TLS certificate (nginx)
#   /etc/anthrimon/tls/server.key      — Hub TLS private key  (nginx)
#
# Usage: sudo bash scripts/setup-tls.sh

set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run with sudo"; exit 1; }

HUB_IP=$(hostname -I | awk '{print $1}')
HUB_HOST=$(hostname)
TLS_DIR=/etc/anthrimon/tls

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
ok()   { echo -e "  ${GREEN}✔${RESET}  $*"; }
info() { echo -e "  ${CYAN}→${RESET}  $*"; }

echo -e "\n${BOLD}━━━  Anthrimon TLS setup  ━━━${RESET}"
info "Hub IP:   $HUB_IP"
info "Hostname: $HUB_HOST"
info "Output:   $TLS_DIR"

mkdir -p "$TLS_DIR"
# Private keys stay root-only (set per-file below).
# The directory itself must be traversable by the API process (runs as non-root)
# so it can read ca.crt to bundle into collector deployment packages.
chmod 755 "$TLS_DIR"

# ── 1. Certificate Authority ──────────────────────────────────────────────────
if [[ -f "$TLS_DIR/ca.crt" ]]; then
    ok "CA already exists at $TLS_DIR/ca.crt — skipping generation"
else
    info "Generating CA key (EC P-384)..."
    openssl ecparam -name secp384r1 -genkey -noout -out "$TLS_DIR/ca.key"
    chmod 600 "$TLS_DIR/ca.key"

    info "Generating CA certificate (10-year validity)..."
    openssl req -new -x509 -days 3650 \
        -key "$TLS_DIR/ca.key" \
        -out "$TLS_DIR/ca.crt" \
        -subj "/CN=Anthrimon CA/O=Anthrimon/C=US"
    # CA cert is public — readable by the API user for collector package bundling
    chmod 644 "$TLS_DIR/ca.crt"
    ok "CA certificate generated"
fi

# Ensure ca.crt is readable even if this script is re-run on an existing install
chmod 644 "$TLS_DIR/ca.crt" 2>/dev/null || true

# ── 2. Server certificate ─────────────────────────────────────────────────────
info "Generating server key (EC P-384)..."
openssl ecparam -name secp384r1 -genkey -noout -out "$TLS_DIR/server.key"
chmod 600 "$TLS_DIR/server.key"

info "Generating server CSR..."
openssl req -new \
    -key "$TLS_DIR/server.key" \
    -out "$TLS_DIR/server.csr" \
    -subj "/CN=$HUB_HOST/O=Anthrimon/C=US"

info "Signing server certificate (2-year validity) with SANs..."
cat > "$TLS_DIR/server.ext" <<EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=@alt_names

[alt_names]
IP.1 = $HUB_IP
IP.2 = 127.0.0.1
IP.3 = 10.100.0.1
DNS.1 = $HUB_HOST
DNS.2 = localhost
EOF

openssl x509 -req -days 730 \
    -in  "$TLS_DIR/server.csr" \
    -CA  "$TLS_DIR/ca.crt" \
    -CAkey "$TLS_DIR/ca.key" \
    -CAcreateserial \
    -extfile "$TLS_DIR/server.ext" \
    -out "$TLS_DIR/server.crt"

rm -f "$TLS_DIR/server.csr" "$TLS_DIR/server.ext"
ok "Server certificate generated and signed"

# ── 3. Verify ─────────────────────────────────────────────────────────────────
info "Verifying certificate chain..."
openssl verify -CAfile "$TLS_DIR/ca.crt" "$TLS_DIR/server.crt"
EXPIRY=$(openssl x509 -noout -enddate -in "$TLS_DIR/server.crt" | cut -d= -f2)
ok "Certificate valid until: $EXPIRY"
FINGERPRINT=$(openssl x509 -noout -fingerprint -sha256 -in "$TLS_DIR/server.crt" | cut -d= -f2)
ok "Server cert SHA-256: $FINGERPRINT"

# ── 4. Update nginx ───────────────────────────────────────────────────────────
info "Writing nginx HTTPS config..."

FRONTEND_ROOT=$(grep -oP '(?<=root ).*(?=;)' /etc/nginx/sites-available/anthrimon 2>/dev/null || echo "/home/poly/Anthri-mon/frontend/dashboard/dist")

cat > /etc/nginx/sites-available/anthrimon <<NGINX
# Redirect HTTP → HTTPS
server {
    listen 80 default_server;
    server_name _;
    return 301 https://\$host\$request_uri;
}

# HTTPS
server {
    listen 443 ssl default_server;
    server_name _;

    ssl_certificate     $TLS_DIR/server.crt;
    ssl_certificate_key $TLS_DIR/server.key;

    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
    ssl_prefer_server_ciphers on;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss:; font-src 'self'" always;

    root $FRONTEND_ROOT;
    index index.html;

    # SPA routing
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # Immutable static assets
    location ~* \\.(?:js|css|woff2?|ttf|eot|svg|png|jpg|ico)\$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # API proxy → uvicorn
    location /api/ {
        proxy_pass         http://127.0.0.1:8001;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_set_header   Connection        '';
        proxy_buffering    off;
        proxy_read_timeout 3600s;
    }
}
NGINX

nginx -t
systemctl reload nginx
ok "nginx reloaded with HTTPS"

# ── 5. Summary ────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${GREEN}${BOLD}  TLS setup complete${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  Dashboard    ${CYAN}https://$HUB_IP/${RESET}"
echo -e "  CA cert      ${BOLD}$TLS_DIR/ca.crt${RESET}"
echo -e "               (copy this to remote collectors)"
echo ""
echo -e "  Add CA to your browser/OS to remove the warning:"
echo -e "    ${BOLD}scp poly@$HUB_IP:$TLS_DIR/ca.crt ~/anthrimon-ca.crt${RESET}"
echo ""
echo -e "  Renew server cert (run again in ~2 years):"
echo -e "    ${BOLD}sudo bash scripts/setup-tls.sh${RESET}"
echo ""
