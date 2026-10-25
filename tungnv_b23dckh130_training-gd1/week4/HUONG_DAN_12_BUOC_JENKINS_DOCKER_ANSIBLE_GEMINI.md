# HƯỚNG DẪN THỰC HÀNH 12 BƯỚC: JENKINS + DOCKER + ANSIBLE + TRIVY + GITLEAKS

> **Tài liệu để Gemini đọc và hỗ trợ thực hành.** Ngôn ngữ: Tiếng Việt. Ngày biên soạn: 24/10/2026. Đối tượng: người mới học DevOps. Mục tiêu: hoàn thành 7 stage CI/CD và quay demo 3–5 phút.
>
> **Chỉ dẫn cho Gemini:** Hãy dùng tài liệu này làm nguồn hướng dẫn chính; không giả định người học đã chạy thành công các lệnh. Khi người học báo lỗi, hỏi/lấy log ở bước đang làm, giải thích nguyên nhân và đưa lệnh kiểm tra trước khi sửa. Phân biệt lệnh chạy trên **máy cá nhân**, **Jenkins VM**, **container Jenkins** và **Target VM**. Không yêu cầu đưa token/private key vào chat. Không tự ý thay IP, tên tài khoản hoặc đường dẫn khi chưa kiểm chứng.

## 0. Mục tiêu, giả định, cấu trúc và quy tắc an toàn

### Kiến trúc

```text
Developer -> GitHub (git push / webhook)
                   |
                   v
           Jenkins VM (Ubuntu + Docker)
              Jenkins container (lab)
                 |-- checkout
                 |-- Gitleaks scan
                 |-- docker build
                 |-- Trivy image scan
                 |-- docker push -> Docker Hub
                 |-- Ansible over SSH --------------> Target VM (Ubuntu + Docker)
                 |                                     |-- docker pull
                 |                                     `-- run Node.js app :3000
                 `-- HTTP smoke test ----------------> /healthz
```

**Quan trọng:** Đây là lab tin cậy, **không phải kiến trúc production an toàn**: Jenkins Controller sử dụng Docker socket trên host và có quyền mạnh. Chỉ sử dụng VM riêng, repository đáng tin cậy, mạng lab; không cho người lạ quyền tạo/chạy Jenkins job. Trong production, chuyển build/deploy sang agents cách ly, dùng secret manager, reverse proxy HTTPS, hạn chế quyền và thiết kế rollback.

### Giả định có thể thay

| Mục | Ví dụ | Bạn phải kiểm tra/thay |
|---|---|---|
| Jenkins VM | `192.168.1.40` | IP thật Jenkins VM |
| Target VM | `192.168.1.50` | IP thật Target VM |
| Hệ điều hành | Ubuntu Server 24.04 x86_64 | Distro/CPU thực tế |
| SSH user trên Target | `ubuntu` | `ubuntu` / `vagrant` / user khác |
| Docker Hub username | `tungnv2026` | Username thật, dùng chữ thường |
| Repository | `https://github.com/USER/REPO.git` | URL repo thật |
| Image | `tungnv2026/docker-cloud-demo` | Repo có quyền push |
| App port | `3000` | Phải trùng port Node.js |

**Tài nguyên gợi ý:** Jenkins VM ít nhất 2 CPU/4 GB RAM (ưu tiên 8 GB)/30–50 GB đĩa cho Docker builds; Target VM 1–2 CPU/2 GB RAM/15–20 GB. Hai VM có thể ping/SSH qua mạng LAN/host-only/bridged phù hợp. Các IP trong hướng dẫn là ví dụ, không tự động hoạt động trên mạng của bạn.

### Công cụ và điều kiện hoàn thành

- Máy cá nhân: terminal, Git, editor, trình duyệt.
- Jenkins VM: Docker Engine + Docker Compose plugin, port TCP 8080 từ máy cá nhân.
- Target VM: Docker Engine, SSH server port 22 cho Jenkins VM, ứng dụng port 3000 cho Jenkins VM/máy cá nhân.
- Jenkins container: Git, Docker CLI, Ansible, SSH client, curl, Trivy, Gitleaks.
- Tài khoản: Git repo, Docker Hub có access token, SSH key riêng cho deploy.

### Quy ước lệnh

- `$` trong các ví dụ có nghĩa là shell; không gõ ký tự `$` nếu xuất hiện trong prompt.
- Các đoạn có `YOUR_*`, `USER`, `REPO`, IP ví dụ: thay đúng giá trị trước khi chạy.
- Không commit private key, `.env` chứa secret, PAT, Jenkins data hoặc `.ssh`.
- Trước khi mở Jenkins/Web app ra Internet, thêm firewall/VPN/reverse proxy HTTPS và bảo vệ tài khoản.

---

# BƯỚC 1 — Chuẩn bị 2 VM, mạng và SSH

**Ở đâu:** Máy cá nhân và hai VM.

1. Tạo **Jenkins VM** và **Target VM** bằng VirtualBox/VMware/cloud; cài Ubuntu Server.
2. Chọn mạng sao cho hai VM nhìn thấy nhau (bridged hoặc mạng riêng có định tuyến). Nếu dùng NAT VM, phải thiết lập port forwarding phù hợp.
3. Trên **mỗi VM**, chạy:

