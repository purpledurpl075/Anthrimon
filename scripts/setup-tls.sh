#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Anthrimon TLS Setup
#
# Three modes:
#   --mode self-signed    Generate a private CA + server cert (default)
#   --mode letsencrypt    Use certbot for a free trusted certificate
#   --mode custom         Use your own cert + key files
#
# Usage:
#   sudo bash scripts/setup-tls.sh                                    # self-signed
#   sudo bash scripts/setup-tls.sh --mode letsencrypt --domain nms.acme.com --email admin@acme.com
#   sudo bash scripts/setup-tls.sh --mode custom --cert /path/to.crt --key /path/to.key
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run with sudo"; exit 1; }

# ── Parse args ───────────────────────────────────────────────────────────────
MODE="self-signed"
DOMAIN=""
EMAIL=""
CUSTOM_CERT=""
CUSTOM_KEY=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --mode)       MODE="$2";       shift 2 ;;
        --domain)     DOMAIN="$2";     shift 2 ;;
        --email)      EMAIL="$2";      shift 2 ;;
        --cert)       CUSTOM_CERT="$2"; shift 2 ;;
        --key)        CUSTOM_KEY="$2";  shift 2 ;;
        *)            shift ;;
    esac
done

# ── Common vars ──────────────────────────────────────────────────────────────
HUB_IP=$(hostname -I | awk '{print $1}')
HUB_HOST=$(hostname)
TLS_DIR=/etc/anthrimon/tls
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'
BOLD='\033[1m'; RESET='\033[0m'
ok()   { echo -e "  ${GREEN}✔${RESET}  $*"; }
info() { echo -e "  ${CYAN}→${RESET}  $*"; }
warn() { echo -e "  ${YELLOW}⚠${RESET}  $*"; }
die()  { echo -e "  ${RED}✘${RESET}  $*"; exit 1; }

echo -e "\n${BOLD}━━━  Anthrimon TLS setup  ━━━${RESET}"
info "Mode:     $MODE"
info "Hub IP:   $HUB_IP"
info "Hostname: $HUB_HOST"

mkdir -p "$TLS_DIR"
chmod 755 "$TLS_DIR"

# ══════════════════════════════════════════════════════════════════════════════
# MODE 1: Self-signed CA
# ══════════════════════════════════════════════════════════════════════════════
if [[ "$MODE" == "self-signed" ]]; then

    # ── CA ────────────────────────────────────────────────────────────────
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
        chmod 644 "$TLS_DIR/ca.crt"
        ok "CA certificate generated"
    fi
    chmod 644 "$TLS_DIR/ca.crt" 2>/dev/null || true

    # ── Server cert ───────────────────────────────────────────────────────
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

    info "Verifying certificate chain..."
    openssl verify -CAfile "$TLS_DIR/ca.crt" "$TLS_DIR/server.crt"
    EXPIRY=$(openssl x509 -noout -enddate -in "$TLS_DIR/server.crt" | cut -d= -f2)
    ok "Server certificate valid until: $EXPIRY"

    CERT_PATH="$TLS_DIR/server.crt"
    KEY_PATH="$TLS_DIR/server.key"

