---
title: Destpêk
description: Llamenos hotline xwe di çend deqîqeyan de deploy bike.
---

Llamenos hotline xwe li herêmî an jî li serverekê bixebitîne. Tenê Docker pêwîst e — Node.js, Bun, an jî runtimeyên din li ser hostê ne pêwîst in.

## Çawa dixebite

Dema ku kesek jimara hotline ya te diqesîne, Llamenos çavkaniya bangê ji bo hemû bikarhênerên li ser vardiyê di heman demê de dişîne. Bikarhênerê yekemîn ku bersivê dide tê girêdan, û yên din radiwestin. Piştî ku bang bi dawî dibe, bikarhêner dikare nîşeyên şîfrekirî derbarê axaftinê de biparêze.

![Call Routing](/diagrams/call-routing.svg)

Rêvebiriya heman ji bo SMS, WhatsApp, Signal, û kanalên din ên peyaman jî derbas dibe — ew di dîmerek **Axaftinan** ya yekgirtî de xuya dibin.

## Pêşmergî

- [Docker](https://docs.docker.com/get-docker/) bi Docker Compose v2
- `openssl` (li ser piraniya pergalên Linux û macOSê pêş-instal kirî ye)
- Git

## Destpêka bilez

```bash
git clone https://github.com/rhonda-rodododo/llamenos-platform.git
cd llamenos-platform
./scripts/docker-setup.sh
```

Ev hemû sirrên pêwîst çêdike, sepanê ava dike, û xizmetên destpêk dike. Dema ku temam bû, serî li **http://localhost:8000** bide û rêbera sazkirinê bişopîne:

1. **Hesabê adminê xwe çêke** — navê xweşik û PINê xwe mîheng bike
2. **Hotline xwe binav bike** — navê xweşik ku di sepanê de tê nîşandan mîheng bike
3. **Kanalan hilbijêre** — Deng, SMS, WhatsApp, Signal, û /an jî Raporan çalak bike
4. **Pêşkêşkeran mîheng bike** — jîgir ji bo her kanaleke çalak têkevê
5. **Kontrol bike û bi dawî bike**

## Deploykirina hilberînê

Ji bo serverek bi domainek rastîn û TLS ya otomatîk:

```bash
./scripts/docker-setup.sh --domain hotline.yourorg.com --email admin@yourorg.com
```

Caddy otomatîk sertîfîkayên TLS yên Let's Encrypt peyda dike. Bawer be ku portên 80 û 443 vekirî ne. Pîşeya `--domain` overlay ya Docker Compose ya hilberînê çalak dike, ku TLS, rotationa log, û sînorkirinên çavkaniyê zêde dike.

Ji bo hûrguliyên tevde li ser xurtiya serverê, backup, çavdêrî, û xizmetên bijarte rêbernameya [Docker Compose deployment](/docs/en/deploy/docker) bibîne.

## Xizmetên bingehîn

Sazkirina Docker van xizmetên bingehîn destpêk dike:

| Xizmet | Armanc | Port |
|---------|---------|------|
| **app** | Sepana Llamenos (Bun) | 3000 (internal) |
| **postgres** | Danegeha PostgreSQL | 5432 (internal) |
| **caddy** | Proxy ya berevajî + TLS ya otomatîk | 8000 (herêmî), 80/443 (hilberîn) |
| **RustFS** | Storage ya pelê ya bihevokî ya S3 | 9000 (internal) |
| **WebSocket relay** | WebSocket relay ji bo bûyerên rast-dem | 7777 (internal) |

Profîlên bijarte zêde dikin: signal-notifier sidecar, sip-bridge (Asterisk/FreeSWITCH/Kamailio), Ollama/vLLM inference, çavdêriya Prometheusê.

## Health probes

Sepan du endpointên tenduristiyê ji bo kontrolên tenduristiyê yên Docker û probesên Kubernetesê eşkere dike:

- `GET /health/ready` — dema ku sepana amade ye ji bo ku xizmetê bide (DB girêdayî ye, migrations hatine sepandin) 200 vedigere
- `GET /health/live` — dema ku pêvajoya sepana zindî ye 200 vedigere

## Webhookan mîheng bike

Piştî deploykirinê, webhookên pêşkêşkerê telefoniya xwe ji URL ya deploymentê xwe re birêve bibe:

| Webhook | URL |
|---------|-----|
| Voice (incoming) | `https://your-domain/api/telephony/incoming` |
| Voice (status) | `https://your-domain/api/telephony/status` |
| SMS | `https://your-domain/api/messaging/sms/webhook` |
| WhatsApp | `https://your-domain/api/messaging/whatsapp/webhook` |
| Signal | Ji bo `https://your-domain/api/messaging/signal/webhook` bireve

Ji bo sazkirina taybetî ya pêşkêşkerê: [Twilio](/docs/en/deploy/providers/twilio), [SignalWire](/docs/en/deploy/providers/signalwire), [Vonage](/docs/en/deploy/providers/vonage), [Plivo](/docs/en/deploy/providers/plivo), [Asterisk](/docs/en/deploy/providers/asterisk), [SMS](/docs/en/deploy/providers/sms), [WhatsApp](/docs/en/deploy/providers/whatsapp), [Signal](/docs/en/deploy/providers/signal).

## Gavên pêşiya

- [Docker Compose Deployment](/docs/en/deploy/docker) — rêbernameya tevde ya deploykirina hilberînê bi backup û çavdêriyê
- [Kubernetes Deployment](/docs/en/deploy/kubernetes) — bi Helmê deploy bike
- [Co-op Cloud Deployment](/docs/en/deploy/coopcloud) — ji bo komên mêvandariya hevkarî deploy bike
- [Telephony Providers](/docs/en/deploy/providers/) — pêşkêşkerên dengê bide ber hev
- [Self-Hosting Overview](/docs/en/deploy/self-hosting) — hemû vebijarkên deploykirinê bide ber hev