```bash
hostname
hostname -I
ip route
cat /etc/os-release
uname -m
sudo apt update
sudo apt install -y openssh-server curl git ca-certificates
sudo systemctl enable --now ssh
sudo systemctl status ssh --no-pager
```

4. Trên **Jenkins VM**, thử:

```bash
ping -c 3 192.168.1.50
ssh ubuntu@192.168.1.50
```

5. Từ máy cá nhân thử SSH vào hai VM, ghi lại IP, user. Nếu `ping` bị chặn ICMP, vẫn có thể kiểm tra SSH qua `ssh` hoặc `nc -vz <IP> 22`.

**Kiểm chứng:** SSH từ Jenkins VM đến Target VM được (có thể dùng mật khẩu tạm ở bước này). `hostname -I` đúng với IP kế hoạch.

**Lỗi thường gặp:** `No route to host` → cấu hình mạng; `Connection refused` → sshd chưa chạy/firewall; `Permission denied` → user hoặc cách xác thực sai.

---

# BƯỚC 2 — Cài Docker trên cả hai VM

**Ở đâu:** Jenkins VM và Target VM, chạy riêng từng máy.

Hướng dẫn này dùng kho chính thức Docker cho Ubuntu. Nếu máy đã cài Docker, kiểm tra trước, tránh cài trùng các gói Docker từ nguồn khác. Trường hợp Ubuntu bản khác cần đối chiếu tài liệu Docker chính thức.

```bash
# Chạy trên MỖI VM
sudo apt update
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

# Ubuntu dùng /etc/os-release cung cấp VERSION_CODENAME
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF_DOCKER
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF_DOCKER

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
sudo docker run --rm hello-world
```

**Lưu ý:** Không cần thêm user `jenkins`/`ubuntu` vào group docker để thực hiện lab; `sudo docker` trên VM hoặc Docker socket từ container Jenkins sẽ được dùng. Membership group docker cũng có mức đặc quyền tương đương root.

**Kiểm chứng:** `hello-world` in thông báo chào; `sudo docker compose version` chạy được trên Jenkins VM.

**Lỗi:** `permission denied ... docker.sock` → dùng `sudo` trên host; `Cannot connect to Docker daemon` → `sudo systemctl status docker`.

---

# BƯỚC 3 — Khởi chạy Jenkins container (custom image) và thiết lập ban đầu

**Ở đâu:** Jenkins VM.

Không dùng `docker exec apt/pip ...` để cài công cụ vì mất khi tạo lại container. Build image cố định môi trường. **Cấu hình dưới đây ưu tiên chạy được trong lab Ubuntu x86_64, không phải hardening production.**

```bash
mkdir -p ~/jenkins-lab
cd ~/jenkins-lab
```

Tạo `Dockerfile.jenkins`:

```dockerfile
FROM jenkins/jenkins:lts-jdk21
USER root

# Docker CLI, Git, SSH, Python, curl, unzip; Debian base từ image Jenkins
RUN apt-get update && apt-get install -y --no-install-recommends \
    docker.io git openssh-client python3 python3-pip python3-venv \
    curl wget ca-certificates tar gzip jq \
    && python3 -m venv /opt/ansible \
    && /opt/ansible/bin/pip install --no-cache-dir ansible \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/opt/ansible/bin:${PATH}"

# Lab amd64: Gitleaks phiên bản cố định; xác minh artifact/checksum trước khi đưa production
ARG GITLEAKS_VERSION=8.18.2
RUN wget -q "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" -O /tmp/gitleaks.tar.gz \
    && tar -xzf /tmp/gitleaks.tar.gz -C /usr/local/bin gitleaks \
    && rm /tmp/gitleaks.tar.gz

# Lab: script cài Trivy chính thức; trong production nên pin version + checksum
RUN curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh \
    | sh -s -- -b /usr/local/bin

USER jenkins
```

**Chú ý:** `docker.io` trong image cài Docker client từ Debian, có thể khác phiên bản Docker Engine trên VM; nếu có vấn đề API/CLI thì thay bằng `docker-ce-cli` theo hướng dẫn Jenkins chính thức. Gitleaks binary đang cố định bản cũ để đồng bộ kế hoạch mẫu; nên cập nhật sang bản được kiểm thử trước khi dùng lâu dài.

Tạo `compose.yaml`:

```yaml
services:
  jenkins:
    build:
      context: .
      dockerfile: Dockerfile.jenkins
    container_name: jenkins-ci
    restart: unless-stopped
    user: root  # CHỈ CHO LAB: cần quyền mở docker.sock; không dùng production
    ports:
      - "8080:8080"
    volumes:
      - jenkins_home:/var/jenkins_home
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      DOCKER_HOST: unix:///var/run/docker.sock
volumes:
  jenkins_home:
```

Ở đây **socket binding**, KHÔNG phải Docker-in-Docker. Không cần mount `/usr/bin/docker` từ host vì Docker CLI đã nằm trong custom image. Không mở port 50000 trừ khi dùng inbound agent.

