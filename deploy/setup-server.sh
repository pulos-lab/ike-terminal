#!/bin/bash
# One-time VPS setup script for TIX Terminal
# Run as root on fresh Ubuntu 24.04 Hetzner VPS
set -euo pipefail

echo "=== Creating app user ==="
adduser --disabled-password --gecos "" ike-terminal || true

echo "=== Installing Node.js 22 LTS ==="
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs build-essential sqlite3

echo "=== Installing Caddy ==="
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

echo "=== Creating directories ==="
mkdir -p /opt/ike-terminal/{app,data,backups}
chown -R ike-terminal: /opt/ike-terminal

echo "=== Setting up firewall ==="
ufw allow 22/tcp   # SSH
ufw allow 80/tcp   # HTTP (Caddy redirect)
ufw allow 443/tcp  # HTTPS (Caddy)
ufw --force enable

echo "=== Installing systemd service ==="
cp /opt/ike-terminal/app/deploy/ike-terminal.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable ike-terminal

echo "=== Installing Caddyfile ==="
cp /opt/ike-terminal/app/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl restart caddy

echo "=== Installing backup cron ==="
cp /opt/ike-terminal/app/deploy/backup.sh /opt/ike-terminal/backup.sh
chmod +x /opt/ike-terminal/backup.sh
echo "0 3 * * * /opt/ike-terminal/backup.sh >> /opt/ike-terminal/backups/cron.log 2>&1" | crontab -u ike-terminal -

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Next steps:"
echo "1. Create /opt/ike-terminal/.env (copy from .env.example)"
echo "   - Generate AUTH_SECRET: openssl rand -base64 32"
echo "   - Add Google OAuth credentials (optional)"
echo "2. Run deploy.sh to push the app"
echo "3. Set DNS A record: tixterminal.app → $(curl -s ifconfig.me)"
echo ""
