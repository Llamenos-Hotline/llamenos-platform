# Quick Start Guide

> **See also**: The [Operator Handbook](OPERATOR_HANDBOOK.md) is the consolidated operator reference covering daily operations, maintenance schedules, troubleshooting decision trees, emergency procedures, and the full command reference. The [Quick Reference Card](QUICK_REFERENCE.md) provides a one-page cheat sheet.

This guide walks you through deploying Llamenos on a self-hosted VPS from scratch. By the end, you will have a running crisis hotline with TLS, database backups, and an admin account.

**Time estimate**: 30-60 minutes (manual), or 15 minutes with Ansible.

**Audience**: Sysadmins deploying Llamenos for an organization. Familiarity with Linux, SSH, and Docker is assumed.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Provision a VPS](#2-provision-a-vps)
3. [Initial Server Hardening](#3-initial-server-hardening)
4. [Deploy the Application](#4-deploy-the-application)
5. [Bootstrap the Admin Account](#5-bootstrap-the-admin-account)
6. [Configure Telephony](#6-configure-telephony)
7. [Test the Deployment](#7-test-the-deployment)
8. [Update the Application](#8-update-the-application)

---

## 1. Prerequisites

Before you begin, you need:

- **A domain name** pointed at your server (e.g., `hotline.yourorg.org`). An A record pointing to your VPS IP is sufficient. Caddy handles TLS certificates automatically via Let's Encrypt.
- **SSH key pair** for server access. If you do not have one, generate it:
  ```bash
  ssh-keygen -t ed25519 -f ~/.ssh/llamenos_deploy -C "llamenos-deploy"
  ```
- **A VPS** meeting the minimum specifications (see Section 2).
- **A Twilio account** (or another supported telephony provider) with a phone number, if you want voice calling. You can configure telephony later through the admin UI.

### Optional Tools

- **Ansible** (2.15+) -- for automated server hardening and deployment. Install: `pip install ansible`
- **OpenTofu** (1.6+) -- for infrastructure-as-code VPS provisioning. Install: [opentofu.org/docs/intro/install](https://opentofu.org/docs/intro/install/)

---

## 2. Provision a VPS

### Recommended Providers

Choose a privacy-respecting, GDPR-compliant provider with EU data centers:

| Provider | Location | Notes |
|----------|----------|-------|
| **Hetzner** | Germany, Finland | Strong privacy record, EU jurisdiction, best value |
| **OVH** | France | EU jurisdiction, dedicated servers available |
| **Greenhost** | Netherlands | Privacy-focused nonprofit hosting |

**Avoid** US-based providers subject to National Security Letters (NSLs) and FISA court orders unless your organization operates under US jurisdiction.

### Minimum Specifications

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 2 vCPU | 3+ vCPU |
| RAM | 4 GB | 4 GB |
| Disk | 40 GB SSD | 80 GB SSD |
| Network | Dedicated IP | Dedicated IP |
| Virtualization | KVM or dedicated | KVM or dedicated |

**WARNING**: Do not use OpenVZ containers -- they share the host kernel and cannot enforce the kernel hardening parameters described in this guide.

### Option A: Manual VPS Provisioning

1. Create a VPS through your provider's dashboard.
2. Select **Ubuntu 24.04 LTS** as the operating system.
3. Add your SSH public key during creation.
4. Note the server's IP address.

### Option B: Automated Provisioning with OpenTofu

If you prefer infrastructure-as-code, use the OpenTofu modules in `deploy/opentofu/`. This example uses Hetzner Cloud:

```bash
cd deploy/opentofu

# Create your variables file
cat > production.tfvars <<'EOF'
hcloud_token     = "your-hetzner-api-token"
server_type      = "cpx21"       # 3 vCPU, 4 GB RAM
location         = "fsn1"        # Falkenstein, Germany
ssh_key_path     = "~/.ssh/llamenos_deploy.pub"
admin_ssh_cidrs  = ["YOUR_IP/32"]
EOF

# Provision the server
tofu init
tofu plan -var-file=production.tfvars
tofu apply -var-file=production.tfvars
```

The output includes the server IP address and a generated Ansible inventory file.

### DNS Configuration

Create an A record for your domain pointing to the server IP:

```
hotline.yourorg.org.  IN  A  203.0.113.10
```

Wait for DNS propagation before proceeding. You can verify with:

```bash
dig +short hotline.yourorg.org
```

---

## 3. Initial Server Hardening

**SECURITY WARNING**: A default VPS is not hardened. You must apply security configurations before deploying the application. An unhardened server with SSH password auth and no firewall undermines all of the application's E2EE protections.

### Option A: Automated Hardening with Ansible (Recommended)

This is the recommended approach. The Ansible playbook applies all hardening measures idempotently -- it is safe to run multiple times.

```bash
cd deploy/ansible

# Create your inventory file
cp inventory.example.yml inventory.yml
```

Edit `inventory.yml` with your server details:

```yaml
all:
  hosts:
    llamenos:
      ansible_host: 203.0.113.10        # Your VPS IP
      ansible_user: root                  # Use root for the first run
      ansible_ssh_private_key_file: ~/.ssh/llamenos_deploy
      ansible_port: 22                    # Will change to ssh_port after hardening
```

Run the hardening playbook:

```bash
ansible-playbook -i inventory.yml playbooks/harden.yml
```

The playbook performs:

- Creates a `deploy` user with sudo access and disables root SSH login
- Disables SSH password authentication; restricts to key-based auth only
- Changes SSH port (default: 2222; configurable via `ssh_port` variable)
- Configures UFW firewall (allows SSH, HTTP 80, HTTPS 443 only)
- Applies kernel hardening via `sysctl` (reverse path filtering, ICMP redirect blocking, dmesg restriction, kernel pointer hiding)
- Installs and configures fail2ban (SSH brute-force protection: 5 attempts, 1-hour ban)
- Enables unattended security updates (`unattended-upgrades`)
- Installs and configures auditd (file access, privilege escalation, user change logging)
- Installs Docker with security options (`userns-remap`, `no-new-privileges`, log rotation)
- Disables unnecessary services (bluetooth, cups, avahi-daemon)
- Configures NTP for accurate timestamps (required for Schnorr token validation)

After hardening, update your inventory to use the new SSH port and the `deploy` user:

```yaml
all:
  hosts:
    llamenos:
      ansible_host: 203.0.113.10
      ansible_user: deploy
      ansible_ssh_private_key_file: ~/.ssh/llamenos_deploy
      ansible_port: 2222
```

### Option B: Manual Hardening

If you prefer not to use Ansible, apply these steps manually. Each step corresponds to what the Ansible playbook automates.

#### 3b.1 Create a Deploy User

```bash
# SSH in as root
ssh root@203.0.113.10

# Create a non-root user
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy

# Set up SSH key auth for the new user
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys

# Allow passwordless sudo
echo "deploy ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/deploy
```

#### 3b.2 Harden SSH

Edit `/etc/ssh/sshd_config`:

```
Port 2222
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
AllowUsers deploy
X11Forwarding no
```

```bash
systemctl restart sshd
```

**WARNING**: Before closing your current SSH session, open a new terminal and verify you can connect on the new port as the `deploy` user. If you lock yourself out, you will need console access from your VPS provider.

#### 3b.3 Configure Firewall

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 2222/tcp comment "SSH"
ufw allow 80/tcp comment "HTTP"
ufw allow 443/tcp comment "HTTPS"
ufw --force enable
```

#### 3b.4 Kernel Hardening

Add to `/etc/sysctl.d/99-llamenos.conf`:

```
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
kernel.dmesg_restrict = 1
kernel.kptr_restrict = 2
fs.protected_hardlinks = 1
fs.protected_symlinks = 1
```

```bash
sysctl --system
```

#### 3b.5 Install fail2ban

```bash
apt update && apt install -y fail2ban

cat > /etc/fail2ban/jail.local <<'EOF'
[sshd]
enabled = true
port = 2222
maxretry = 5
bantime = 3600
findtime = 600
EOF

systemctl enable fail2ban
systemctl start fail2ban
```

#### 3b.6 Automatic Security Updates

```bash
apt install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades
```

#### 3b.7 Install Docker

```bash
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy

# Docker daemon hardening
cat > /etc/docker/daemon.json <<'EOF'
{
  "userns-remap": "default",
  "no-new-privileges": true,
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
EOF

systemctl restart docker
```

---

## 4. Deploy the Application

### 4.1 Clone the Repository

```bash
ssh deploy@203.0.113.10 -p 2222

git clone https://github.com/llamenos/llamenos.git /opt/llamenos
cd /opt/llamenos/deploy/docker
```

### 4.2 Generate Secrets

Generate all required secrets. Each secret must be unique and cryptographically random.

```bash
# Generate database password
PG_PASSWORD=$(openssl rand -base64 24)
echo "PG_PASSWORD: $PG_PASSWORD"

# Generate HMAC secret (must be exactly 64 hex characters)
HMAC_SECRET=$(openssl rand -hex 32)
echo "HMAC_SECRET: $HMAC_SECRET"

# Generate RustFS credentials
STORAGE_ACCESS_KEY=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 20)
STORAGE_SECRET_KEY=$(openssl rand -base64 24)
echo "STORAGE_ACCESS_KEY: $STORAGE_ACCESS_KEY"
echo "STORAGE_SECRET_KEY: $STORAGE_SECRET_KEY"

# Generate server WebSocket secret (for relay event signing)
SERVER_SECRET=$(openssl rand -hex 32)
echo "SERVER_SECRET: $SERVER_SECRET"
```

**SECURITY WARNING**: Record these secrets in a password manager immediately. They cannot be recovered if lost. You will need the database password for backup recovery operations.

### 4.3 Configure Environment

```bash
cp .env.example .env
chmod 600 .env
```

Edit `.env` and fill in your values:

```bash
# Required
ADMIN_PUBKEY=           # Set in step 5 (bootstrap)
DOMAIN=hotline.yourorg.org
ACME_EMAIL=admin@yourorg.org
PG_PASSWORD=<generated above>
HMAC_SECRET=<generated above>
STORAGE_ACCESS_KEY=<generated above>
STORAGE_SECRET_KEY=<generated above>
SERVER_SECRET=<generated above>

# Application
HOTLINE_NAME=Hotline
ENVIRONMENT=production

# Telephony (configure later via admin UI, or set here)
# TWILIO_ACCOUNT_SID=
# TWILIO_AUTH_TOKEN=
# TWILIO_PHONE_NUMBER=
```

### 4.4 Bootstrap Admin and Start

You need the admin public key before starting. There are two approaches:

**Approach A -- In-browser bootstrap (recommended):**

Start the application first with a temporary admin key, then bootstrap through the setup wizard:

```bash
# Start with a placeholder -- the setup wizard will guide you
# You will replace this after bootstrapping
ADMIN_PUBKEY=0000000000000000000000000000000000000000000000000000000000000000

docker compose up -d
```

Visit `https://hotline.yourorg.org` -- the setup wizard will generate a keypair for you. See [Section 5](#5-bootstrap-the-admin-account) for details.

**Approach B -- CLI bootstrap:**

Generate the keypair locally and set it before starting:

```bash
# On your local machine (requires bun)
cd /path/to/llamenos
bun run bootstrap-admin
```

This prints two public keys and, separately under a `SECRET` heading, the admin's secret seed. Set only the public keys in your `.env`:

```bash
ADMIN_PUBKEY=<ADMIN_PUBKEY value from bootstrap-admin output>
```

Never put the secret seed in `.env`: values configured as admin keys are served to every authenticated user.

Then start the application:

```bash
cd /opt/llamenos/deploy/docker
docker compose up -d
```

### 4.5 Verify Services

```bash
# Check all services are running
docker compose ps

# Expected output: app, postgres, caddy, rustfs all "running" with healthy status
# Wait for health checks (up to 30 seconds)
docker compose logs -f app --since 1m
```

Verify the health endpoint:

```bash
curl -s https://hotline.yourorg.org/api/health
# Expected: {"status":"ok"}
```

---

## 5. Bootstrap the Admin Account

The admin account is the root of trust for your Llamenos instance. It uses a WebSocket keypair (secp256k1 public/private key) rather than a username and password.

### In-Browser Bootstrap (Recommended)

1. Visit `https://hotline.yourorg.org` in your browser.
2. The setup wizard detects that no admin exists and guides you through keypair generation.
3. The wizard generates a keypair in your browser. The private key (nsec) never leaves your device.
4. Download the encrypted backup when prompted. Store it securely.
5. Set a PIN to protect the key on this device.
6. The wizard displays the public key. Update your server's `.env` with this value:

   ```bash
   # On the server
   cd /opt/llamenos/deploy/docker
   # Edit .env and set ADMIN_PUBKEY to the hex public key shown in the wizard
   docker compose up -d   # Restart to pick up the new key
   ```

### CLI Bootstrap (Headless/CI)

If you cannot access the browser (e.g., headless server setup):

```bash
# On your local machine
cd /path/to/llamenos
bun run bootstrap-admin
```

The script prints the public values (`ADMIN_PUBKEY`, `ADMIN_DECRYPTION_PUBKEY`) separately from the
secret values (the admin seed and `SERVER_SECRET`), which appear under a `SECRET` heading.

1. Copy the `ADMIN_PUBKEY` public value into your server's `.env`. Never copy the secret seed into server config.
2. Restart the application: `docker compose up -d`.
3. Store the admin seed in a password manager. It cannot be recovered.
4. The admin imports the seed on the login screen. `ADMIN_PUBKEY` pins the platform admin but does
   not create the account; the setup wizard (In-Browser Bootstrap above) is the supported way to
   register the first admin.

**SECURITY WARNING**: The admin seed is the master key for your hotline. If compromised, an attacker can manage all volunteers, read admin-wrapped notes, and modify all settings. Store it in a hardware security module or a high-security password manager (1Password, Bitwarden, KeePassXC). Never reuse this keypair on public WebSocket relays or other services.

---

## 6. Configure Telephony

Telephony is optional -- Llamenos works as a messaging and reporting platform without it. If you want voice calling, configure a provider.

### Twilio Setup (Most Common)

1. **Create a Twilio account** at [twilio.com](https://www.twilio.com/).
2. **Buy a phone number** with voice capability in your target region.
3. **Get your credentials** from the Twilio Console:
   - Account SID
   - Auth Token
   - Phone Number (E.164 format, e.g., `+15551234567`)

4. **Configure via the admin UI** (recommended):
   - Log in as admin.
   - Navigate to Settings > Telephony Provider.
   - Select "Twilio" from the provider dropdown.
   - Enter your Account SID, Auth Token, and Phone Number.
   - Click "Test Connection" to verify.
   - Save.

   Or set environment variables in `.env`:
   ```bash
   TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TWILIO_AUTH_TOKEN=your_auth_token
   TWILIO_PHONE_NUMBER=+15551234567
   ```

5. **Configure Twilio webhooks** in the Twilio Console:
   - Navigate to your phone number's configuration.
   - Set the Voice webhook URL to: `https://hotline.yourorg.org/telephony/twilio/voice`
   - Set the method to `POST`.
   - Set the Status Callback URL to: `https://hotline.yourorg.org/telephony/twilio/status`

### Other Providers

Llamenos supports five telephony providers. Configure them through the admin UI at Settings > Telephony Provider:

- **SignalWire** -- Twilio-compatible API with better pricing
- **Vonage** -- NCCO-based call control
- **Plivo** -- XML-based call control
- **Asterisk / FreeSWITCH** -- Self-hosted PBX via `sip-bridge/` (requires the telephony Docker profile; `PBX_TYPE` env var selects ARI/ESL/Kamailio backend)

For detailed setup instructions for each provider, see the documentation site or the `site/src/content/docs/` directory.

---

## 7. Test the Deployment

Run through this checklist to verify your deployment:

### Basic Functionality

- [ ] `https://hotline.yourorg.org` loads the login page
- [ ] `https://hotline.yourorg.org/api/health` returns `{"status":"ok"}`
- [ ] Admin can log in with their nsec or passkey
- [ ] TLS certificate is valid (check browser padlock icon)
- [ ] HTTP redirects to HTTPS

### Security Checks

- [ ] SSH password auth is disabled: `ssh -o PasswordAuthentication=yes deploy@server` should fail
- [ ] Only ports 80, 443, and your SSH port are open:
  ```bash
  nmap -p- hotline.yourorg.org
  ```
- [ ] Security headers are present:
  ```bash
  curl -sI https://hotline.yourorg.org | grep -E 'Strict-Transport|X-Content-Type|X-Frame|Content-Security'
  ```
- [ ] fail2ban is active: `sudo fail2ban-client status sshd`

### WebSocket Relay

- [ ] Relay container is running: `docker compose ps WebSocket relay`
- [ ] `/WebSocket` WebSocket endpoint responds: `curl -sI https://hotline.yourorg.org/WebSocket` returns 426 Upgrade Required
- [ ] `SERVER_SECRET` is set in `.env`
- [ ] Real-time events work: open two browser tabs, verify presence updates appear

### Telephony (if configured)

- [ ] Call the hotline number from a phone
- [ ] Voice CAPTCHA plays (if enabled in settings)
- [ ] Call routes to the admin (if on shift or in the fallback group)
- [ ] Twilio webhook logs show successful requests (check Twilio Console > Monitor > Logs)

### Optional: External Monitoring

Set up uptime monitoring with an external service (UptimeRobot, Healthchecks.io, or similar) to ping:

```
https://hotline.yourorg.org/api/health
```

Alert on any non-200 response.

---

## 8. Update the Application

### Manual Update

```bash
ssh deploy@203.0.113.10 -p 2222
cd /opt/llamenos

# Pull latest code
git pull

# Rebuild and restart
cd deploy/docker
docker compose build app
docker compose up -d
```

### Automated Update with Ansible

```bash
cd deploy/ansible
ansible-playbook -i inventory.yml playbooks/update.yml
```

The update playbook:

1. Creates a database backup before updating
2. Pulls the latest code or Docker images
3. Rebuilds the application container
4. Restarts services (Caddy handles connection draining)
5. Waits for the health check to pass
6. Rolls back automatically if the health check fails

### Rollback

If an update causes issues:

```bash
cd /opt/llamenos/deploy/docker

# Check the previous image
docker compose logs app | head -5

# Roll back to a specific git commit
cd /opt/llamenos
git checkout <previous-commit>
cd deploy/docker
docker compose build app
docker compose up -d
```

### Database Migrations

Storage migrations run automatically on application startup. No manual migration steps are required. The application tracks migration versions per namespace and applies any pending migrations at first access.

---

## Optional: Enable Additional Services

### Whisper Transcription (Legacy — Server-Side)

> **Note**: As of Epic 78, transcription runs client-side in the browser via WASM Whisper. The server-side Whisper container is no longer needed for most deployments. Enable it only if you have a specific need for server-side transcription.

```bash
cd /opt/llamenos/deploy/docker
docker compose --profile transcription up -d
```

For GPU acceleration (NVIDIA), set `WHISPER_DEVICE=cuda` in `.env`.

### Self-Hosted SIP PBX (Asterisk / FreeSWITCH)

Self-hosted telephony without a cloud provider. Uses the `sip-bridge/` service, which translates ARI/ESL/Kamailio events to the Llamenos webhook format. Requires SIP trunk configuration.

```bash
# Generate required secrets
ARI_PASSWORD=$(openssl rand -base64 24)
BRIDGE_SECRET=$(openssl rand -base64 24)

# Add to .env
echo "ARI_PASSWORD=$ARI_PASSWORD" >> .env
echo "BRIDGE_SECRET=$BRIDGE_SECRET" >> .env
echo "PBX_TYPE=ari" >> .env   # Options: ari (Asterisk), esl (FreeSWITCH), kamailio

docker compose --profile telephony up -d
```

### Signal Messaging

Enables the Signal messaging channel for text-based communication.

```bash
docker compose --profile signal up -d
```

---

## Next Steps

- **Invite volunteers**: Use the admin panel to generate invite links.
- **Configure shifts**: Set up recurring shift schedules in the admin panel.
- **Set up backups**: See [`docs/RUNBOOK.md`](RUNBOOK.md) for automated encrypted backup procedures.
- **Review security**: Read [`docs/security/DEPLOYMENT_HARDENING.md`](security/DEPLOYMENT_HARDENING.md) for the full security hardening checklist.
- **Incident response**: Familiarize yourself with the runbook at [`docs/RUNBOOK.md`](RUNBOOK.md) before you need it.
- **Verify builds**: Before deploying updates, verify release integrity with [`docs/REPRODUCIBLE_BUILDS.md`](REPRODUCIBLE_BUILDS.md).