```bash
sudo docker compose build
sudo docker compose up -d
sudo docker compose ps
sudo docker logs jenkins-ci --tail 80
sudo docker exec jenkins-ci cat /var/jenkins_home/secrets/initialAdminPassword
```

Trên trình duyệt mở `http://192.168.1.40:8080`. Dán mật khẩu unlock ở lệnh cuối. Chọn **Install suggested plugins**, tạo tài khoản admin và thiết lập Jenkins URL.

**Kiểm chứng:** giao diện Dashboard hiện ra; volume `jenkins_home` vẫn tồn tại sau `docker compose restart`. **Không chạy `docker compose down -v`** vì sẽ xóa volume dữ liệu.

---

# BƯỚC 4 — Kiểm tra bộ công cụ bên trong Jenkins

**Ở đâu:** Jenkins VM, các lệnh `docker exec` kiểm tra trong container.

```bash
sudo docker exec jenkins-ci bash -lc 'whoami; java -version; git --version'
sudo docker exec jenkins-ci bash -lc 'docker version'
sudo docker exec jenkins-ci bash -lc 'ansible --version'
sudo docker exec jenkins-ci bash -lc 'ssh -V'
sudo docker exec jenkins-ci bash -lc 'trivy --version'
sudo docker exec jenkins-ci bash -lc 'gitleaks version'
sudo docker exec jenkins-ci bash -lc 'curl --version | head -n 1'
```

Nếu `docker version` in cả **Client** và **Server**, socket đã hoạt động. Nếu chỉ thấy Client: xem mount socket, quyền trên socket và tình trạng Docker daemon host. Nếu Trivy/Gitleaks build image thất bại, xem log `sudo docker compose build --progress=plain`; có thể mạng, release URL, kiến trúc CPU hoặc giới hạn tải GitHub.

Trên UI Jenkins vào **Manage Jenkins → Plugins**, kiểm tra/cài: **Pipeline**, **Git**, **Credentials Binding**, **SSH Agent**. Khởi động lại Jenkins nếu được yêu cầu.

**Kiểm chứng:** tất cả `--version` chạy được; plugin SSH Agent có mặt.

---

# BƯỚC 5 — Tạo ứng dụng Node.js demo, Dockerfile, kiểm tra /healthz

**Ở đâu:** Máy cá nhân (nơi quản lý repo Git); có thể làm trên Jenkins VM nếu thuận tiện.

Chọn một cấu trúc thống nhất; **không trộn** `week3/demo-docker-image/` và `app/` trong câu lệnh Docker build. Ở đây chuẩn hóa app ở `app/`:

```text
ci-cd-demo/
├── Jenkinsfile
├── .gitignore
├── app/
│   ├── Dockerfile
│   ├── package.json
│   ├── package-lock.json  # tự sinh bằng npm install --package-lock-only
│   └── src/
│       └── index.js
└── ansible/
    ├── inventory.ini
    ├── requirements.yml
    └── deploy-docker.yml
```

Tạo `app/package.json`:

```json
{
  "name": "docker-cloud-demo",
  "version": "1.0.0",
  "private": true,
  "scripts": {"start": "node src/index.js"},
  "engines": {"node": ">=20"}
}
```

Tạo `app/src/index.js` không cần thư viện ngoài (giảm rủi ro dependency để dễ demo):

```javascript
const http = require('node:http');
const port = Number(process.env.PORT || 3000);
const version = process.env.APP_VERSION || 'dev';
http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.url === '/healthz') {
    res.writeHead(200);
    return res.end(JSON.stringify({status: 'ok', version}));
  }
  if (req.url === '/') {
    res.writeHead(200);
    return res.end(JSON.stringify({name: 'Nguyen Vinh Tung', studentId: 'B23DCKH130', version}));
  }
  res.writeHead(404);
  res.end(JSON.stringify({error: 'not found'}));
}).listen(port, '0.0.0.0', () => console.log(`Listening on ${port}`));
```

Nếu app có sẵn ở `week3/demo-docker-image`, bạn có thể di chuyển/nội dung tương đương sang `app/` **hoặc sửa tất cả các đường dẫn trong Jenkinsfile** cho nhất quán.

Sinh lockfile từ thư mục `app/` (máy đã cài Node/npm hoặc dùng node container):

```bash
cd app
npm install --package-lock-only
cd ..
```

Tạo `app/Dockerfile`:

```dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ ./src/
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -q -O - http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "src/index.js"]
```

Tạo `.gitignore`:

```gitignore
node_modules/
.env
*.pem
*.key
.vault_pass
.venv/
```

Test tại máy có Docker:

```bash
docker build -t local-demo:test -f app/Dockerfile app/
docker run -d --name local-demo-test -p 3000:3000 -e APP_VERSION=local local-demo:test
curl -i http://127.0.0.1:3000/healthz
curl -i http://127.0.0.1:3000/
docker logs local-demo-test
docker rm -f local-demo-test
```

**Kiểm chứng:** `/healthz` trả HTTP 200, `/` có `name`, `studentId`, `version`.