# ══════════════════════════════════════════════════════════════════════════════
# MODE 2: Let's Encrypt
# ══════════════════════════════════════════════════════════════════════════════
elif [[ "$MODE" == "letsencrypt" ]]; then

    [[ -n "$DOMAIN" ]] || die "Let's Encrypt requires --domain"

    # Install certbot
    if ! command -v certbot &>/dev/null; then
        info "Installing certbot..."
        apt-get update -qq
        apt-get install -y -qq certbot python3-certbot-nginx
        ok "certbot installed"
    else
        ok "certbot already installed"
    fi

    # Stop nginx temporarily so certbot can bind to :80 (standalone mode)
    # or use nginx plugin if nginx is running
    EMAIL_FLAG=""
    if [[ -n "$EMAIL" ]]; then
        EMAIL_FLAG="--email $EMAIL"
    else
        EMAIL_FLAG="--register-unsafely-without-email"
    fi

    info "Requesting certificate for ${DOMAIN}..."
    certbot certonly --nginx \
        --non-interactive \
        --agree-tos \
        $EMAIL_FLAG \
        -d "$DOMAIN" \
        || die "certbot failed — ensure ${DOMAIN} resolves to this server and port 80 is reachable"

    CERT_PATH="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
    KEY_PATH="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"

    ok "Let's Encrypt certificate issued for ${DOMAIN}"

    EXPIRY=$(openssl x509 -noout -enddate -in "$CERT_PATH" | cut -d= -f2)
    ok "Certificate valid until: $EXPIRY"

    # Enable auto-renewal timer
    systemctl enable --now certbot.timer 2>/dev/null || true
    ok "Auto-renewal enabled (certbot.timer)"

    # Create a deploy hook so nginx reloads after renewal
    mkdir -p /etc/letsencrypt/renewal-hooks/deploy
    cat > /etc/letsencrypt/renewal-hooks/deploy/anthrimon-reload.sh <<'HOOK'
#!/bin/bash
systemctl reload nginx
HOOK
    chmod +x /etc/letsencrypt/renewal-hooks/deploy/anthrimon-reload.sh
    ok "Post-renewal nginx reload hook installed"

    # Also generate the self-signed CA for collector TOFU (collectors still
    # need a CA cert to trust the hub's WireGuard control server)
    if [[ ! -f "$TLS_DIR/ca.crt" ]]; then
        info "Generating internal CA for collector trust..."
        openssl ecparam -name secp384r1 -genkey -noout -out "$TLS_DIR/ca.key"
        chmod 600 "$TLS_DIR/ca.key"
        openssl req -new -x509 -days 3650 \
            -key "$TLS_DIR/ca.key" \
            -out "$TLS_DIR/ca.crt" \
            -subj "/CN=Anthrimon CA/O=Anthrimon/C=US"
        chmod 644 "$TLS_DIR/ca.crt"
        ok "Internal CA generated (for collector trust)"
    fi

# ══════════════════════════════════════════════════════════════════════════════
# MODE 3: Custom (BYOD)
# ══════════════════════════════════════════════════════════════════════════════
elif [[ "$MODE" == "custom" ]]; then

    [[ -n "$CUSTOM_CERT" ]] || die "Custom mode requires --cert"
    [[ -n "$CUSTOM_KEY"  ]] || die "Custom mode requires --key"
    [[ -f "$CUSTOM_CERT" ]] || die "Certificate file not found: $CUSTOM_CERT"
    [[ -f "$CUSTOM_KEY"  ]] || die "Key file not found: $CUSTOM_KEY"

    info "Copying certificate files to $TLS_DIR..."
    cp "$CUSTOM_CERT" "$TLS_DIR/server.crt"
    cp "$CUSTOM_KEY"  "$TLS_DIR/server.key"
    chmod 644 "$TLS_DIR/server.crt"
    chmod 600 "$TLS_DIR/server.key"

    # Verify the cert and key match
    CERT_MOD=$(openssl x509 -noout -modulus -in "$TLS_DIR/server.crt" 2>/dev/null | md5sum)
    KEY_MOD=$(openssl rsa -noout -modulus -in "$TLS_DIR/server.key" 2>/dev/null | md5sum || \
              openssl ec -noout -text -in "$TLS_DIR/server.key" 2>/dev/null | md5sum)
    if [[ "$CERT_MOD" != "$KEY_MOD" ]]; then
        warn "Certificate and key may not match — verify your files"
    else
        ok "Certificate and key match"
    fi

    EXPIRY=$(openssl x509 -noout -enddate -in "$TLS_DIR/server.crt" | cut -d= -f2)
    ok "Certificate valid until: $EXPIRY"

    CERT_PATH="$TLS_DIR/server.crt"
    KEY_PATH="$TLS_DIR/server.key"

    # Generate internal CA for collector trust if not present
    if [[ ! -f "$TLS_DIR/ca.crt" ]]; then
        info "Generating internal CA for collector trust..."
        openssl ecparam -name secp384r1 -genkey -noout -out "$TLS_DIR/ca.key"
        chmod 600 "$TLS_DIR/ca.key"
        openssl req -new -x509 -days 3650 \
            -key "$TLS_DIR/ca.key" \
            -out "$TLS_DIR/ca.crt" \
            -subj "/CN=Anthrimon CA/O=Anthrimon/C=US"
        chmod 644 "$TLS_DIR/ca.crt"
        ok "Internal CA generated (for collector trust)"
    fi

