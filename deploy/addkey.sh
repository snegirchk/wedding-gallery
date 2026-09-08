#!/usr/bin/env bash
# Добавляет деплой-ключ и включает вход по ключу. Запускать от root.
set -e
mkdir -p /root/.ssh
KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMiuRdWh9iWMcQVP8uVOSVzQv59xcafd/KtQvrUD2bs/ wedding-gallery-deploy'
grep -qF "$KEY" /root/.ssh/authorized_keys 2>/dev/null || echo "$KEY" >> /root/.ssh/authorized_keys
chmod 700 /root/.ssh
chmod 600 /root/.ssh/authorized_keys
sed -i 's/^#*PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config || true
systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || service ssh reload 2>/dev/null || true
echo "OK — ключ добавлен"