---

# BƯỚC 6 — Build và push Docker image thủ công; Target pull được

**Ở đâu:** Máy có source + Docker (máy cá nhân hoặc Jenkins VM). Không đẩy thông tin đăng nhập lên Git.

```bash
export DOCKER_HUB_USER='tungnv2026'   # THAY username thật
export IMAGE_NAME="$DOCKER_HUB_USER/docker-cloud-demo"
export IMAGE_TAG='manual-1'

docker build -t "$IMAGE_NAME:$IMAGE_TAG" -f app/Dockerfile app/
docker login -u "$DOCKER_HUB_USER"  # nhập PAT khi được hỏi
docker push "$IMAGE_NAME:$IMAGE_TAG"
docker logout
```

Đăng nhập Docker Hub web kiểm tra tag `manual-1` tồn tại. Image Docker Hub **public** thì Target VM pull được trực tiếp; nếu **private**, cần cơ chế `docker login`/registry credentials an toàn trên Target trước khi triển khai, không dán PAT vào Playbook.

**Trên Target VM**:

```bash
sudo docker pull tungnv2026/docker-cloud-demo:manual-1   # THAY username
sudo docker image ls | grep docker-cloud-demo
```

**Kiểm chứng:** `docker pull` thành công. Nếu `requested access denied`, kiểm tra username, repository/tag, public/private và PAT quyền push. **Không đổi tên image giữa các bước**.

---

# BƯỚC 7 — Cài Ansible Collection, kết nối SSH và chạy Playbook thủ công

**Ở đâu:** Source repo ở nơi chạy Ansible. Đối với mô hình cuối, Ansible chạy **bên trong Jenkins container**; cần kiểm tra key và known_hosts ở Jenkins trước.

Tạo cặp SSH deploy bằng `ssh-keygen` trên máy quản trị an toàn (không ghi đè SSH key cũ):

```bash
ssh-keygen -t ed25519 -C 'jenkins-lab-deploy' -f ~/.ssh/jenkins_lab_deploy
```

Chép **public key** lên Target VM cho user `ubuntu`:

```bash
ssh-copy-id -i ~/.ssh/jenkins_lab_deploy.pub ubuntu@192.168.1.50
ssh -i ~/.ssh/jenkins_lab_deploy ubuntu@192.168.1.50 'hostname'
```

**Bảo mật:** Đối chiếu fingerprint SSH host qua console/đường tin cậy trước khi chấp nhận. Không sử dụng `StrictHostKeyChecking=no` trong Inventory.

Tạo `ansible/inventory.ini`:

```ini
[target_servers]
target-vm ansible_host=192.168.1.50 ansible_user=ubuntu
```

Tạo `ansible/requirements.yml`:

```yaml
---
collections:
  - name: community.docker
```

Tạo `ansible/deploy-docker.yml`:

```yaml
---
- name: Deploy Node.js container to Target VM
  hosts: target_servers
  become: true
  vars:
    app_image: "{{ IMAGE_NAME }}:{{ IMAGE_TAG }}"
    app_container_name: typ-web-app
  tasks:
    - name: Ensure Docker engine is started
      ansible.builtin.service:
        name: docker
        state: started
        enabled: true

    - name: Run app from desired image and wait for Docker HEALTHCHECK
      community.docker.docker_container:
        name: "{{ app_container_name }}"
        image: "{{ app_image }}"
        pull: always
        state: healthy
        healthy_wait_timeout: 120
        restart_policy: unless-stopped
        published_ports:
          - "3000:3000"
        env:
          APP_VERSION: "{{ IMAGE_TAG }}"

    - name: Verify HTTP response
      ansible.builtin.uri:
        url: http://127.0.0.1:3000/healthz
        status_code: 200
      register: health
      until: health.status == 200
      retries: 10
      delay: 3
```

**Yêu cầu:** Docker đã cài trước ở Target VM (Bước 2). `community.docker` chạy từ Ansible control node, sử dụng Docker API phía target; cài phiên bản collection phù hợp với Ansible hiện có. `state: healthy` cần phiên bản collection có hỗ trợ và image có HEALTHCHECK.

Trước tiên thử tại máy cài Ansible và sở hữu SSH key (nếu chưa có Ansible, dùng Python virtualenv hoặc Jenkins container sau khi nạp key qua Jenkins):

```bash
ansible-galaxy collection install -r ansible/requirements.yml
ansible -i ansible/inventory.ini target_servers -m ping --private-key ~/.ssh/jenkins_lab_deploy
ansible-playbook -i ansible/inventory.ini ansible/deploy-docker.yml \
  --private-key ~/.ssh/jenkins_lab_deploy \
  -e 'IMAGE_NAME=tungnv2026/docker-cloud-demo IMAGE_TAG=manual-1'
```

**Chú ý:** Khi chuyển sang Jenkins Pipeline sẽ dùng SSH Agent Credentials; không truyền `--private-key` và không commit private key. Hãy kiểm tra user `ubuntu` được `sudo` không tương tác (`sudo -n true`) nếu Playbook `become: true`.

