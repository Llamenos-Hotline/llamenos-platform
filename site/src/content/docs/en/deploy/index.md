---
title: Getting Started
description: Deploy your own Llamenos hotline in minutes.
---

Get a Llamenos hotline running locally or on a server. Only Docker is required — no Node.js, Bun, or other runtimes needed on the host.

## How it works

When someone calls your hotline number, Llamenos routes the call to all on-shift users simultaneously. The first user to answer gets connected, and the others stop ringing. After the call ends, the user can save encrypted notes about the conversation.

![Call Routing](/diagrams/call-routing.svg)

The same routing applies to SMS, WhatsApp, Signal, and other messaging channels — they appear in a unified **Conversations** view.

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

This generates all required secrets, builds the application, and starts the services. Once complete, visit **http://localhost:8000** and follow the setup wizard:

1. **Create your admin account** — set a display name and your PIN
2. **Name your hotline** — set the display name shown in the app
3. **Choose channels** — enable Voice, SMS, WhatsApp, Signal, and/or Reports
4. **Configure providers** — enter credentials for each enabled channel
5. **Review and finish**

## Production deployment

For a server with a real domain and automatic TLS:

```bash
./scripts/docker-setup.sh --domain hotline.yourorg.com --email admin@yourorg.com
```

Caddy automatically provisions Let's Encrypt TLS certificates. Make sure ports 80 and 443 are open. The `--domain` flag activates the production Docker Compose overlay, which adds TLS, log rotation, and resource limits.

See the [Docker Compose deployment guide](/docs/en/deploy/docker) for full details on server hardening, backups, monitoring, and optional services.

## Core services

The Docker setup starts these core services:

| Service | Purpose | Port |
|---------|---------|------|
| **app** | Llamenos application (Bun) | 3000 (internal) |
| **postgres** | PostgreSQL database | 5432 (internal) |
| **caddy** | Reverse proxy + automatic TLS | 8000 (local), 80/443 (production) |
| **RustFS** | S3-compatible file storage | 9000 (internal) |
| **WebSocket relay** | WebSocket relay for real-time events | 7777 (internal) |

Optional profiles add: signal-notifier sidecar, sip-bridge (Asterisk/FreeSWITCH/Kamailio), Ollama/vLLM inference, Prometheus monitoring.

## Health probes

The app exposes two health endpoints used by Docker health checks and Kubernetes probes:

- `GET /health/ready` — returns 200 when the app is ready to serve traffic (DB connected, migrations applied)
- `GET /health/live` — returns 200 when the app process is alive

## Configure webhooks

After deploying, point your telephony provider's webhooks to your deployment URL:

| Webhook | URL |
|---------|-----|
| Voice (incoming) | `https://your-domain/api/telephony/incoming` |
| Voice (status) | `https://your-domain/api/telephony/status` |
| SMS | `https://your-domain/api/messaging/sms/webhook` |
| WhatsApp | `https://your-domain/api/messaging/whatsapp/webhook` |
| Signal | Forward to `https://your-domain/api/messaging/signal/webhook` |

For provider-specific setup: [Twilio](/docs/en/deploy/providers/twilio), [SignalWire](/docs/en/deploy/providers/signalwire), [Vonage](/docs/en/deploy/providers/vonage), [Plivo](/docs/en/deploy/providers/plivo), [Asterisk](/docs/en/deploy/providers/asterisk), [SMS](/docs/en/deploy/providers/sms), [WhatsApp](/docs/en/deploy/providers/whatsapp), [Signal](/docs/en/deploy/providers/signal).

## Next steps

- [Docker Compose Deployment](/docs/en/deploy/docker) — full production deployment guide with backups and monitoring
- [Kubernetes Deployment](/docs/en/deploy/kubernetes) — deploy with Helm
- [Co-op Cloud Deployment](/docs/en/deploy/coopcloud) — deploy for cooperative hosting collectives
- [Telephony Providers](/docs/en/deploy/providers/) — compare voice providers
- [Self-Hosting Overview](/docs/en/deploy/self-hosting) — compare all deployment options
