---
title: "Deploy: Co-op Cloud"
description: Deploy Llamenos as a Co-op Cloud recipe for cooperative hosting collectives.
---

Tilmaahan wuxuu kuu horseedaa sida loo dejiyo Llamenos as a [Co-op Cloud](https://coopcloud.tech) recipe. Co-op Cloud waxa uu isticmaalaa Docker Swarm with Traefik for TLS termination iyo `abra` CLI for standardized app management — ku habboon tech co-ops iyo small hosting collectives.

Recipe-ga waxaa lagu maamulaa [standalone repository](https://github.com/rhonda-rodododo/llamenos-template).

## Shuruudaha hore

- Server leh [Docker Swarm](https://docs.docker.com/engine/swarm/) initialized iyo [Traefik](https://doc.traefik.io/traefik/) running as reverse proxy
- [`abra` CLI](https://docs.coopcloud.tech/abra/install/) installed on your local machine
- Magac domain oo DNS u jeeddo server-kaaga IP
- SSH access to the server

Haddii aad cusub tahay Co-op Cloud, raac [Co-op Cloud setup guide](https://docs.coopcloud.tech/intro/) first.

## Quick start

```bash
# Add your server (haddii aan horey loo darin)
abra server add hotline.example.com

# Clone the recipe (abra waxay ka eegtaa recipes in ~/.abra/recipes/)
git clone https://github.com/rhonda-rodododo/llamenos-template.git \
  ~/.abra/recipes/llamenos

# Create a new Llamenos app
abra app new llamenos --server hotline.example.com --domain hotline.example.com

# Generate all secrets
abra app secret generate -a hotline.example.com

# Deploy
abra app deploy hotline.example.com
```

Booqo `https://hotline.example.com` oo raac setup wizard si aad u sameyso admin account-kaaga.

## Core services

Recipe-ga waxa uu dejiyaa shan adeeg:

| Adeeg | Image | Ujeeddo |
|---------|-------|---------|
| **web** | `nginx:1.27-alpine` | Reverse proxy with Traefik labels |
| **app** | `ghcr.io/rhonda-rodododo/llamenos-platform` | Bun application server |
| **db** | `postgres:17-alpine` | PostgreSQL database |
| **RustFS** | `RustFS/RustFS` | S3-compatible file storage |
| **relay** | `dockurr/WebSocket relay` | WebSocket relay for real-time events |

## Secrets

Dhammaan secrets waxaa loo maamulaa via Docker Swarm secrets (versioned, immutable):

| Secret | Nooc | Sharaxaad |
|--------|------|-------------|
| `hmac_secret` | hex (64 chars) | HMAC signing key for session tokens |
| `server_WebSocket` | hex (64 chars) | Server WebSocket identity key |
| `db_password` | alnum (32 chars) | PostgreSQL password |
| `RustFS_access` | alnum (20 chars) | RustFS access key |
| `RustFS_secret` | alnum (40 chars) | RustFS secret key |

Generate dhammaan secrets hal mar:

```bash
abra app secret generate -a hotline.example.com
```

Si aad u rotate specific secret:

```bash
# 1. Bump version-ka in your app config
abra app config hotline.example.com
# Change SECRET_HMAC_SECRET_VERSION=v2

# 2. Generate the new secret
abra app secret generate hotline.example.com hmac_secret

# 3. Redeploy
abra app deploy hotline.example.com
```

## Configuration

Wax ka beddel app configuration:

```bash
abra app config hotline.example.com
```

Key settings:

```env
DOMAIN=hotline.example.com
LETS_ENCRYPT_ENV=production

# Display name shown in the app
HOTLINE_NAME=My Hotline

# Telephony provider (configure after setup wizard)
# PBX_TYPE=twilio
# TWILIO_ACCOUNT_SID=
# TWILIO_AUTH_TOKEN=
# TWILIO_PHONE_NUMBER=

# Ama SignalWire
# PBX_TYPE=signalwire
# SIGNALWIRE_PROJECT_ID=
# SIGNALWIRE_AUTH_TOKEN=
# SIGNALWIRE_PHONE_NUMBER=
# SIGNALWIRE_SPACE_URL=

# Secret versioning (bump to rotate)
SECRET_HMAC_SECRET_VERSION=v1
SECRET_SERVER_NOSTR_VERSION=v1
SECRET_DB_PASSWORD_VERSION=v1
SECRET_STORAGE_ACCESS_VERSION=v1
SECRET_STORAGE_SECRET_VERSION=v1
```

## First login

Kadib deployment, fur domain-kaaga browser-ka oo raac setup wizard:

1. **Create your admin account** — set display name and PIN-kaaga
2. **Name your hotline** — set display name-ka lagu muujiyo app-ka
3. **Choose channels** — enable Voice, SMS, WhatsApp, Signal, and/or Reports
4. **Configure providers** — enter credentials for each enabled channel
5. **Review and finish**

## Configure webhooks

U jeedi webhooks-ka telephony provider-kaaga domain-kaaga:

- **Voice (incoming)**: `https://hotline.example.com/api/telephony/incoming`
- **Voice (status)**: `https://hotline.example.com/api/telephony/status`
- **SMS**: `https://hotline.example.com/api/messaging/sms/webhook`
- **WhatsApp**: `https://hotline.example.com/api/messaging/whatsapp/webhook`
- **Signal**: Configure bridge to forward to `https://hotline.example.com/api/messaging/signal/webhook`

Eeg tilmaamayaasha la xidhiidha provider-ka: [Twilio](/docs/en/deploy/providers/twilio), [SignalWire](/docs/en/deploy/providers/signalwire), [Vonage](/docs/en/deploy/providers/vonage), [Plivo](/docs/en/deploy/providers/plivo).

## Optional: Enable Signal sidecar

Signal messaging (eeg [Signal setup](/docs/en/deploy/providers/signal)):

```bash
abra app config hotline.example.com
```

Set:

```env
COMPOSE_FILE=compose.yml:compose.signal.yml
SECRET_SIGNAL_NOTIFIER_TOKEN_VERSION=v1
```

Generate secret-ka dheeraadka ah oo redeploy:

```bash
abra app secret generate hotline.example.com signal_notifier_token
abra app deploy hotline.example.com
```

## Optional: Enable SIP bridge

Self-hosted SIP telephony via Asterisk, FreeSWITCH, ama Kamailio:

```bash
abra app config hotline.example.com
```

Set:

```env
COMPOSE_FILE=compose.yml:compose.telephony.yml
PBX_TYPE=asterisk
SECRET_ARI_PASSWORD_VERSION=v1
SECRET_BRIDGE_SECRET_VERSION=v1
```

Generate secrets-ka dheeraadka ah oo redeploy:

```bash
abra app secret generate hotline.example.com ari_password bridge_secret
abra app deploy hotline.example.com
```

## Optional: Enable transcription

Kudar transcription overlay (requires 4 GB+ RAM):

```bash
abra app config hotline.example.com
```

Set:

```env
COMPOSE_FILE=compose.yml:compose.transcription.yml
WHISPER_MODEL=Systran/faster-whisper-base
WHISPER_DEVICE=cpu
```

Kadib redeploy:

```bash
abra app deploy hotline.example.com
```

Isticmaal `WHISPER_DEVICE=cuda` haddii server-kaagu leeyahay GPU.

## Updating

```bash
abra app upgrade hotline.example.com
```

Tani waxay soo ceshataa latest recipe version oo redeploy. Xogtu way ku sii jirtaa Docker volumes oo way badbaadaa upgrades.

## Backups

### Backupbot integration

Recipe-ga waxa ku jira [backupbot](https://docs.coopcloud.tech/backupbot/) labels for automated PostgreSQL iyo RustFS backups. Haddii server-kaagu uu ku shaqeynayo backupbot, backups way dhacaan automatically.

### Manual backup

Isticmaal backup script-ka ku jira:

```bash
# From the recipe directory
./pg_backup.sh <stack-name>
./pg_backup.sh <stack-name> /backups    # custom directory, 7-day retention
```

Ama backup directly:

```bash
# PostgreSQL
docker exec $(docker ps -q -f name=<stack-name>_db) \
  pg_dump -U llamenos llamenos | gzip > backup-$(date +%Y%m%d).sql.gz

# RustFS (object storage)
docker run --rm \
  -v <stack-name>_RustFS-data:/data \
  -v /backups:/backups \
  alpine tar czf /backups/RustFS-$(date +%Y%m%d).tar.gz /data
```

Restore PostgreSQL:

```bash
gunzip -c backup-20260101.sql.gz | \
  docker exec -i $(docker ps -q -f name=<stack-name>_db) \
  psql -U llamenos llamenos
```

## Monitoring

### Health checks

Dhammaan adeegyada waxay leeyihiin Docker health checks. Check status:

```bash
abra app ps hotline.example.com
```

App-ka waxa uu soo bandhigayaa health endpoints:

```bash
curl https://hotline.example.com/health/ready
# {"status":"ok"}
curl https://hotline.example.com/health/live
# {"status":"ok"}
```

### Logs

```bash
# All services
abra app logs hotline.example.com

# Specific service
abra app logs hotline.example.com app

# Follow logs in real time
abra app logs -f hotline.example.com app

# Follow all services
abra app logs -f hotline.example.com
```

## abra command reference

| Command | Sharaxaad |
|---------|-------------|
| `abra app ps hotline.example.com` | Show running containers and health |
| `abra app logs [-f] hotline.example.com [service]` | View (and follow) logs |
| `abra app config hotline.example.com` | Edit app config (opens `$EDITOR`) |
| `abra app secret ls hotline.example.com` | List secrets and their versions |
| `abra app secret generate hotline.example.com [name]` | Generate one or all secrets |
| `abra app deploy hotline.example.com` | Deploy (ama redeploy) app-ka |
| `abra app upgrade hotline.example.com` | Pull latest recipe and redeploy |
| `abra app undeploy hotline.example.com` | Stop and remove the app (data preserved) |
| `abra app run hotline.example.com app -- bun run ...` | Run a one-off command in the app container |

## Service architecture

![Co-op Cloud Architecture](/diagrams/coopcloud-architecture.svg)

## Troubleshooting

### App won't start

```bash
abra app logs hotline.example.com app
abra app ps hotline.example.com
```

Hubi in dhammaan secrets la soo saaro:

```bash
abra app secret ls hotline.example.com
```

Secrets maqan way muujinayaan version-ka oo madhan. Soo saar:

```bash
abra app secret generate hotline.example.com
```

### Certificate issues

Traefik waxa uu maamulaa TLS. Check Traefik logs on your server:

```bash
docker service logs traefik
```

Hubi in DNS domain-kaagu uu ku jiro server-ka iyo ports 80/443 ay furan yihiin.

### Database connection errors

Check app container can reach PostgreSQL:

```bash
abra app run hotline.example.com app -- \
  bun -e "const { sql } = await import('bun'); await sql\`SELECT 1\`; console.log('ok')"
```

### Secret rotation

Haddii secret la jabsado:

1. Bump version in app config: `abra app config hotline.example.com`
   (e.g., change `SECRET_HMAC_SECRET_VERSION=v2`)
2. Generate new secret: `abra app secret generate hotline.example.com hmac_secret`
3. Redeploy: `abra app deploy hotline.example.com`

### WebSocket relay not connecting

Dhacdooyinka real-time waxay u baahan yihiin WebSocket relay. Haddii aad aragto WebSocket errors:

```bash
abra app logs hotline.example.com relay
abra app ps hotline.example.com
```

Verify Nginx config routes `/WebSocket` to relay container on port 7777.

## Next steps

- [Admin Guide](/docs/en/guides/?audience=operator) — configure the hotline
- [Self-Hosting Overview](/docs/en/deploy/self-hosting) — compare deployment options
- [Docker Compose deployment](/docs/en/deploy/docker) — alternative single-server deployment
- [Recipe repository](https://github.com/rhonda-rodododo/llamenos-template) — Co-op Cloud recipe source
- [Co-op Cloud documentation](https://docs.coopcloud.tech/) — learn more about the platform
