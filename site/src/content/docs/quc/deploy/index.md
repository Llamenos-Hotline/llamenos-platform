---
title: Tik'otob'
description: Takojo awokisaxik Llamenos ruch'awib'al pa minutos.
---

Tikojo jun Llamenos ruch'awib'al pa rokiyonel o pa jun servidor. Xwi k'atz'in Docker — majun Node.js, Bun, o chi nik'aj taq runik'oj k'atz'in pa ri servidor.

## Jas ri kachok

Toq k'ayew jun winak pa ri aruch'awib'al rajilab'al, Llamenos k'ayew ri siponik cho konojel ri ajpatanib' pa ch'akul ri'. Ri nab'ej ajpatan ri tak'ul k'ayew, chuqa' ri e chik kek'ax ch'ab'äl. Toq ri siponik konoj, ri ajpatan tikowin tats'ib'aj taq ch'ab'äl etz'apwach chi kij ri ch'awib'al.

![K'ayb'al Siponik](/diagrams/call-routing.svg)

Ri junam k'ayb'al kachok che SMS, WhatsApp, Signal, chuqa' chi nik'aj taq b'eyal tzijob'exik — e k'ut pa jun **Ch'awib'al** k'utb'al.

## K'atz'ina taq jastaq

- [Docker](https://docs.docker.com/get-docker/) ruk' Docker Compose v2
- `openssl` (tik'oj pa sib'alaj Linux chuqa' macOS runik'oj)
- Git

## Tik'otob' aninaq

```bash
git clone https://github.com/rhonda-rodododo/llamenos-platform.git
cd llamenos-platform
./scripts/docker-setup.sh
```

Re' kuk'otob' konojel ri etz'apwach taq tzij, tik'otob' ri runik'oj, chuqa' tik'otob' ri taq patan. Toq b'an, tatz'eta **http://localhost:8000** chuqa' tatz'ekelaj ri wokisaxik runik'oj:

1. **Tikojo ri ak'amalb'e cuenta** — taya' jun b'ij chuqa' ri aPIN
2. **Taya' jun b'ij che ri aruch'awib'al** — taya' ri b'ij ri tik'ut pa ri runik'oj
3. **Tacha' taq b'eyal** — tajaq Ch'ab'äl, SMS, WhatsApp, Signal, chuqa'/o Q'axeb'al Tzij
4. **Tawokisaj taq k'utunela'** — tak'oj retalib'al chi kij chi jujun b'eyal e tijaq
5. **Tak'utj chuqa' tak'oj**

## Tik'otob' chike okisaxik

Che jun servidor ruk' jun k'ojik dominio chuqa' TLS rub'anikil:

```bash
./scripts/docker-setup.sh --domain hotline.yourorg.com --email admin@yourorg.com
```

Caddy kuya' Let's Encrypt TLS certificados ruk' rub'anikil. Tachajij chi ri puertos 80 chuqa' 443 e jaq. Ri `--domain` retal tik'ayew ri producción Docker Compose overlay, ri kutz'aq TLS, taq tzolin wuj, chuqa' taq ruch'ijik okisaxel.

Tatz'eta ri [Ruk'amonik Docker Compose Tik'otob'](/docs/en/deploy/docker) chike ronojel chi kij servidor chojmirik, yakb'al, okisaxik, chuqa' taq patan e tacha'.

## Core taq patan

Ri Docker nik'oj tik'otob' re core taq patan:

| Patan | Patanik | Puerto |
|-------|---------|--------|
| **app** | Llamenos runik'oj (Bun) | 3000 (pa ranik'oj) |
| **postgres** | PostgreSQL tanajib'al tzij | 5432 (pa ranik'oj) |
| **caddy** | Tzalq'otz chib'äl + rub'anikil TLS | 8000 (rokiyonel), 80/443 (producción) |
| **RustFS** | S3-compatible wuj yakb'al | 9000 (pa ranik'oj) |
| **WebSocket relay** | WebSocket relay chike taq k'ak' tzij | 7777 (pa ranik'oj) |

Taq patan e tacha' kutz'aq: signal-notifier sidecar, sip-bridge (Asterisk/FreeSWITCH/Kamailio), Ollama/vLLM ch'obonic, Prometheus okisaxik.

## Chajinik taq okisaxik

Ri runik'oj kuk'ut keb' okisaxik chajinik e k'ayew ruk' Docker health checks chuqa' Kubernetes probes:

- `GET /health/ready` — kutzolij 200 toq ri runik'oj k'oj chike tak'ay tráfico (DB k'ayew, migrations e b'an)
- `GET /health/live` — kutzolij 200 toq ri runik'oj k'as

## Tawokisaj taq webhook

Chrij tik'otob', tawokisaj ri ak'utunel telefonía wehbooks cho ri adeployment URL:

| Webhook | URL |
|---------|-----|
| Ch'ab'äl (okisan) | `https://your-domain/api/telephony/incoming` |
| Ch'ab'äl (rajal) | `https://your-domain/api/telephony/status` |
| SMS | `https://your-domain/api/messaging/sms/webhook` |
| WhatsApp | `https://your-domain/api/messaging/whatsapp/webhook` |
| Signal | Tak'ay cho `https://your-domain/api/messaging/signal/webhook` |

Chi kij k'utunel: [Twilio](/docs/en/deploy/providers/twilio), [SignalWire](/docs/en/deploy/providers/signalwire), [Vonage](/docs/en/deploy/providers/vonage), [Plivo](/docs/en/deploy/providers/plivo), [Asterisk](/docs/en/deploy/providers/asterisk), [SMS](/docs/en/deploy/providers/sms), [WhatsApp](/docs/en/deploy/providers/whatsapp), [Signal](/docs/en/deploy/providers/signal).

## Chi k'aj taq b'ey

- [Docker Compose Tik'otob'](/docs/en/deploy/docker) — ronojel ruk'amonik producción tik'otob' ruk' yakb'al chuqa' okisaxik
- [Kubernetes Tik'otob'](/docs/en/deploy/kubernetes) — tikojo ruk' Helm
- [Co-op Cloud Tik'otob'](/docs/en/deploy/coopcloud) — tikojo chike moloj okisaxik
- [K'utunela' Telefonía](/docs/en/deploy/providers/) — tatz'eqelaj taq k'utunel ch'ab'äl
- [Tikojo Tik'otob' Ruk'uts'ib'axik](/docs/en/deploy/self-hosting) — tatz'eqelaj konojel taq wokisaxik tik'otob'
