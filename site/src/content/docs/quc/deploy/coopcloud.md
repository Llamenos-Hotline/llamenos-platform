---
title: "Tich'ak: Co-op Cloud"
description: Tich'ak Llamenos achi'el jun rutz'aqat Co-op Cloud richin k'ayib'äl k'ayib'äl to'onelab'.
---

Re' taq ruxaq nuk'ut chawe rik'in tich'ak Llamenos achi'el jun [Co-op Cloud](https://coopcloud.tech) rutz'aqat. Co-op Cloud nrokisaj Docker Swarm rik'in Traefik richin TLS ch'akoj chuqa' ri `abra` CLI richin junam taq rutz'aqat samajib'äl — utziläj richin taq k'ayib'äl to'onelab' chuqa' ko'öl taq k'ayib'äl k'ayib'äl.

Ri rutz'aqat nich'ajin pa jun [tz'aqat k'ayib'äl](https://github.com/rhonda-rodododo/llamenos-template).

## Taq k'ayewal

- Jun ruk'u'x samaj rik'in [Docker Swarm](https://docs.docker.com/engine/swarm/) tz'ib'an chuqa' [Traefik](https://doc.traefik.io/traefik/) samajin achi'el ri reverse proxy
- Ri [`abra` CLI](https://docs.coopcloud.tech/abra/install/) tz'ib'an pa awachib'al
- Jun ruk'u'x b'i'aj rik'in DNS nuya' ruk'u'x samaj
- SSH okem pa ri ruk'u'x samaj

We man awetaman ta chi rij Co-op Cloud, katb'e pa ri [rub'eyal ruchojmil Co-op Cloud](https://docs.coopcloud.tech/intro/) chuwäch.

## Rutikirib'al samaj

```bash
# Titz'aqatisaj awachib'al (we man tz'aqat ta)
abra server add hotline.example.com

# Tiwachib'ëx ri rutz'aqat (abra nikanoj taq taq taq pa ~/.abra/recipes/)
git clone https://github.com/rhonda-rodododo/llamenos-template.git \
  ~/.abra/recipes/llamenos

# Titz'uk jun k'ak'a' Llamenos samaj
abra app new llamenos --server hotline.example.com --domain hotline.example.com

# Titz'uk konojel taq ewan taq tzij
abra app secret generate -a hotline.example.com

# Tich'ak
abra app deploy hotline.example.com
```

Katb'e pa `https://hotline.example.com` chuqa' katb'e pa ri ruchojmil ruchojmil richin nitz'uk awachib'al admin.

## Taq ruk'u'x samaj

Ri rutz'aqat nuch'ak'ij'oj' winaq taq samaj:

| Samaj | Wachib'äl | Ruk'u'x samaj |
|---------|-------|---------|
| **web** | `nginx:1.27-alpine` | Reverse proxy rik'in Traefik taq etal |
| **app** | `ghcr.io/rhonda-rodododo/llamenos-platform` | Bun ruchojmil samaj |
| **db** | `postgres:17-alpine` | PostgreSQL ruk'u'x tzij |
| **RustFS** | `RustFS/RustFS` | S3-ruxaq' ruk'u'x k'ayib'äl |
| **relay** | `dockurr/WebSocket relay` | WebSocket relay richin k'ak'a' samajib'äl |

## Taq ewan taq tzij

Konojel taq ewan taq tzij nich'ajin pa Docker Swarm taq ewan taq tzij (rutz'ib'axik, man nutz'ila' ta):

| Ewan tzij | Ruwäch | Rutz'ib'axik |
|--------|------|-------------|
| `hmac_secret` | hex (64 taq tz'ib') | HMAC rutz'ib'anik ewan tzij richin taq ruk'u'x samaj |
| `server_WebSocket` | hex (64 taq tz'ib') | Ruk'u'x samaj WebSocket ruk'u'x samaj |
| `db_password` | alnum (32 taq tz'ib') | PostgreSQL ewan tzij |
| `RustFS_access` | alnum (20 taq tz'ib') | RustFS okem ewan tzij |
| `RustFS_secret` | alnum (40 taq tz'ib') | RustFS ewan tzij |

Titz'uk konojel taq ewan taq tzij pa jun k'ak'a':

```bash
abra app secret generate -a hotline.example.com
```

Richin nitz'ila' jun ewan tzij:

```bash
# 1. Tiya' rutz'ib'axik pa awachib'al samaj
abra app config hotline.example.com
# Tijal SECRET_HMAC_SECRET_VERSION=v2

# 2. Titz'uk ri k'ak'a' ewan tzij
abra app secret generate hotline.example.com hmac_secret

# 3. Tich'ak chik
abra app deploy hotline.example.com
```

## Ruchojmil

Tijal ri ruchojmil samaj:

```bash
abra app config hotline.example.com
```

Taq ruk'u'x samaj:

```env
DOMAIN=hotline.example.com
LETS_ENCRYPT_ENV=production

# Rutz'ib'axik b'i'aj nuk'ut pa ri samaj
HOTLINE_NAME=My Hotline

# Telephony provider (ruchojmil chuwäch ruchojmil)
# PBX_TYPE=twilio
# TWILIO_ACCOUNT_SID=
# TWILIO_AUTH_TOKEN=
# TWILIO_PHONE_NUMBER=

# O SignalWire
# PBX_TYPE=signalwire
# SIGNALWIRE_PROJECT_ID=
# SIGNALWIRE_AUTH_TOKEN=
# SIGNALWIRE_PHONE_NUMBER=
# SIGNALWIRE_SPACE_URL=

# Ewan tzij rutz'ib'axik (tiya' richin nitz'ila')
SECRET_HMAC_SECRET_VERSION=v1
SECRET_SERVER_NOSTR_VERSION=v1
SECRET_DB_PASSWORD_VERSION=v1
SECRET_STORAGE_ACCESS_VERSION=v1
SECRET_STORAGE_SECRET_VERSION=v1
```

## Rutikirib'al okem

Chuwäch ri ch'akoj, tijaq awachib'al pa jun ruk'u'x samaj chuqa' katb'e pa ri ruchojmil ruchojmil:

1. **Titz'uk awachib'al admin** — tiya' jun rutz'ib'axik b'i'aj chuqa' aw PIN
2. **Tiya' b'i'aj awachib'al** — tiya' ri rutz'ib'axik b'i'aj nuk'ut pa ri samaj
3. **Tacha' taq b'ey** — titz'ij'ij' Voice, SMS, WhatsApp, Signal, chuqa'/o Reports
4. **Ruchojmil taq providers** — tiya' taq ewan taq tzij richin junjun taq tz'ij'ij' b'ey
5. **Ril chuqa' titz'aqatisaj**

## Ruchojmil taq webhooks

Tiya' ri ruk'u'x samaj telephony provider's webhooks pa awachib'al:

- **Voice (incoming)**: `https://hotline.example.com/api/telephony/incoming`
- **Voice (status)**: `https://hotline.example.com/api/telephony/status`
- **SMS**: `https://hotline.example.com/api/messaging/sms/webhook`
- **WhatsApp**: `https://hotline.example.com/api/messaging/whatsapp/webhook`
- **Signal**: Ruchojmil bridge richin nuya' pa `https://hotline.example.com/api/messaging/signal/webhook`

Katz'eto' provider-specific taq ruchojmil: [Twilio](/docs/en/deploy/providers/twilio), [SignalWire](/docs/en/deploy/providers/signalwire), [Vonage](/docs/en/deploy/providers/vonage), [Plivo](/docs/en/deploy/providers/plivo).

## Rucha'ik: Titz'ij'ij' Signal sidecar

Richin Signal messaging (katz'eto' [Signal ruchojmil](/docs/en/deploy/providers/signal)):

```bash
abra app config hotline.example.com
```

Tiya':

```env
COMPOSE_FILE=compose.yml:compose.signal.yml
SECRET_SIGNAL_NOTIFIER_TOKEN_VERSION=v1
```

Titz'uk ri k'ak'a' ewan tzij chuqa' tich'ak chik:

```bash
abra app secret generate hotline.example.com signal_notifier_token
abra app deploy hotline.example.com
```

## Rucha'ik: Titz'ij'ij' SIP bridge

Richin self-hosted SIP telephony via Asterisk, FreeSWITCH, o Kamailio:

```bash
abra app config hotline.example.com
```

Tiya':

```env
COMPOSE_FILE=compose.yml:compose.telephony.yml
PBX_TYPE=asterisk
SECRET_ARI_PASSWORD_VERSION=v1
SECRET_BRIDGE_SECRET_VERSION=v1
```

Titz'uk ri k'ak'a' taq ewan taq tzij chuqa' tich'ak chik:

```bash
abra app secret generate hotline.example.com ari_password bridge_secret
abra app deploy hotline.example.com
```

## Rucha'ik: Titz'ij'ij' transcription

Titz'aqatisaj ri transcription overlay (nrajo' 4 GB+ RAM):

```bash
abra app config hotline.example.com
```

Tiya':

```env
COMPOSE_FILE=compose.yml:compose.transcription.yml
WHISPER_MODEL=Systran/faster-whisper-base
WHISPER_DEVICE=cpu
```

Chuqa' tich'ak chik:

```bash
abra app deploy hotline.example.com
```

Tokisäx `WHISPER_DEVICE=cuda` we awachib'al k'o jun GPU.

## Rutz'ila'xik

```bash
abra app upgrade hotline.example.com
```

Re' nuch'ak'ij'oj' ri ruk'isanem rutz'aqat chuqa' tich'ak chik. Ri taq tzij nik'oje' pa Docker volumes chuqa' nik'oje' chuwäch taq rutz'ila'xik.

## Taq rutz'akuxik

### Backupbot rutz'akuxik

Ri rutz'aqat nuk'ul [backupbot](https://docs.coopcloud.tech/backupbot/) taq etal richin automated PostgreSQL chuqa' RustFS taq rutz'akuxik. We awachib'al samajin backupbot, ri taq rutz'akuxik nik'oje' k'o' pa ruk'u'x samaj.

### Rutz'akuxik pa q'ab'aj

Tokisäx ri tz'aqat rutz'akuxik rucholaj:

```bash
# Pa ri rutz'aqat cholaj
./pg_backup.sh <stack-name>
./pg_backup.sh <stack-name> /backups    # rutz'aqat cholaj, 7-q'ij rutz'akuxik
```

O tiya' rutz'akuxik chuxe'el:

```bash
# PostgreSQL
docker exec $(docker ps -q -f name=<stack-name>_db) \
  pg_dump -U llamenos llamenos | gzip > backup-$(date +%Y%m%d).sql.gz

# RustFS (ruk'u'x k'ayib'äl)
docker run --rm \
  -v <stack-name>_RustFS-data:/data \
  -v /backups:/backups \
  alpine tar czf /backups/RustFS-$(date +%Y%m%d).tar.gz /data
```

Titz'olïxïx PostgreSQL:

```bash
gunzip -c backup-20260101.sql.gz | \
  docker exec -i $(docker ps -q -f name=<stack-name>_db) \
  psql -U llamenos llamenos
```

## Rilob'äl

### Health checks

Konojel taq samaj k'o Docker health checks. Kek'ut rutzil:

```bash
abra app ps hotline.example.com
```

Ri app nuk'ut health endpoints:

```bash
curl https://hotline.example.com/health/ready
# {"status":"ok"}
curl https://hotline.example.com/health/live
# {"status":"ok"}
```

### Taq tz'ib'anik

```bash
# Konojel taq samaj
abra app logs hotline.example.com

# Jun samaj
abra app logs hotline.example.com app

# Katk'iy taq tz'ib'anik pa k'ak'a' samajib'äl
abra app logs -f hotline.example.com app

# Katk'iy konojel taq samaj
abra app logs -f hotline.example.com
```

## abra rucholaj rutz'ib'axik

| Cholaj | Rutz'ib'axik |
|---------|-------------|
| `abra app ps hotline.example.com` | Kek'ut taq samajin taq k'olib'äl chuqa' rutzil |
| `abra app logs [-f] hotline.example.com [samaj]` | Ketz'et (chuqa' katk'iy) taq tz'ib'anik |
| `abra app config hotline.example.com` | Tijal app ruchojmil (tijaq `$EDITOR`) |
| `abra app secret ls hotline.example.com` | Kek'ut taq ewan taq tzij chuqa' ri taq rutz'ib'axik |
| `abra app secret generate hotline.example.com [b'i'aj]` | Titz'uk jun o konojel taq ewan taq tzij |
| `abra app deploy hotline.example.com` | Tich'ak (o tich'ak chik) ri app |
| `abra app upgrade hotline.example.com` | Tich'ak ri ruk'isanem rutz'aqat chuqa' tich'ak chik |
| `abra app undeploy hotline.example.com` | Tiq'at chuqa' tiyuj ri app (taq tzij nik'oje') |
| `abra app run hotline.example.com app -- bun run ...` | Tich'ak jun jun k'ak'a' cholaj pa ri app k'olib'äl |

## Ruk'u'x samaj ruch'ak'ik

![Co-op Cloud Architecture](/diagrams/coopcloud-architecture.svg)

## Ruch'utik ruk'ayewal

### Man nisamäj ta ri app

```bash
abra app logs hotline.example.com app
abra app ps hotline.example.com
```

Kek'ut chi konojel taq ewan taq tzij tz'aqat ta:

```bash
abra app secret ls hotline.example.com
```

Saq taq ewan taq tzij nik'ut rik'in jun saq rutz'ib'axik. Titz'uk chi re':

```bash
abra app secret generate hotline.example.com
```

### Taq ruk'ayewal rik'in taq tz'ib'axik

Traefik nuch'ak'ij' TLS. Kek'ut Traefik taq tz'ib'anik pa awachib'al:

```bash
docker service logs traefik
```

Ketz'et chi ri ruk'u'x b'i'aj DNS nuya' ruk'u'x samaj chuqa' ri taq b'ey 80/443 e jaqel.

### Taq ruk'ayewal rik'in ruk'u'x tzij okem

Kek'ut chi ri app k'olib'äl okel pa PostgreSQL:

```bash
abra app run hotline.example.com app -- \
  bun -e "const { sql } = await import('bun'); await sql\`SELECT 1\`; console.log('ok')"
```

### Rutz'ila'xik ewan taq tzij

We jun ewan tzij xk'ayewal:

1. Tiya' ri rutz'ib'axik pa app ruchojmil: `abra app config hotline.example.com`
   (achike, tijal `SECRET_HMAC_SECRET_VERSION=v2`)
2. Titz'uk ri k'ak'a' ewan tzij: `abra app secret generate hotline.example.com hmac_secret`
3. Tich'ak: `abra app deploy hotline.example.com`

### WebSocket relay man nok ta

K'ak'a' samajib'äl nrajo' WebSocket relay. We awetaman taq WebSocket taq sachoj:

```bash
abra app logs hotline.example.com relay
abra app ps hotline.example.com
```

Ketz'et chi ri Nginx ruchojmil nub'än `/WebSocket` pa ri relay k'olib'äl pa b'ey 7777.

## Taq ruk'u'x samaj chik

- [Admin Guide](/docs/en/guides/?audience=operator) — ruchojmil ri hotline
- [Self-Hosting Overview](/docs/en/deploy/self-hosting) — rucha'ik taq ruch'ak'ik
- [Docker Compose deployment](/docs/en/deploy/docker) — jun chik ruch'ak'ik ruk'u'x samaj
- [Recipe repository](https://github.com/rhonda-rodododo/llamenos-template) — Co-op Cloud rutz'aqat ruk'u'x samaj
- [Co-op Cloud documentation](https://docs.coopcloud.tech/) — tiwetamaj ch'aqa' chik chi rij ri ruk'u'x samaj