**Kiểm chứng trên Target:**

```bash
sudo docker ps
sudo docker inspect --format '{{.State.Health.Status}}' typ-web-app
curl -i http://localhost:3000/healthz
curl -i http://localhost:3000/
```

**Lỗi thường gặp:** `UNREACHABLE` → mạng/SSH/key/known_hosts; `Missing sudo password` → sudo; `community.docker not found` → collection; `port is already allocated` → 3000 bị chiếm; `manifest unknown` → sai tag.

---

# BƯỚC 8 — Tạo Jenkins Credentials và thiết lập SSH known_hosts

**Ở đâu:** Giao diện Jenkins và Jenkins VM.

1. Truy cập `http://192.168.1.40:8080` → **Manage Jenkins → Credentials → System → Global credentials (unrestricted)** (nhãn menu có thể khác theo phiên bản).
2. **Add Credentials**:
   - Kind: **Username with password**
   - ID: `docker-hub-credentials`
   - Username: Docker Hub username
   - Password: **Docker Hub PAT** (không dùng mật khẩu login nếu chính sách yêu cầu token)
3. **Add Credentials**:
   - Kind: **SSH Username with private key**
   - ID: `target-vm-ssh-key`
   - Username: `ubuntu`
   - Private Key: nội dung file **private** `~/.ssh/jenkins_lab_deploy` (không phải `.pub`)
4. Đảm bảo plugin **SSH Agent** đã cài.

**Known hosts:** SSH Agent chỉ cung cấp khóa người dùng, không tự xác minh host key server. Lấy host public key/fingerprint từ Target bằng kênh đáng tin cậy, sau đó lưu trong `/var/jenkins_home/.ssh/known_hosts`. Ví dụ dành cho lab sau khi đã kiểm tra fingerprint:

```bash
# Trên Jenkins VM, thu thập key (phải so sánh fingerprint trước khi tin cậy)
ssh-keyscan -H 192.168.1.50 > /tmp/target_known_hosts
ssh-keygen -lf /tmp/target_known_hosts
# Đối chiếu với 'sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub' trên Target VM.
# Sau khi xác minh:
sudo docker exec jenkins-ci bash -lc 'mkdir -p /var/jenkins_home/.ssh && chmod 700 /var/jenkins_home/.ssh'
sudo docker cp /tmp/target_known_hosts jenkins-ci:/var/jenkins_home/.ssh/known_hosts
sudo docker exec jenkins-ci bash -lc 'chmod 600 /var/jenkins_home/.ssh/known_hosts'
```

Trong lab Compose đang chạy `user: root`, các lệnh build cũng dùng root; với cấu hình khác bạn phải kiểm tra HOME thực tế của Jenkins build user và quyền `known_hosts`. Có thể đặt `HOME=/var/jenkins_home` trong cấu hình container nếu cần. Xác nhận bằng `docker exec ... bash -lc 'echo "$HOME"'`.

**Kiểm chứng:** Jenkins nhìn thấy hai ID credentials (nhưng không hiển thị bí mật), plugin SSH Agent có mặt, known_hosts chứa key được xác minh.

---

# BƯỚC 9 — Tạo Jenkins Pipeline gồm 7 Stage

**Ở đâu:** File `Jenkinsfile` ở gốc repo và UI Jenkins.

Tạo `Jenkinsfile` sau đây (ví dụ chạy trên built-in node **chỉ dành cho lab**, tránh chạy jobs trên Controller trong production):

```groovy
pipeline {
    agent any
    options { timestamps(); disableConcurrentBuilds() }
    environment {
        DOCKER_HUB_USER = 'tungnv2026'  // THAY USERNAME
        IMAGE_NAME = "${DOCKER_HUB_USER}/docker-cloud-demo"
        IMAGE_TAG = "${BUILD_NUMBER}"
        DOCKER_CONFIG = "${WORKSPACE}/.docker-auth"
    }
    stages {
        stage('1. Checkout') {
            steps { checkout scm }
        }
        stage('2. Gitleaks') {
            steps {
                sh 'gitleaks detect --source . --redact --no-banner'
            }
        }
        stage('3. Docker Build') {
            steps {
                sh '''
                    docker build --build-arg BUILDKIT_INLINE_CACHE=1 \
                      -t "$IMAGE_NAME:$IMAGE_TAG" \
                      -t "$IMAGE_NAME:latest" \
                      -f app/Dockerfile app/
                '''
            }
        }
        stage('4. Trivy Gate') {
            steps {
                sh 'trivy image --severity HIGH,CRITICAL "$IMAGE_NAME:$IMAGE_TAG"'
                sh 'trivy image --exit-code 1 --severity CRITICAL --ignore-unfixed "$IMAGE_NAME:$IMAGE_TAG"'
            }
        }
        stage('5. Docker Hub Push') {
            steps {
                withCredentials([usernamePassword(credentialsId: 'docker-hub-credentials', usernameVariable: 'DH_USER', passwordVariable: 'DH_TOKEN')]) {
                    sh '''
                        set -eu
                        mkdir -p "$DOCKER_CONFIG"
                        echo "$DH_TOKEN" | docker login -u "$DH_USER" --password-stdin
                        docker push "$IMAGE_NAME:$IMAGE_TAG"
                        docker push "$IMAGE_NAME:latest"
                        docker logout || true
                    '''
                }
            }
        }
        stage('6. Ansible Deploy') {
            steps {
                sshagent(credentials: ['target-vm-ssh-key']) {
                    sh '''
                        ansible-galaxy collection install -r ansible/requirements.yml
                        ansible-playbook -i ansible/inventory.ini ansible/deploy-docker.yml \
                          -e "IMAGE_NAME=$IMAGE_NAME IMAGE_TAG=$IMAGE_TAG"
                    '''
                }
            }
        }
        stage('7. Smoke Test') {
            steps {
                sh 'curl --fail --show-error --retry 5 --retry-delay 2 http://192.168.1.50:3000/healthz'
                sh 'curl --fail --show-error http://192.168.1.50:3000/'
            }
        }
    }
    post {
        always { sh 'rm -rf "$DOCKER_CONFIG" || true' }
        success { echo 'CI/CD thành công: image đã được deploy và smoke test OK.' }
        failure { echo 'CI/CD thất bại: mở Console Output để xem stage lỗi.' }
    }
}
```

