---
title: "መተግበር: Co-op Cloud"
description: ላሜኖስን እንደ Co-op Cloud recipe ለታዳሚ ማስተናገድ ተባባሪዎች ያስተናግዱ።
---

ይህ መመሪያ ላሜኖስን እንደ [Co-op Cloud](https://coopcloud.tech) recipe ለመተግበር ያስተምርዎታል። Co-op Cloud Docker Swarm ከTraefik ለTLS ማስወገድ እና `abra` CLI ለደረባዊ የመተግበሪያ አስተዳደር ይጠቀማል — ለቴክ ትብብርዎች እና ትንሽ ማስተናገድ ተባባሪዎች ተስማሚ ነው።

ይህ recipe በ[የቻለ repository](https://github.com/rhonda-rodododo/llamenos-template) ይተዳደራል።

## ቅድመ ሁኔታዎች

- ሰርቨር ከ[Docker Swarm](https://docs.docker.com/engine/swarm/) ጋር የተነሳ እና [Traefik](https://doc.traefik.io/traefik/) እንደ reverse proxy እየሰራ
- በአካባቢዎ ማሽን ላይ [`abra` CLI](https://docs.coopcloud.tech/abra/install/) ተጭኗል
- DNS የሰርቨርዎን IP የሚያመለክት ዶሜን ስም
- ወደ ሰርቨሩ SSH ግንኙነት

ከCo-op Cloud ጋር አዲስ ከሆኑ፣ መጀመሪያ [Co-op Cloud setup guide](https://docs.coopcloud.tech/intro/) ይከተሉ።

## ፈጣን መነሻ

```bash
# ሰርቨርዎን ይጨምሩ (ቀድሞ ካልተጨመረ)
abra server add hotline.example.com

# Recipe ን ይቅዱ (abra recipes ከ~/.abra/recipes/ ውስጥ ይፈልጋል)
git clone https://github.com/rhonda-rodododo/llamenos-template.git \
  ~/.abra/recipes/llamenos

# አዲስ ላሜኖስ መተግበሪያ ይፍጠሩ
abra app new llamenos --server hotline.example.com --domain hotline.example.com

# ሁሉንም ሚስጥራት ያመነጫሉ
abra app secret generate -a hotline.example.com

# ያስተግብሩ
abra app deploy hotline.example.com
```

`https://hotline.example.com` ይጎብኙ እና የአስተዳዳሪ መለያዎን ለመፍጠር የማዋቀሪያ ዊዘርዱን ይከተሉ።

## ማዕከላዊ አገልግሎቶች

ይህ recipe አምስት አገልግሎቶችን ያስተግብራል፦

| አገልግሎት | ምስል | ዓላማ |
|---------|-------|---------|
| **web** | `nginx:1.27-alpine` | ከTraefik labels ጋር የገለልተኛ ፕሮክሲ |
| **app** | `ghcr.io/rhonda-rodododo/llamenos-platform` | Bun የመተግበሪያ ሰርቨር |
| **db** | `postgres:17-alpine` | PostgreSQL ዳታቤዝ |
| **RustFS** | `RustFS/RustFS` | S3-ተኳሃኝ የፋይል ማከማቻ |
| **relay** | `dockurr/WebSocket relay` | የበጊዜ ለውጥ ክስተቶች WebSocket relay |

## ሚስጥራት

ሁሉም ሚስጥራት በDocker Swarm secrets (የተወሰነ፣ የተረጋገጠ) ይተዳደራሉ፦

| ሚስጥር | ዓይነት | መግለጫ |
|--------|------|-------------|
| `hmac_secret` | hex (64 ቁምፊዎች) | HMAC የመፈረም key ለsession tokens |
| `server_WebSocket` | hex (64 ቁምፊዎች) | የሰርቨር WebSocket identity key |
| `db_password` | alnum (32 ቁምፊዎች) | የPostgreSQL ይለፍቃል |
| `RustFS_access` | alnum (20 ቁምፊዎች) | RustFS access key |
| `RustFS_secret` | alnum (40 ቁምፊዎች) | RustFS secret key |

ሁሉንም ሚስጥራት በአንድ ጊዜ ያመነጫሉ፦

```bash
abra app secret generate -a hotline.example.com
```

የተወሰነ ሚስጥር ለማሽከርከር፦

```bash
# 1. በመተግበሪያ ውቅርዎ ውስጥ ስሪት ያድጉ
abra app config hotline.example.com
# SECRET_HMAC_SECRET_VERSION=v2 ቀይሩ

# 2. አዲሱን ሚስጥር ያመነጫሉ
abra app secret generate hotline.example.com hmac_secret

# 3. ዳግም ያስተግብሩ
abra app deploy hotline.example.com
```

## ውቅር

የመተግበሪያ ውቅርን ኢዲት ያድርጉ፦

```bash
abra app config hotline.example.com
```

ዋና ማዋቀሪያዎች፦

```env
DOMAIN=hotline.example.com
LETS_ENCRYPT_ENV=production

# በመተግበሪያው ውስጥ የሚታየው የመጠሪያ ስም
HOTLINE_NAME=My Hotline

# የትሊፎኒ አቅራቢ (ከማዋቀሪያ ዊዘር በኋላ ያዋቅሩ)
# PBX_TYPE=twilio
# TWILIO_ACCOUNT_SID=
# TWILIO_AUTH_TOKEN=
# TWILIO_PHONE_NUMBER=

# ወይም SignalWire
# PBX_TYPE=signalwire
# SIGNALWIRE_PROJECT_ID=
# SIGNALWIRE_AUTH_TOKEN=
# SIGNALWIRE_PHONE_NUMBER=
# SIGNALWIRE_SPACE_URL=

# ሚስጥር versioning (ለማሽከርከር ያድጉ)
SECRET_HMAC_SECRET_VERSION=v1
SECRET_SERVER_NOSTR_VERSION=v1
SECRET_DB_PASSWORD_VERSION=v1
SECRET_STORAGE_ACCESS_VERSION=v1
SECRET_STORAGE_SECRET_VERSION=v1
```

## የመጀመሪያ መግቢያ

ከተተግበረ በኋላ፣ በአሳሽዎ ውስጥ ዶሜንዎን ክፈቱ እና የማዋቀሪያ ዊዘርዱን ይከተሉ፦

1. **የአስተዳዳሪ መለያዎን ይፍጠሩ** — የመጠሪያ ስም እና የPINዎን ያዘጋጁ
2. **ሞቃዲያንዎን ይሰይሙ** — በመተግበሪያው ውስጥ የሚታየውን የመጠሪያ ስም ያዘጋጁ
3. **ሰርጦችን ይምረጡ** — Voice፣ SMS፣ WhatsApp፣ Signal፣ እና/ወይም Reports ያንቁ
4. **አቅራቢዎችን ያዋቅሩ** — ለየትኛውም የታከለ ሰርጥ የማስረጃ መረጃ ያስገቡ
5. **ገምግመው ይጨርሱ**

## Webhooks ያዋቅሩ

የትሊፎኒ አቅራቢዎን webhooks ወደ ዶሜንዎ ያቅኑ፦

- **Voice (incoming)**: `https://hotline.example.com/api/telephony/incoming`
- **Voice (status)**: `https://hotline.example.com/api/telephony/status`
- **SMS**: `https://hotline.example.com/api/messaging/sms/webhook`
- **WhatsApp**: `https://hotline.example.com/api/messaging/whatsapp/webhook`
- **Signal**: Bridge ወደ `https://hotline.example.com/api/messaging/signal/webhook` ለማስተላለፍ ያዋቅሩ

ስለ አቅራቢ-ተከራካሪ መመሪያዎች ይመልከቱ፦ [Twilio](/docs/en/deploy/providers/twilio)፣ [SignalWire](/docs/en/deploy/providers/signalwire)፣ [Vonage](/docs/en/deploy/providers/vonage)፣ [Plivo](/docs/en/deploy/providers/plivo)።

## አማራጭ: Signal sidecar ን ያንቁ

Signal መልእክት ለመላክ ([Signal setup](/docs/en/deploy/providers/signal) ይመልከቱ)፦

```bash
abra app config hotline.example.com
```

አዘጋጁ፦

```env
COMPOSE_FILE=compose.yml:compose.signal.yml
SECRET_SIGNAL_NOTIFIER_TOKEN_VERSION=v1
```

ተጨማሪ ሚስጥር ያመነጫሉ እና ዳግም ያስተግብሩ፦

```bash
abra app secret generate hotline.example.com signal_notifier_token
abra app deploy hotline.example.com
```

## አማራጭ: SIP bridge ን ያንቁ

ከAsterisk፣ FreeSWITCH፣ ወይም Kamailio በኩል ራስ-ማስተናገድ SIP telephony ለመጠቀም፦

```bash
abra app config hotline.example.com
```

አዘጋጁ፦

```env
COMPOSE_FILE=compose.yml:compose.telephony.yml
PBX_TYPE=asterisk
SECRET_ARI_PASSWORD_VERSION=v1
SECRET_BRIDGE_SECRET_VERSION=v1
```

ተጨማሪ ሚስጥራት ያመነጫሉ እና ዳግም ያስተግብሩ፦

```bash
abra app secret generate hotline.example.com ari_password bridge_secret
abra app deploy hotline.example.com
```

## አማራጭ: Transcription ን ያንቁ

የtranscription overlay ይጨምሩ (4 GB+ RAM ያስፈልጋል)፦

```bash
abra app config hotline.example.com
```

አዘጋጁ፦

```env
COMPOSE_FILE=compose.yml:compose.transcription.yml
WHISPER_MODEL=Systran/faster-whisper-base
WHISPER_DEVICE=cpu
```

ከዚያ ዳግም ያስተግብሩ፦

```bash
abra app deploy hotline.example.com
```

ሰርቨርዎ GPU ካለው `WHISPER_DEVICE=cuda` ይጠቀሙ።

## ማዘመን

```bash
abra app upgrade hotline.example.com
```

ይህ የቅርብ ሰዓት recipe ስሪትን ይይዛል እና ዳግም ያስተግብራል። መረጃ በDocker volumes ውስጥ ይቆያል እና upgrades ያልፋል።

## ተተኪዎች

### Backupbot አዋህድ

ይህ recipe [backupbot](https://docs.coopcloud.tech/backupbot/) labels ለራስ-ሰር PostgreSQL እና RustFS ተተኪዎች ያካትታል። ሰርቨርዎ backupbot ከሚሰራበት፣ ተተኪዎች በራስ-ሰር ይከናወናሉ።

### በእጅ ተተኪ

የተካተተውን የተተኪ ጭብጥ ይጠቀሙ፦

```bash
# ከrecipe ዳይሬክቶሪ
./pg_backup.sh <stack-name>
./pg_backup.sh <stack-name> /backups    # ብጁ ዳይሬክቶሪ፣ 7-ቀን ቆይታ
```

ወይም በቀጥታ ይተኩ፦

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

PostgreSQL ን ያገጉሙት፦

```bash
gunzip -c backup-20260101.sql.gz | \
  docker exec -i $(docker ps -q -f name=<stack-name>_db) \
  psql -U llamenos llamenos
```

## Monitoring

### የጤና ፍተሻዎች

ሁሉም አገልግሎቶች Docker health checks አላቸው። ሁኔታን ያረጋግጡ፦

```bash
abra app ps hotline.example.com
```

መተግበሪያው የጤና መጨረሻዎችን ያጋራል፦

```bash
curl https://hotline.example.com/health/ready
# {"status":"ok"}
curl https://hotline.example.com/health/live
# {"status":"ok"}
```

### መዝገቦች

```bash
# ሁሉም አገልግሎቶች
abra app logs hotline.example.com

# የተወሰነ አገልግሎት
abra app logs hotline.example.com app

# በበአጭር ሰዓት መዝገቦችን ይከተሉ
abra app logs -f hotline.example.com app

# ሁሉንም አገልግሎቶች ይከተሉ
abra app logs -f hotline.example.com
```

## abra ትዕዛዝ መመሪያ

| ትዕዛዝ | መግለጫ |
|---------|-------------|
| `abra app ps hotline.example.com` | እየሰሩ ያሉ ኮንቴይነሮችን እና ጤና ያሳዩ |
| `abra app logs [-f] hotline.example.com [service]` | መዝገቦችን ይመልከቱ (እና ይከተሉ) |
| `abra app config hotline.example.com` | የመተግበሪያ ውቅር ኢዲት ያድርጉ (`$EDITOR` ይከፋል) |
| `abra app secret ls hotline.example.com` | ሚስጥራትን እና ስሪቶቻቸውን ይዘርዝሩ |
| `abra app secret generate hotline.example.com [name]` | አንድ ወይም ሁሉንም ሚስጥራት ያመነጫሉ |
| `abra app deploy hotline.example.com` | መተግበሪያውን ያስተግብሩ (ወይም ዳግም ያስተግብሩ) |
| `abra app upgrade hotline.example.com` | የቅርብ ሰዓት recipe ይይዙ እና ዳግም ያስተግብሩ |
| `abra app undeploy hotline.example.com` | መተግበሪያውን ያቁሙ እና ያስወግዱ (መረጃ ይቆያል) |
| `abra app run hotline.example.com app -- bun run ...` | በapp ኮንቴይነር ውስጥ አንድ ጊዜ ትዕዛዝ ያሂዱ |

## የአገልግሎት ንድፍ

![Co-op Cloud Architecture](/diagrams/coopcloud-architecture.svg)

## ችግር መፍቻ

### መተግበሪያው አይጀምርም

```bash
abra app logs hotline.example.com app
abra app ps hotline.example.com
```

ሁሉም ሚስጥራት የተመነጩ መሆናቸውን ያረጋግጡ፦

```bash
abra app secret ls hotline.example.com
```

ጠፍቷቸው የነበሩ ሚስጥራት ከባዶ ስሪት ጋር ይታያሉ። ያመነጫሉ፦

```bash
abra app secret generate hotline.example.com
```

### የሰርተፊኬት ችግሮች

Traefik TLS ን ይተዳድራል። በሰርቨርዎ ላይ የTraefik መዝገቦችን ያረጋግጡ፦

```bash
docker service logs traefik
```

ዶሜንዎ DNS በሰርቨር ያልፋል እና ፖርት 80/443 ክፍት መሆናቸውን ያረጋግጡ።

### የዳታቤዝ ግንኙነት ስህተቶች

app ኮንቴይነር PostgreSQL ሊደርስ እንደሚችል ያረጋግጡ፦

```bash
abra app run hotline.example.com app -- \
  bun -e "const { sql } = await import('bun'); await sql\`SELECT 1\`; console.log('ok')"
```

### ሚስጥር ማሽከርከር

ሚስጥር ካተላለፈ፦

1. በapp ውቅር ውስጥ ስሪት ያድጉ፦ `abra app config hotline.example.com`
   (ለምሳሌ፣ `SECRET_HMAC_SECRET_VERSION=v2` ቀይሩ)
2. አዲሱን ሚስጥር ያመነጫሉ፦ `abra app secret generate hotline.example.com hmac_secret`
3. ዳግም ያስተግብሩ፦ `abra app deploy hotline.example.com`

### WebSocket relay አይገናኝም

የበጊዜ ለውጥ ክስተቶች WebSocket relay ይፈልጉታል። WebSocket ስህተቶች ካዩ፦

```bash
abra app logs hotline.example.com relay
abra app ps hotline.example.com
```

የNginx ውቅር `/WebSocket` ን ወደ relay ኮንቴይነር በፖርት 7777 እንዲያስተላልፍ ያረጋግጡ።

## ቀጣይ ደረጃዎች

- [Admin Guide](/docs/en/guides/?audience=operator) — ሞቃዲያን ያዋቅሩ
- [Self-Hosting Overview](/docs/en/deploy/self-hosting) — የመተግበርያ አማራጮችን ያወዳድሩ
- [Docker Compose መተግበርያ](/docs/en/deploy/docker) — አማራጭ አንድ-ሰርቨር መተግበርያ
- [Recipe repository](https://github.com/rhonda-rodododo/llamenos-template) — Co-op Cloud recipe ምንጭ
- [Co-op Cloud documentation](https://docs.coopcloud.tech/) — ስለ ፕላትፎርሙ ተጨማሪ ይማሩ