else
    die "Unknown TLS mode: $MODE (expected: self-signed, letsencrypt, custom)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# Write nginx config (common to all modes)
# ══════════════════════════════════════════════════════════════════════════════
info "Writing nginx HTTPS config..."

FRONTEND_ROOT=$(grep -oP '(?<=root ).*(?=;)' /etc/nginx/sites-available/anthrimon 2>/dev/null || echo "${_REPO_DIR}/frontend/dashboard/dist")

# For Let's Encrypt with a domain, set server_name
SERVER_NAME="_"
if [[ "$MODE" == "letsencrypt" && -n "$DOMAIN" ]]; then
    SERVER_NAME="$DOMAIN"
fi

cat > /etc/nginx/sites-available/anthrimon <<NGINX
map \$http_upgrade \$connection_upgrade {
    default upgrade;
    ''      close;
}

# Redirect HTTP → HTTPS
server {
    listen 80 default_server;
    server_name _;
    return 301 https://\$host\$request_uri;
}

# HTTPS
server {
    listen 443 ssl default_server;
    server_name ${SERVER_NAME};

    ssl_certificate     ${CERT_PATH};
    ssl_certificate_key ${KEY_PATH};

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
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        \$connection_upgrade;
        proxy_buffering    off;
        proxy_read_timeout 3600s;
        client_max_body_size    10G;
        proxy_request_buffering off;
        proxy_send_timeout      3600s;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/anthrimon /etc/nginx/sites-enabled/anthrimon
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl reload nginx
ok "nginx reloaded with HTTPS"

# ══════════════════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${GREEN}${BOLD}  TLS setup complete${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"

if [[ "$MODE" == "self-signed" ]]; then
    echo -e "  Dashboard    ${CYAN}https://$HUB_IP/${RESET}"
    echo -e "  CA cert      ${BOLD}$TLS_DIR/ca.crt${RESET}"
    echo -e "               (copy this to remote collectors)"
    echo ""
    echo -e "  Add CA to your browser/OS to remove the warning:"
    echo -e "    ${BOLD}scp $(whoami)@$HUB_IP:$TLS_DIR/ca.crt ~/anthrimon-ca.crt${RESET}"
    echo ""
    echo -e "  Renew server cert (run again in ~2 years):"
    echo -e "    ${BOLD}sudo bash scripts/setup-tls.sh --mode self-signed${RESET}"

elif [[ "$MODE" == "letsencrypt" ]]; then
    echo -e "  Dashboard    ${CYAN}https://${DOMAIN}/${RESET}"
    echo -e "  Certificate  Let's Encrypt — auto-renews via certbot.timer"
    echo ""
    echo -e "  Manual renewal:  ${BOLD}sudo certbot renew${RESET}"
    echo -e "  Check status:    ${BOLD}sudo certbot certificates${RESET}"

elif [[ "$MODE" == "custom" ]]; then
    echo -e "  Dashboard    ${CYAN}https://$HUB_IP/${RESET}"
    echo -e "  Certificate  ${BOLD}$TLS_DIR/server.crt${RESET}"
    echo -e "  Private key  ${BOLD}$TLS_DIR/server.key${RESET}"
    echo ""
    echo -e "  To update your certificate:"
    echo -e "    ${BOLD}sudo bash scripts/setup-tls.sh --mode custom --cert /new/path.crt --key /new/path.key${RESET}"
fi

echo ""