**Rất quan trọng về Gitleaks:** Tài liệu mẫu cố định binary 8.18.2, tương thích cách gọi `detect`. CLI các bản mới có thể dùng `gitleaks git . --redact`. **Không trộn syntax và phiên bản**; chạy `gitleaks --help` để kiểm chứng. Với repository có secret từ trước, Gitleaks có thể phát hiện trong lịch sử; **không tắt security gate chỉ để pass**.

**Cấu hình Jenkins job:**

1. Push source lên GitHub (Bước 10 có hướng dẫn).
2. Jenkins Dashboard → **New Item** → chọn **Pipeline**, đặt tên `docker-ansible-devsecops`.
3. Pipeline Definition: **Pipeline script from SCM** → SCM: **Git** → Repository URL → Credentials Git nếu repo private → Branch `*/main` → Script Path `Jenkinsfile`.
4. Save → **Build Now**; xem Stage View và Console Output.

**Những điều chỉnh có thể cần:**
- Nếu `git checkout` đã do Jenkins SCM thực hiện, `checkout scm` thêm một lần là chấp nhận được trong lab.
- `IMAGE_TAG=BUILD_NUMBER` có thể trùng nếu tạo lại job/repository khác; production dùng commit SHA và immutable digest.
- `latest` tiện demo nhưng không nên là nguồn sự thật để deploy production.
- `Trivy` có thể tải vulnerability database từ mạng; nếu bị rate limit/network failure phải xử lý kết nối, không tự bỏ gate.
- Nếu pipeline chạy trên node khác Controller thì CLI/known_hosts/collection và quyền Docker cần có **trên node đó**, không chỉ trong container Controller.
- Sau khi cài plugin, nếu `agent any` không có executor khả dụng: lab có thể bật built-in node executor có kiểm soát; production nên tạo Agent riêng.

**Kiểm chứng:** Stage 1–7 xanh; output deploy có `ok`/`changed`, smoke test 200.

---

# BƯỚC 10 — Đẩy repo lên GitHub, cấu hình trigger khi git push

**Ở đâu:** Máy cá nhân, GitHub và giao diện Jenkins.

Trên máy cá nhân, từ gốc `ci-cd-demo/`:

```bash
git init
git add .
git status  # kiểm tra KHÔNG có khóa bí mật hoặc token
git commit -m 'Initial Jenkins Docker Ansible DevSecOps lab'
git branch -M main
git remote add origin https://github.com/USER/REPO.git
git push -u origin main
```

**Webhook:**

1. Muốn GitHub tự kích hoạt Jenkins thì GitHub **phải gọi được URL Jenkins**. `http://192.168.1.40:8080` là IP LAN, GitHub public webhook **không truy cập trực tiếp được**.
2. Phương án nhanh cho demo trong LAN: chọn **Poll SCM** theo lịch thích hợp (ví dụ `H/2 * * * *`) để Jenkins tự kiểm tra Git định kỳ; đây không phải webhook ngay lập tức.
3. Nếu yêu cầu webhook thật: xuất Jenkins qua endpoint HTTPS an toàn (VPN/tunnel/reverse proxy có xác thực và hạn chế truy cập), cấu hình plugin GitHub/GitHub hook trigger, và GitHub Repo → Settings → Webhooks → Payload URL dạng `https://jenkins.example/.../github-webhook/` theo plugin. Kiểm tra Delivery status 2xx.
4. Không expose port 8080 trực tiếp vào Internet mà thiếu TLS, auth, firewall và bảo vệ webhook.

Test: sửa giá trị trả về ở `/` hoặc sửa `APP_VERSION`/bổ sung nội dung, `git add`, commit, push. Xem Jenkins có job mới, `BUILD_NUMBER` tăng.

**Kiểm chứng:** ít nhất một commit/push mới dẫn đến build tự động qua trigger đã chọn; nếu dùng Poll SCM, ghi rõ đây là polling trong báo cáo, không gọi là webhook.

