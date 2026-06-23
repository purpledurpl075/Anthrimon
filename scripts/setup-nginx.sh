#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REAL_USER="${SUDO_USER:-$USER}"
REAL_HOME=$(getent passwd "${REAL_USER}" | cut -d: -f6)
DIST_DIR="${REPO_DIR}/frontend/dashboard/dist"
API_SERVICE="/etc/systemd/system/anthrimon-api.service"
NGINX_CONF="/etc/nginx/sites-available/anthrimon"

echo "==> Installing nginx..."
apt-get install -y nginx

echo "==> Writing nginx site config..."
cat > "$NGINX_CONF" << 'NGINX'
# WebSocket upgrade map — `Connection: upgrade` when the client requests an
# Upgrade, `Connection: close` otherwise.  Lets the same /api/ proxy block
# handle both regular HTTP requests and WebSocket upgrades (e.g. /probes/ws).
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80 default_server;
    server_name _;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws:; font-src 'self'" always;

    root DIST_DIR_PLACEHOLDER;
    index index.html;

    # SPA — all non-file routes serve index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Immutable static assets — cache for 1 year
    location ~* \.(?:js|css|woff2?|ttf|eot|svg|png|jpg|ico)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # API proxy → uvicorn
    location /api/ {
        proxy_pass         http://127.0.0.1:8001;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # SSE / long-poll / WebSocket — disable buffering, extend timeout
        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        $connection_upgrade;
        proxy_buffering    off;
        proxy_read_timeout 3600s;

        # Backup upload (Platform Health → Upload backup) can be multi-GiB;
        # match the API's 10 GiB cap, stream through nginx instead of
        # buffering, and give slow uploads up to an hour.
        client_max_body_size      10G;
        proxy_request_buffering   off;
        proxy_send_timeout        3600s;
    }
}
NGINX

# Replace placeholder with actual dist directory
sed -i "s|DIST_DIR_PLACEHOLDER|${DIST_DIR}|" "$NGINX_CONF"

echo "==> Enabling site and removing default..."
ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/anthrimon
rm -f /etc/nginx/sites-enabled/default

echo "==> Setting dist directory permissions for nginx..."
chmod o+x "${REAL_HOME}" \
           "${REPO_DIR}" \
           "${REPO_DIR}/frontend" \
           "${REPO_DIR}/frontend/dashboard" \
           "$DIST_DIR"

echo "==> Testing nginx config..."
nginx -t

echo "==> Enabling and starting nginx..."
systemctl enable --now nginx

echo "==> Locking uvicorn to localhost..."
sed -i 's/--host 0\.0\.0\.0/--host 127.0.0.1/' "$API_SERVICE"
systemctl daemon-reload
systemctl restart anthrimon-api

echo ""
echo "Done. Anthrimon is now at http://$(hostname -I | awk '{print $1}')/"
