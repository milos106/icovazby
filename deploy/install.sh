#!/usr/bin/env bash
# IČO vazby — production install script (Ubuntu 24.04 LTS minimal)
# POZN.: Aktuální produkce běží na Hukot VPS ivz1 (46.36.40.227), ne na Hetzneru.
#        Migrace 2026-06, viz docs/MIGRATION_HUKOT.md. Kroky níže jsou generické
#        pro libovolný čistý Ubuntu 24.04 VPS. Redeploy: deploy/redeploy.sh.
#
# Run as root on čerstvé instanci:
#   curl -fsSL https://raw.githubusercontent.com/milos106/icovazby/main/deploy/install.sh | bash -s your-domain.tld
#
# Co dělá:
#   1. Vytvoří user `icovazby` (no shell, dedicated)
#   2. Instaluje Node 20 LTS, Caddy, ufw, fail2ban, unattended-upgrades
#   3. Naklonuje repo do /opt/icovazby, npm ci && npm run build
#   4. Nastaví systemd service + start
#   5. Caddyfile s TLS (Let's Encrypt auto)
#   6. ufw allow 22/80/443, deny vše ostatní
#   7. Swap 1GB
#   8. sysctl tuning
#
# Po doběhnutí: ssh icovaz@server, edit /opt/icovazby/.env (HLIDAC_API_TOKEN, SMTP_*)

set -euo pipefail

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "Usage: $0 <domain>" >&2
  exit 1
fi

if [[ "$EUID" -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

echo "=== 1/8 Systém update ==="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq

echo "=== 2/8 Základní balíky ==="
apt-get install -y -qq \
  curl ca-certificates gnupg lsb-release \
  ufw fail2ban unattended-upgrades \
  git build-essential

echo "=== 3/8 Node.js 20 LTS ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
apt-get install -y -qq nodejs

echo "=== 4/8 Caddy (reverse proxy + TLS) ==="
curl -fsSL "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
apt-get update -qq
apt-get install -y -qq caddy

echo "=== 5/8 Uživatel icovazby + repo ==="
if ! id icovazby &>/dev/null; then
  useradd --system --create-home --shell /usr/sbin/nologin --home-dir /opt/icovazby icovazby
fi
if [[ ! -d /opt/icovazby/.git ]]; then
  sudo -u icovazby git clone https://github.com/milos106/icovazby.git /opt/icovazby
else
  cd /opt/icovazby && sudo -u icovazby git pull --ff-only
fi
cd /opt/icovazby
sudo -u icovazby npm ci --omit=dev --no-audit --no-fund
sudo -u icovazby npm run build

if [[ ! -f /opt/icovazby/.env ]]; then
  sudo -u icovazby cp /opt/icovazby/.env.example /opt/icovazby/.env
  echo ">> NEZAPOMEŇ doplnit /opt/icovazby/.env (HLIDAC_API_TOKEN, SMTP_*, PUBLIC_BASE_URL)"
fi

# CX11-specific: HOLDING_CONCURRENCY=2, RATE_LIMIT_HEAVY_PER_MIN=5
if ! grep -q "^HOLDING_CONCURRENCY=" /opt/icovazby/.env; then
  echo "HOLDING_CONCURRENCY=2" >> /opt/icovazby/.env
  echo "RATE_LIMIT_HEAVY_PER_MIN=5" >> /opt/icovazby/.env
fi
echo "PUBLIC_BASE_URL=https://${DOMAIN}" >> /opt/icovazby/.env

echo "=== 6/8 systemd service ==="
cat > /etc/systemd/system/icovazby.service <<EOF
[Unit]
Description=IČO vazby (Czech business DD aggregator)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=icovazby
Group=icovazby
WorkingDirectory=/opt/icovazby
EnvironmentFile=/opt/icovazby/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /opt/icovazby/dist/server.js
Restart=on-failure
RestartSec=5
LimitNOFILE=65536
MemoryMax=900M
MemoryHigh=700M
# Sandboxing
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/icovazby/data
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF

mkdir -p /opt/icovazby/data
chown icovazby:icovazby /opt/icovazby/data

systemctl daemon-reload
systemctl enable icovazby
systemctl restart icovazby

echo "=== 7/8 Caddy reverse proxy ==="
cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
    reverse_proxy 127.0.0.1:3000
    encode gzip zstd

    @static path /js/* /css/* /data/* /favicon*
    header @static Cache-Control "public, max-age=86400"

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options nosniff
        Referrer-Policy strict-origin-when-cross-origin
        Permissions-Policy "geolocation=(), microphone=(), camera=()"
        -Server
    }

    log {
        output file /var/log/caddy/access.log {
            roll_size 100mb
            roll_keep 7
        }
        format json
    }
}
EOF

systemctl reload caddy

echo "=== 8/8 Firewall + swap + sysctl ==="
# UFW: nereset-ujem existující rules (mohly by být WireGuard / jiné služby).
# Jen přidáme 80/443 idempotentně a zapneme firewall pokud běží.
if ! ufw status | grep -q "Status: active"; then
  echo " -- ufw nebyl aktivní, zapínám s default deny incoming"
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 22/tcp comment 'SSH'
fi
ufw allow 80/tcp comment 'HTTP (Caddy)' >/dev/null
ufw allow 443/tcp comment 'HTTPS (Caddy)' >/dev/null
ufw --force enable >/dev/null
echo " -- ufw rules po úpravě:"
ufw status numbered | head -20

# Swap 1 GB
if ! swapon --show | grep -q .; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# sysctl tuning — vlastní soubor (nepřebije existující WG / systémové tuning).
cat > /etc/sysctl.d/99-icovazby.conf <<EOF
net.core.somaxconn = 1024
net.ipv4.tcp_tw_reuse = 1
net.ipv4.ip_local_port_range = 10000 65535
fs.file-max = 65536
vm.swappiness = 10
EOF
sysctl -p /etc/sysctl.d/99-icovazby.conf >/dev/null

# fail2ban SSH jail — jen pokud ještě není (nepřemazat existující configy)
if [[ ! -f /etc/fail2ban/jail.d/sshd.conf ]]; then
  cat > /etc/fail2ban/jail.d/sshd.conf <<EOF
[sshd]
enabled = true
maxretry = 3
bantime = 3600
EOF
  systemctl restart fail2ban
fi

# Unattended upgrades
dpkg-reconfigure -plow unattended-upgrades </dev/null >/dev/null 2>&1 || true

echo ""
echo "==========================================="
echo " ✅ INSTALACE HOTOVA"
echo "==========================================="
echo ""
echo " Web:        https://${DOMAIN}"
echo " Status:     systemctl status icovazby"
echo " Log:        journalctl -u icovazby -f"
echo " Caddy log:  tail -f /var/log/caddy/access.log"
echo ""
echo " Doplň token a SMTP do /opt/icovazby/.env, pak:"
echo "    systemctl restart icovazby"
echo ""
echo " Update na novou verzi:"
echo "    cd /opt/icovazby && sudo -u icovazby git pull && sudo -u icovazby npm ci --omit=dev && sudo -u icovazby npm run build && systemctl restart icovazby"
echo ""