---

# BƯỚC 11 — Test lỗi, bảo mật và cách xử lý/troubleshoot

**Ở đâu:** Jenkins UI, Jenkins VM và Target VM.

### Test một lượt bình thường

- Jenkins Console: `Checkout -> Gitleaks -> Build -> Trivy -> Push -> Deploy -> Smoke Test` đều xanh.
- Docker Hub: có image tag mới.
- Target VM: `sudo docker ps`, `sudo docker inspect typ-web-app`, `curl localhost:3000/healthz`, `curl localhost:3000/`.
- Jenkins VM: `curl http://192.168.1.50:3000/healthz`.

### Test security gate (không commit secret thật)

- Không dùng password/token thật để demo. Để kiểm thử an toàn, dùng fixture từ bộ test Gitleaks hoặc chạy một test có kiểm soát trong nhánh lab với giá trị giả được công cụ nhận diện; sau đó xóa fixture.
- Nếu Gitleaks phát hiện: pipeline phải dừng trước Build/Push/Deploy.
- Nếu Trivy phát hiện CRITICAL chưa được bỏ qua theo policy: pipeline phải dừng trước Push/Deploy. Kết quả tùy image/database thời điểm chạy; **không tạo lỗ hổng thật chỉ để quay demo**.

### Các lệnh debug

```bash
# Jenkins VM
sudo docker compose -f ~/jenkins-lab/compose.yaml ps
sudo docker logs jenkins-ci --tail 200
sudo docker exec jenkins-ci bash -lc 'docker version; ansible --version; trivy --version; gitleaks version'

# Target VM
sudo systemctl status docker --no-pager
sudo docker ps -a
sudo docker logs typ-web-app --tail 100
sudo docker inspect typ-web-app
curl -v http://127.0.0.1:3000/healthz
```

| Triệu chứng | Kiểm tra | Cách khắc phục |
|---|---|---|
| Jenkins port 8080 không vào được | `docker ps`, VM firewall | Cho phép 8080 chỉ từ mạng quản trị |
| `docker.sock permission denied` | mount socket, user | Lab dùng root như Compose; production chuyển agent an toàn |
| `docker: not found` | `docker --version` trong node chạy job | Cài Docker CLI lên đúng node |
| `gitleaks: not found` / lệnh sai | `gitleaks version`, `--help` | Pin đúng phiên bản, sửa cú pháp |
| Trivy không tải DB | kiểm tra DNS/proxy/mạng | Cho tải DB hoặc dùng cache/mirror được phê duyệt |
| Docker Hub 401/denied | ID credentials, PAT scope, repo | Dùng PAT đúng quyền và tên image |
| `Permission denied (publickey)` | `sshagent` + known_hosts + authorized_keys | Chép public key, kiểm tra credential, username |
| `Host key verification failed` | fingerprint `known_hosts` | Xác minh và bổ sung đúng host key |
| Ansible unreachable | route/22/firewall | Kiểm tra từ Jenkins container tới Target |
| `community.docker` không có | `ansible-galaxy collection list` | Cài từ requirements.yml đúng môi trường |
| `become` thất bại | sudo user đích | Cấp sudo tối thiểu hoặc cấu hình become phù hợp |
| Container unhealthy | `docker logs`, inspect health | Kiểm tra Node listen 0.0.0.0, /healthz, port |
| Smoke test không kết nối | Target listen/3000, firewall | Cho phép port 3000 từ Jenkins VM |

### Về rollback/downtime

Trong lab, thay thế container có thể gây downtime ngắn. Nếu deploy lỗi, bản cũ có thể đã bị thay thế; việc thất bại smoke test **không có nghĩa hệ thống tự rollback**. Muốn nâng cấp thành production, thêm backup tag/digest đã chạy tốt, bước rollback rõ ràng, health/ready checks và phương án blue-green hoặc reverse proxy.

---

# BƯỚC 12 — Quay video demo 3–5 phút và kiểm tra kết quả cuối

**Ở đâu:** Máy cá nhân với màn hình trình duyệt, terminal và Jenkins UI.

## Kịch bản quay

| Mốc | Nội dung cần thể hiện | Bằng chứng |
|---|---|---|
| 0:00–0:30 | Sơ đồ Git → Jenkins → Docker Hub → Ansible → Target VM | Sơ đồ kiến trúc |
| 0:30–1:15 | Mở repo, Dockerfile, Jenkinsfile, Playbook; sửa code, commit/push | Commit SHA/branch |
| 1:15–2:30 | Pipeline chạy 7 Stage, Gitleaks/Trivy Gate pass | Stage View, Console Output |
| 2:30–3:30 | Mở `http://<TARGET_IP>:3000/` và `/healthz` | JSON tên, mã sinh viên, version và health |
| 3:30–4:00 | SSH Target VM, `sudo docker ps`, inspect health, image tag | Đang chạy từ image mới |
| 4:00–5:00 | Tổng kết workflow, lưu ý security gate / lợi ích Ansible | Kết quả hoàn thành |

