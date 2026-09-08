#!/usr/bin/env bash
# Развёртывание свадебной галереи на чистом Ubuntu 24.04. Запускать от root.
#   curl -fsSL https://raw.githubusercontent.com/snegirchk/wedding-gallery/main/deploy/setup.sh | bash
set -euo pipefail

REPO="${WG_REPO:-https://github.com/snegirchk/wedding-gallery}"
APP=/opt/wedding-gallery
DATA=/var/wedding/files

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl ca-certificates gnupg apt-transport-https

# --- Node 20 ---
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v//;s/\..*//')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# --- Caddy ---
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# --- пользователь и каталоги ---
id -u wedding >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin wedding
mkdir -p "$DATA"

# --- код ---
if [ -d "$APP/.git" ]; then git -C "$APP" pull --ff-only; else git clone --depth 1 "$REPO" "$APP"; fi
cd "$APP/server"
npm install --omit=dev --no-audit --no-fund
chown -R wedding:wedding "$APP" /var/wedding

# --- секрет админки ---
if [ ! -f /etc/wedding-gallery.env ]; then
  SECRET=$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 16)
  echo "ADMIN_SECRET=$SECRET" > /etc/wedding-gallery.env
  chmod 600 /etc/wedding-gallery.env
fi

# --- сервисы ---
cp "$APP/deploy/wedding-gallery.service" /etc/systemd/system/
install -d /etc/caddy
cp "$APP/deploy/Caddyfile" /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now wedding-gallery
systemctl restart caddy

echo
echo "================  ГОТОВО  ================"
echo "Секрет админки: $(grep ADMIN_SECRET /etc/wedding-gallery.env | cut -d= -f2)"
echo "Проверка:  curl -s localhost:3000/api/list"
systemctl --no-pager -l status wedding-gallery | head -6 || true
