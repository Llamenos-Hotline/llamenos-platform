---
title: Getting Started
description: Deploy your own Llamenos hotline in minutes.
---

Heli Llamenos hotline oo shaqaysa locally ama on a server. Docker kaliya ayaa loo baahan yahay — ma u baahnato Node.js, Bun, ama runtimes kale on the host.

## How it works

Marka qof uu ku yeedho number-kaaga hotline, Llamenos waxay u gudbisaa call-ka dhammaan users-ka on-shift si isku wajah ah. Qofka ugu horreeya ee jawaaba wuu ku xiran yahay, kuwa kale way joojiyaan. Kadib marka call-ka dhaco, user-ku wuu keydiyaa notes encrypted ku saabsan wadahadka.

![Call Routing](/diagrams/call-routing.svg)

Isku xirka routing-ka waxay ku shaqaysaa SMS, WhatsApp, Signal, iyo channels messaging kale — way soo muuqanayaan in a unified **Conversations** view.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with Docker Compose v2
- `openssl` (pre-installed on most Linux and macOS systems)
- Git

## Quick start

```bash
git clone https://github.com/rhonda-rodododo/llamenos-platform.git
cd llamenos-platform
./scripts/docker-setup.sh
```

Tani waxay soo saartaa dhammaan secrets-ka loo baahan yahay, waxay dhisa app-ka, oo waxay bilaabaa adeegyada. Marka la dhameystiro, booqo **http://localhost:8000** oo raac setup wizard:

1. **Create your admin account** — set display name and PIN-kaaga
2. **Name your hotline** — set display name-ka lagu muujiyo app-ka
3. **Choose channels** — enable Voice, SMS, WhatsApp, Signal, and/or Reports
4. **Configure providers** — enter credentials for each enabled channel
5. **Review and finish**

## Production deployment

For a server leh domain dhab ah oo automatic TLS:

```bash
./scripts/docker-setup.sh --domain hotline.yourorg.com --email admin@yourorg.com
```

Caddy si otomaatig ah ugu soo saariyaa Let's Encrypt TLS certificates. Hubi in ports 80 and 443 ay furan yihiin. `--domain` flag waxay activate gareysaa production Docker Compose overlay, taasoo ku darto TLS, log rotation, iyo resource limits.

Eeg [Docker Compose deployment guide](/docs/en/deploy/docker) for full details on server hardening, backups, monitoring, iyo optional services.

## Core services

Docker setup waxay bilaabayaa core services-kaan:

| Adeeg | Ujeeddo | Port |
|---------|---------|------|
| **app** | Llamenos application (Bun) | 3000 (internal) |
| **postgres** | PostgreSQL database | 5432 (internal) |
| **caddy** | Reverse proxy + automatic TLS | 8000 (local), 80/443 (production) |
| **RustFS** | S3-compatible file storage | 9000 (internal) |
| **WebSocket relay** | WebSocket relay for real-time events | 7777 (internal) |

Optional profiles waxay ku daraan: signal-notifier sidecar, sip-bridge (Asterisk/FreeSWITCH/Kamailio), Ollama/vLLM inference, Prometheus monitoring.

## Health probes

App-ka waxa uu soo bandhigayaa laba health endpoints oo loo isticmaalo by Docker health checks iyo Kubernetes probes:

- `GET /health/ready` — returns 200 marka app-ku diyaar u yahay inuu soo saaro traffic (DB connected, migrations applied)
- `GET /health/live` — returns 200 marka app process-ku nool yahay

## Configure webhooks

Kadib deploying, u jeedi webhooks-ka telephony provider-kaaga deployment URL-kaaga:

| Webhook | URL |
|---------|-----|
| Voice (incoming) | `https://your-domain/api/telephony/incoming` |
| Voice (status) | `https://your-domain/api/telephony/status` |
| SMS | `https://your-domain/api/messaging/sms/webhook` |
| WhatsApp | `https://your-domain/api/messaging/whatsapp/webhook` |
| Signal | Forward to `https://your-domain/api/messaging/signal/webhook` |

Setup gaar ah provider-ka: [Twilio](/docs/en/deploy/providers/twilio), [SignalWire](/docs/en/deploy/providers/signalwire), [Vonage](/docs/en/deploy/providers/vonage), [Plivo](/docs/en/deploy/providers/plivo), [Asterisk](/docs/en/deploy/providers/asterisk), [SMS](/docs/en/deploy/providers/sms), [WhatsApp](/docs/en/deploy/providers/whatsapp), [Signal](/docs/en/deploy/providers/signal).

## Next steps

- [Docker Compose Deployment](/docs/en/deploy/docker) — full production deployment guide with backups and monitoring
- [Kubernetes Deployment](/docs/en/deploy/kubernetes) — deploy with Helm
- [Co-op Cloud Deployment](/docs/en/deploy/coopcloud) — deploy for cooperative hosting collectives
- [Telephony Providers](/docs/en/deploy/providers/) — compare voice providers
- [Self-Hosting Overview](/docs/en/deploy/self-hosting) — compare all deployment options
