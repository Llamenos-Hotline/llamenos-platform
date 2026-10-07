---
title: መነሻ
description: የራስዎን ላሜኖስ ሞቃዲያን በደቂቃዎች ያስተናግዱ።
---

ላሜኖስ ሞቃዲያን በአካባቢዎ ወይም በሰርቨር ላይ ለማስኬድ ያግዙ። Docker ብቻ ያስፈልጋል — በhost ላይ Node.js፣ Bun፣ ወይም ሌሎች runtimeዎች አያስፈልጉም።

## እንዴት እንደሚሰራ

አንድ ሰው ለሞቃዲያን ቁጥርዎ ሲደውል፣ ላሜኖስ ጥሪውን ለሁሉም በሺፍት ላይ ያሉ ተጠቃሚዎች በአንድ ሰዓት ያስተላልፋል። የመጀመሪያው የመለሰው ተገናኝቷል፣ ሌሎች ደውሎች ይቆማሉ። ጥሪው ከተጠናቀቀ በኋላ፣ ተጠቃሚው ስለዚያ ውይይት የተመሰጠነ ዝብድብ ያስቀምጣል።

![Call Routing](/diagrams/call-routing.svg)

ተመሳሳይ መስመር ለSMS፣ WhatsApp፣ Signal፣ እና ሌሎች መልእክት ሰጪ ሰርጦች ይተገበራል — በተዋሃደ **ውይይቶች** እይታ ይታያሉ።

## ቅድመ ሁኔታዎች

- [Docker](https://docs.docker.com/get-docker/) ከDocker Compose v2 ጋር
- `openssl` (በአብዛኛው Linux እና macOS ስርዓቶች ላይ ቀድሞ ተጭኗል)
- Git

## ፈጣን መነሻ

```bash
git clone https://github.com/rhonda-rodododo/llamenos-platform.git
cd llamenos-platform
./scripts/docker-setup.sh
```

ይህ ሁሉንም አስፈላጊ ሚስጥራት ያመነጫል፣ መተግበሪያውን ይገነባል፣ እና አገልግሎቶቹን ያስጀምራል። አንዴ ከተጠናቀቀ፣ **http://localhost:8000** ይጎብኙ እና የማዋቀሪያ ዊዘርዱን ይከተሉ፦

1. **የአስተዳዳሪ መለያዎን ይፍጠሩ** — የመጠሪያ ስም እና የPINዎን ያዘጋጁ
2. **ሞቃዲያንዎን ይሰይሙ** — በመተግበሪያው ውስጥ የሚታየውን የመጠሪያ ስም ያዘጋጁ
3. **ሰርጦችን ይምረጡ** — Voice፣ SMS፣ WhatsApp፣ Signal፣ እና/ወይም Reports ያንቁ
4. **አቅራቢዎችን ያዋቅሩ** — ለየትኛውም የታከለ ሰርጥ የማስረጃ መረጃ ያስገቡ
5. **ገምግመው ይጨርሱ**

## የምርት መተግበርያ (Production deployment)

ከእውነተኛ ዶሜን እና ከራስ-ሰር TLS ጋር ለሰርቨር፦

```bash
./scripts/docker-setup.sh --domain hotline.yourorg.com --email admin@yourorg.com
```

Caddy በራስ-ሰር Let's Encrypt የTLS ሰርተፊኬቶችን ያዘጋጃል። ፖርት 80 እና 443 ክፍት መሆናቸውን ያረጋግጡ። `--domain` ባንዲራ የምርት Docker Compose overlayን ያንቃል፣ ይህም TLS፣ የመዝገብ ተመላላሽ፣ እና የመረጃ ገደቦችን ያክላል።

ሙሉ ዝርዝር ስለ ሰርቨር ጥንካሬ፣ ተተኪዎች፣ ክትትል፣ እና አማራጭ አገልግሎቶች [Docker Compose የመተግበርያ መመሪያ](/docs/en/deploy/docker) ይመልከቱ።

## ማዕከላዊ አገልግሎቶች

የDocker ማዋቀር እነዚህን ማዕከላዊ አገልግሎቶች ያስጀምራል፦

| አገልግሎት | ዓላማ | ፖርት |
|---------|------|------|
| **app** | ላሜኖስ መተግበሪያ (Bun) | 3000 (የውስጥ) |
| **postgres** | PostgreSQL ዳታቤዝ | 5432 (የውስጥ) |
| **caddy** | የገለልተኛ ፕሮክሲ + ራስ-ሰር TLS | 8000 (አካባቢ)፣ 80/443 (ምርት) |
| **RustFS** | S3-ተኳሃኝ የፋይል ማከማቻ | 9000 (የውስጥ) |
| **WebSocket relay** | የበጊዜ ለውጥ ክስተቶች WebSocket relay | 7777 (የውስጥ) |

አማራጭ ፕሮፋይሎች ይጨምራሉ፦ signal-notifier sidecar፣ sip-bridge (Asterisk/FreeSWITCH/Kamailio)፣ Ollama/vLLM inference፣ Prometheus monitoring።

## የጤና ፍተሻዎች

መተግበሪያው ሁለት የጤና መጨረሻዎችን ያጋራል፣ እነዚህም በDocker health checks እና Kubernetes probes ይጠቀማሉ፦

- `GET /health/ready` — መተግበሪያው ትራፊክ ለማስተናገድ ዝግጁ ሲሆን 200 ይመልሳል (DB ተገናኝቷል፣ migrations ተተግብረዋል)
- `GET /health/live` — የመተግበሪያ ሂደት ሲኖር 200 ይመልሳል

## Webhooks ያዋቅሩ

ከተተገበረ በኋላ፣ የትሊፎኒ አቅራቢዎን webhooks ወደ የመተግበርያ URLዎ ያቅኑ፦

| Webhook | URL |
|---------|-----|
| Voice (incoming) | `https://your-domain/api/telephony/incoming` |
| Voice (status) | `https://your-domain/api/telephony/status` |
| SMS | `https://your-domain/api/messaging/sms/webhook` |
| WhatsApp | `https://your-domain/api/messaging/whatsapp/webhook` |
| Signal | ወደ `https://your-domain/api/messaging/signal/webhook` ያስተላልፉ |

ስለ አቅራቢ-ተከራካሪ ማዋቀር፦ [Twilio](/docs/en/deploy/providers/twilio)፣ [SignalWire](/docs/en/deploy/providers/signalwire)፣ [Vonage](/docs/en/deploy/providers/vonage)፣ [Plivo](/docs/en/deploy/providers/plivo)፣ [Asterisk](/docs/en/deploy/providers/asterisk)፣ [SMS](/docs/en/deploy/providers/sms)፣ [WhatsApp](/docs/en/deploy/providers/whatsapp)፣ [Signal](/docs/en/deploy/providers/signal)።

## ቀጣይ ደረጃዎች

- [Docker Compose መተግበርያ](/docs/en/deploy/docker) — ሙሉ የምርት መተግበርያ መመሪያ ከተተኪዎች እና ክትትል ጋር
- [Kubernetes መተግበርያ](/docs/en/deploy/kubernetes) — ከHelm ጋር ያስተናግዱ
- [Co-op Cloud መተግበርያ](/docs/en/deploy/coopcloud) — ለታዳሚ ማስተናገድ ተባባሪዎች
- [Telephony Providers](/docs/en/deploy/providers/) — የድምፅ አቅራቢዎችን ያወዳድሩ
- [Self-Hosting Overview](/docs/en/deploy/self-hosting) — ሁሉንም የመተግበርያ አማራጮች ያወዳድሩ