**Chuẩn bị trước khi quay:**
- Kiểm tra GitHub/Jenkins/Docker Hub/Target đã sẵn sàng; không hiện token, private key hoặc mật khẩu trên màn hình.
- Quay một lần thử để xem Stage Build/Trivy tải database mất bao lâu. Video có thể tăng tốc/biên tập nhưng không nên giả kết quả.
- Nếu Jenkins cần 5–10 phút xử lý, quay màn hình rồi cắt/tăng tốc phần chờ; giữ đủ log thể hiện pipeline thực sự đã chạy.

**Checklist nghiệm thu:**

- [ ] Hai VM chạy và liên lạc được.
- [ ] Docker hoạt động trên hai VM.
- [ ] Jenkins UI chạy và dữ liệu được giữ trong volume.
- [ ] Jenkins node có đủ Docker CLI, Ansible, Trivy, Gitleaks.
- [ ] App trả `/healthz` = HTTP 200 và `/` chứa tên, studentId, version.
- [ ] Image thủ công đã push và Target đã pull được.
- [ ] Ansible ping/deploy thủ công thành công.
- [ ] Jenkins credentials + SSH known_hosts hoạt động.
- [ ] Jenkins pipeline có 7 Stage xanh.
- [ ] Git push kích hoạt pipeline (Webhook **hoặc** Poll SCM, ghi rõ).
- [ ] Đã kiểm tra ít nhất một tình huống lỗi và đọc log.
- [ ] Video 3–5 phút, đủ các bằng chứng, không lộ secrets.

---

## Phụ lục A — Giải thích các thư mục và files quan trọng

- `app/`: code Node.js; `Dockerfile` tạo image đóng gói ứng dụng.
- `ansible/inventory.ini`: server đích cần SSH.
- `ansible/requirements.yml`: Collection `community.docker` để sử dụng module quản lý container.
- `ansible/deploy-docker.yml`: mô tả **trạng thái mong muốn** trên Target VM.
- `Jenkinsfile`: điều phối thứ tự các stage; không thay thế Ansible.
- `jenkins-lab/Dockerfile.jenkins`: image CI chứa công cụ; là cấu hình lab quản trị Jenkins, có thể để trong repo riêng.
- `jenkins-lab/compose.yaml`: khởi chạy Jenkins và gắn persistent volume + Docker socket.
- `jenkins_home`: Jenkins jobs, config, plugins, secrets; phải backup và bảo vệ.

## Phụ lục B — 10 câu hỏi Gemini nên hỏi khi người học gặp lỗi

1. Đang làm **bước số mấy**?
2. Lệnh được chạy **trên máy nào**?
3. Lệnh đầy đủ và **stderr/Console Output** là gì (đã che secrets)?
4. `docker ps`/`docker version` trên máy liên quan ra sao?
5. IP và user SSH có đúng với hạ tầng thực không?
6. Repo đang dùng cấu trúc `app/` hay `week3/demo-docker-image/`?
7. Jenkins build chạy trên node nào?
8. Docker Hub image/tag có thực sự tồn tại và quyền public/private?
9. Ansible có SSH/sudo/collection và known_hosts đầy đủ?
10. Lỗi xảy ra ở stage nào và stage trước có thực sự thành công không?

## Phụ lục C — Tài liệu tham khảo chính thức (nên kiểm tra lại khi nâng version)

- Jenkins Docker installation: https://www.jenkins.io/doc/book/installing/docker/
- Jenkins Pipeline: https://www.jenkins.io/doc/book/pipeline/
- Jenkins Credentials: https://www.jenkins.io/doc/book/using/using-credentials/
- Jenkins SSH Agent plugin: https://plugins.jenkins.io/ssh-agent/
- Docker Ubuntu installation: https://docs.docker.com/engine/install/ubuntu/
- Ansible docker_container module: https://docs.ansible.com/ansible/latest/collections/community/docker/docker_container_module.html
- Gitleaks: https://github.com/gitleaks/gitleaks
- Trivy: https://trivy.dev/latest/docs/
- GitHub webhooks: https://docs.github.com/en/webhooks

## Đoạn prompt để dán cho Gemini cùng file này

> Hãy đọc toàn bộ file Markdown đính kèm. Đóng vai mentor DevOps hướng dẫn tôi triển khai đúng 12 bước, từng bước một, bằng tiếng Việt. Giả sử tôi có 2 Ubuntu VM, Jenkins chạy Docker socket binding cho mục đích lab, ứng dụng Node.js, dùng Docker Hub và Ansible SSH. Bắt đầu ở Bước 1, giải thích ý nghĩa từng lệnh, nói rõ chạy trên máy nào, yêu cầu đầu vào, tiêu chí kiểm chứng. Không chuyển sang bước kế nếu tôi chưa xác nhận thành công. Khi tôi gửi lỗi, phân tích đúng log, chỉ sửa phần cần thiết. Không yêu cầu tôi gửi private key, token, mật khẩu; luôn che thông tin nhạy cảm. Nếu có lệnh/tính năng thay đổi theo phiên bản, kiểm tra tài liệu chính thức trước khi đề xuất.

