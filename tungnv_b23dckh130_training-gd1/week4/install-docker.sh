#!/usr/bin/env bash
set -euo pipefail

echo "=== 1. Cap nhat he thong va cai ca-certificates, curl ==="
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg

echo "=== 2. Cai dat khoa GPG chinh thuc cua Docker ==="
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo "=== 3. Them kho phan mem Docker CE Repository ==="
UBUNTU_CODENAME=$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
ARCH=$(dpkg --print-architecture)

cat <<EOF | sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME}
Components: stable
Architectures: ${ARCH}
Signed-By: /etc/apt/keyrings/docker.asc
EOF

echo "=== 4. Tien hanh cai dat Docker Engine va Docker Compose ==="
sudo apt-get update -y
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "=== 5. Kich hoat dich vu Docker ==="
sudo systemctl enable --now docker

echo "=== 6. Kiem tra phien ban Docker ==="
sudo docker --version
sudo docker compose version
sudo docker run --rm hello-world

echo "=== HOAN TAT CAI DAT DOCKER THANH CONG! ==="
