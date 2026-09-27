---
title: "Belavkirin: Co-op Cloud"
description: Llamenos wekî reçetek Co-op Cloud ji bo komên hosting ên hevkariyê belav bikin.
---

Ev rêber we bi riya belavkirina Llamenos wekî [reçetek Co-op Cloud](https://coopcloud.tech) re rêve dibe. Co-op Cloud Docker Swarm bi Traefik ji bo sîrkirina TLS û CLI ya `abra` ji bo rêvebirina sepanên standard bikar tîne — bêguman ji bo kooperatîfên teknolojî û komên hosting ên biçûk.

Reçet di [embasek cuda](https://github.com/rhonda-rodododo/llamenos-template) de tê birêvebirin.

## Pêşdibistan

- Serverek bi [Docker Swarm](https://docs.docker.com/engine/swarm/) hatiye destpêkirin û [Traefik](https://doc.traefik.io/traefik/) wekî proksiya berevajî dixebite
- [CLI ya `abra`](https://docs.coopcloud.tech/abra/install/) li ser makîneya we ya herêmî hatiye sazkirin
- Navê domainek bi DNS ku li IP-ya servera we nîşan dide
- Gihîştina SSH ji bo serverê

Heke hûn bi Co-op Cloud nenas in, pêşî [rêbera sazkirina Co-op Cloud](https://docs.coopcloud.tech/intro/) bişopînin.

## Destpêkira lez

```bash
# Servera xwe lê zêde bikin (heke berê nekiribe)
abra server add hotline.example.com

# Reçetê clone bikin (abra reçetan li ~/.abra/recipes/ digere)
git clone https://github.com/rhonda-rodododo/llamenos-template.git \
  ~/.abra/recipes/llamenos

# Sepana Llamenos a nû çêbikin
abra app new llamenos --server hotline.example.com --domain hotline.example.com

# Hemî veşartiyan çêbikin
abra app secret generate -a hotline.example.com

# Belav bikin
abra app deploy hotline.example.com
```

Biçin `https://hotline.example.com` û sêrbaziya sazkirinê bişopînin da ku hesaba rêveberiya xwe çêbikin.

## Karûbarên bingehîn

Reçet pênc karûbaran belav dike:

| Karûbar | Wêne | Mebest |
|---------|------|--------|
| **web** | `nginx:1.27-alpine` | Proksiya berevajî bi labelên Traefik |
| **app** | `ghcr.io/rhonda-rodododo/llamenos-platform` | Serverê sepanê Bun |
| **db** | `postgres:17-alpine` | Danegeha PostgreSQL |
| **RustFS** | `RustFS/RustFS` | Depoya pelê ya lihevhatî bi S3 |
| **relay** | `dockurr/WebSocket relay` | WebSocket relay ji bo bûyerên bi-dem |

## Veşartî

Hemî veşartî bi riya veşartiyên Docker Swarm (versiyonkirî, neguherbar) têne birêvebirin:

| Veşartî | Cure | Sermawecî |
|---------|------|-----------|
| `hmac_secret` | hex (64 karakter) | Kilîta îmazkirina HMAC ji bo tokenên danişînê |
| `server_WebSocket` | hex (64 karakter) | Kilîta nasnameya WebSocket-ê ya serverê |
| `db_password` | alnum (32 karakter) | Pêborîna PostgreSQL |
| `RustFS_access` | alnum (20 karakter) | Kilîta gihîştinê ya RustFS |
| `RustFS_secret` | alnum (40 karakter) | Kilîta veşartî ya RustFS |

Hemî veşartiyan bi yekcarî çêbikin:

```bash
abra app secret generate -a hotline.example.com
```

Ji bo ku veşartiyek taybet biguherînin:

```bash
# 1. Versiyon di mîhengên sepana xwe de bilind bikin
abra app config hotline.example.com
# SECRET_HMAC_SECRET_VERSION=v2 biguherînin

# 2. Veşartiya nû çêbikin
abra app secret generate hotline.example.com hmac_secret

# 3. Dîsa belav bikin
abra app deploy hotline.example.com
```

## Mîhengkirin

Mîhengên sepana biguherînin:

```bash
abra app config hotline.example.com
```

Mîhengên sereke:

```env
DOMAIN=hotline.example.com
LETS_ENCRYPT_ENV=production

# Navê xuyangê ya ku di sepana de tê nîşandan
HOTLINE_NAME=My Hotline

# Pêşkêşkerê telefonî (piştî sêrbaziya sazkirinê mîheng bikin)
# PBX_TYPE=twilio
# TWILIO_ACCOUNT_SID=
# TWILIO_AUTH_TOKEN=
# TWILIO_PHONE_NUMBER=

# An jî SignalWire
# PBX_TYPE=signalwire
# SIGNALWIRE_PROJECT_ID=
# SIGNALWIRE_AUTH_TOKEN=
# SIGNALWIRE_PHONE_NUMBER=
# SIGNALWIRE_SPACE_URL=

# Versiyonkirina veşartî (ji bo guherînê bilind bikin)
SECRET_HMAC_SECRET_VERSION=v1
SECRET_SERVER_NOSTR_VERSION=v1
SECRET_DB_PASSWORD_VERSION=v1
SECRET_STORAGE_ACCESS_VERSION=v1
SECRET_STORAGE_SECRET_VERSION=v1
```

## Têketina yekem

Piştî belavkirinê, domaina xwe di gerokê de vekin û sêrbaziya sazkirinê bişopînin:

1. **Hesaba rêveberiya xwe çêbikin** — navê xuyangê û PIN-ê xwe mîheng bikin
2. **Navê xeta xwe binivîsin** — navê xuyangê ya ku di sepana de tê nîşandan mîhend bikin
3. **Kanal hilbijêrin** — Deng, SMS, WhatsApp, Signal, û/an Raportan çalak bikin
4. **Pêşkêşkeran mîheng bikin** — ji bo her kanala çalak erkdanê têkevin
5. **Kontrol bikin û temam bikin**

## Webhookan mîheng bikin

Webhookên pêşkêşkerê telefoniya xwe bi domaina xwe birêve bidin:

- **Deng (hundirîn)**: `https://hotline.example.com/api/telephony/incoming`
- **Deng (statû)**: `https://hotline.example.com/api/telephony/status`
- **SMS**: `https://hotline.example.com/api/messaging/sms/webhook`
- **WhatsApp**: `https://hotline.example.com/api/messaging/whatsapp/webhook`
- **Signal**: Bridge mîheng bikin da ku bişîne `https://hotline.example.com/api/messaging/signal/webhook`

Ji bo rêberên taybetî ya pêşkêşker: [Twilio](/docs/en/deploy/providers/twilio), [SignalWire](/docs/en/deploy/providers/signalwire), [Vonage](/docs/en/deploy/providers/vonage), [Plivo](/docs/en/deploy/providers/plivo).

## Bixwece: Signal sidecar çalak bikin

Ji bo peywendiya Signal (li [Sazkirina Signalê](/docs/en/deploy/providers/signal) binêrin):

```bash
abra app config hotline.example.com
```

Mîheng bikin:

```env
COMPOSE_FILE=compose.yml:compose.signal.yml
SECRET_SIGNAL_NOTIFIER_TOKEN_VERSION=v1
```

Veşartiya zêdetir çêbikin û dîsa belav bikin:

```bash
abra app secret generate hotline.example.com signal_notifier_token
abra app deploy hotline.example.com
```

## Bixwece: SIP bridge çalak bikin

Ji bo telefoniya SIP ya xwe-sazkirî bi riya Asterisk, FreeSWITCH, an Kamailio:

```bash
abra app config hotline.example.com
```

Mîheng bikin:

```env
COMPOSE_FILE=compose.yml:compose.telephony.yml
PBX_TYPE=asterisk
SECRET_ARI_PASSWORD_VERSION=v1
SECRET_BRIDGE_SECRET_VERSION=v1
```

Veşartiyên zêdetir çêbikin û dîsa belav bikin:

```bash
abra app secret generate hotline.example.com ari_password bridge_secret
abra app deploy hotline.example.com
```

## Bixwece: Transkripsiyon çalak bikin

Overlaya transkripsiyonê lê zêde bikin (4 GB+ RAM hewce dike):

```bash
abra app config hotline.example.com
```

Mîheng bikin:

```env
COMPOSE_FILE=compose.yml:compose.transcription.yml
WHISPER_MODEL=Systran/faster-whisper-base
WHISPER_DEVICE=cpu
```

Piştre dîsa belav bikin:

```bash
abra app deploy hotline.example.com
```

Heke servera we GPU heye, `WHISPER_DEVICE=cuda` bikar bînin.

## Nûvekirin

```bash
abra app upgrade hotline.example.com
```

Ev guhertoya herî dawî ya reçetê dikişîne û dîsa belav dike. Danê di tomarên Docker de dimîne û nûvekaniyan jî derbas dike.

## Backup

### Yekbûna backupbot

Reçet [backupbot](https://docs.coopcloud.tech/backupbot/) ji bo backupên otomatîk ên PostgreSQL û RustFS dihewîne. Heke servera we backupbot xebitîne, backup bi otomatîk çêdibin.

### Backup ya destan

Scripta backupê ya tê de bikar bînin:

```bash
# Ji peldanka reçetê
./pg_backup.sh <stack-name>
./pg_backup.sh <stack-name> /backups    # peldanka taybet, parastina 7-rojî
```

An jî rasterast backup bikin:

```bash
# PostgreSQL
docker exec $(docker ps -q -f name=<stack-name>_db) \
  pg_dump -U llamenos llamenos | gzip > backup-$(date +%Y%m%d).sql.gz

# RustFS (depoya objeyan)
docker run --rm \
  -v <stack-name>_RustFS-data:/data \
  -v /backups:/backups \
  alpine tar czf /backups/RustFS-$(date +%Y%m%d).tar.gz /data
```

Vegerandina PostgreSQL:

```bash
gunzip -c backup-20260101.sql.gz | \
  docker exec -i $(docker ps -q -f name=<stack-name>_db) \
  psql -U llamenos llamenos
```

## Çavdêrî

### Kontrolên tenduristiyê

Hemî karûbaran kontrolên tenduristiya Docker hene. Statû kontrol bikin:

```bash
abra app ps hotline.example.com
```

Sepan endpointên tenduristiyê eşkere dike:

```bash
curl https://hotline.example.com/health/ready
# {"status":"ok"}
curl https://hotline.example.com/health/live
# {"status":"ok"}
```

### Têketin

```bash
# Hemî karûbar
abra app logs hotline.example.com

# Karûbarek taybet
abra app logs hotline.example.com app

# Têketinê bi-dem bişopînin
abra app logs -f hotline.example.com app

# Hemî karûbaran bişopînin
abra app logs -f hotline.example.com
```

## Kurteya fermanên abra

| Ferman | Sermawecî |
|---------|-----------|
| `abra app ps hotline.example.com` | Konteynerên li ser xwe û tenduristiyê nîşan bide |
| `abra app logs [-f] hotline.example.com [service]` | Têketinê bibîne (û bişopîne) |
| `abra app config hotline.example.com` | Mîhengên sepana biguherîne (`$EDITOR` vedike) |
| `abra app secret ls hotline.example.com` | Veşartî û versiyonên wan lîste bike |
| `abra app secret generate hotline.example.com [name]` | Yek an hemî veşartiyan çêbike |
| `abra app deploy hotline.example.com` | Sepanê belav bike (an dîsa belav bike) |
| `abra app upgrade hotline.example.com` | Guhertoya herî dawî ya reçetê bikişîne û dîsa belav bike |
| `abra app undeploy hotline.example.com` | Sepanê sekinîne û rake (danê tê parastin) |
| `abra app run hotline.example.com app -- bun run ...` | Fermaneke carekê di konteynera app de bide xebitandin |

## Mîmarîya karûbarê

![Co-op Cloud Architecture](/diagrams/coopcloud-architecture.svg)

## Çareserkirina Probleman

### Sepan nade destpêkirin

```bash
abra app logs hotline.example.com app
abra app ps hotline.example.com
```

Kontrol bike ku hemî veşartî hatine çêkirin:

```bash
abra app secret ls hotline.example.com
```

Veşartiyên winda bi versiyonek vala xuyang dibin. Wan çêbikin:

```bash
abra app secret generate hotline.example.com
```

### Pirsgirêkên sertîfîkayê

Traefik TLS-ê birêve dibe. Têketinên Traefik li ser servera xwe kontrol bikin:

```bash
docker service logs traefik
```

Piştrast bike ku DNS ya domaina we li serverê çareser dibe û portên 80/443 vekirî ne.

### Pirsgirêkên girêdana danegehê

Kontrol bike ku konteynera app dikare bigihêje PostgreSQL:

```bash
abra app run hotline.example.com app -- \
  bun -e "const { sql } = await import('bun'); await sql\`SELECT 1\`; console.log('ok')"
```

### Guherîna veşartî

Heke veşartiyek hatiye kompromîze kirin:

1. Versiyon di mîhengên sepana de bilind bikin: `abra app config hotline.example.com`
   (mînak, `SECRET_HMAC_SECRET_VERSION=v2` biguherînin)
2. Veşartiya nû çêbikin: `abra app secret generate hotline.example.com hmac_secret`
3. Dîsa belav bikin: `abra app deploy hotline.example.com`

### WebSocket relay nagire

Bûyerên bi-dem WebSocket relay hewce dikin. Heke hûn çewtiyên WebSocketê bibînin:

```bash
abra app logs hotline.example.com relay
abra app ps hotline.example.com
```

Piştrast bike ku mîhengê Nginx `/WebSocket`ê bişîne konteynera relay li ser port 7777.

## Gavên pêşerojê

- [Rêbera Rêveberê](/docs/en/guides/?audience=operator) — xeta germê mîheng bikin
- [Kurteya Xwe-Sazkirinê](/docs/en/deploy/self-hosting) — hemî vebijarkên belavkirinê bidin ber hev
- [Belavkirina Docker Compose](/docs/en/deploy/docker) — alternatîfa serverek yekane
- [Embacka reçetê](https://github.com/rhonda-rodododo/llamenos-template) — Çavkaniya reçetê ya Co-op Cloud
- [Belgekirina Co-op Cloud](https://docs.coopcloud.tech/) — li ser platformê bêtir fêr bibin
