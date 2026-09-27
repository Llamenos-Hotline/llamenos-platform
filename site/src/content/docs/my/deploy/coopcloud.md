---
title: "ဖြန့်ကျက်ခြင်း: Co-op Cloud"
description: သမဝါယမအိမ်ရှင်အဖွဲ့များအတွက် Co-op Cloud recipe အဖြစ် Llamenos ကို ဖြန့်ကျက်ပါ။
---

ဤလမ်းညွှန်သည် [Co-op Cloud](https://coopcloud.tech) recipe တစ်ခုအဖြစ် Llamenos ကို ဖြန့်ကျက်ခြင်းအကြောင်း လမ်းညွှန်ပေးပါသည်။ Co-op Cloud သည် TLS အဆုံးသတ်ခြင်းအတွက် Docker Swarm နှင့် Traefik ကို အသုံးပြုပြီး စံသတ်မှတ်ထားသော အက်ပ်စီမံခန့်ခွဲမှုအတွက် `abra` CLI ကို အသုံးပြုပါသည် — ၎င်းသည် နည်းပညာသမဝါယမများနှင့် အသေးစားအိမ်ရှင်အဖွဲ့များအတွက် စံပြဖြစ်ပါသည်။

Recipe ကို [သီးခြားသိုလှောင်ရာ](https://github.com/rhonda-rodododo/llamenos-template) တွင် ထိန်းသိမ်းထားပါသည်။

## လိုအပ်ချက်များ

- [Docker Swarm](https://docs.docker.com/engine/swarm/) စတင်ထားသော ဆာဗာတစ်ခုနှင့် reverse proxy အဖြစ် [Traefik](https://doc.traefik.io/traefik/) အလုပ်လုပ်နေခြင်း
- သင့်ဒေသခံစက်တွင် [`abra` CLI](https://docs.coopcloud.tech/abra/install/) ထည့်သွင်းထားခြင်း
- သင့်ဆာဗာ၏ IP သို့ DNS ညွှန်ပြထားသော ဒိုမိန်းအမည်တစ်ခု
- ဆာဗာသို့ SSH ဝင်ရောက်ခွင့်

အကယ်၍ သင်သည် Co-op Cloud အသစ်ဖြစ်ပါက ဦးစွာ [Co-op Cloud သတ်မှတ်လမ်းညွှန်](https://docs.coopcloud.tech/intro/) ကို လိုက်နာပါ။

## အမြန်စတင်ခြင်း

```bash
# သင့်ဆာဗာကိုထည့်ပါ (မထည့်ရသေးပါက)
abra server add hotline.example.com

# Recipe ကို clone လုပ်ပါ (abra သည် ~/.abra/recipes/ တွင် recipes များကိုရှာဖွေသည်)
git clone https://github.com/rhonda-rodododo/llamenos-template.git \
  ~/.abra/recipes/llamenos

# Llamenos အက်ပ်အသစ်တစ်ခုဖန်တီးပါ
abra app new llamenos --server hotline.example.com --domain hotline.example.com

# လျှို့ဝှက်ချက်အားလုံးကိုထုတ်ပေးပါ
abra app secret generate -a hotline.example.com

# ဖြန့်ကျက်ပါ
abra app deploy hotline.example.com
```

`https://hotline.example.com` သို့သွားရောက်ပြီး သင့်အက်ဒ်မင်အကောင့်ဖန်တီးရန် သတ်မှတ်ခြင်းဝီဇာကို လိုက်နာပါ။

## အဓိကဝန်ဆောင်မှုများ

Recipe သည် ဝန်ဆောင်မှုငါးခုကို ဖြန့်ကျက်ပါသည်-

| ဝန်ဆောင်မှု | Image | ရည်ရွယ်ချက် |
|---|---|---|
| **web** | `nginx:1.27-alpine` | Traefik labels ပါရှိသော Reverse proxy |
| **app** | `ghcr.io/rhonda-rodododo/llamenos-platform` | Bun application server |
| **db** | `postgres:17-alpine` | PostgreSQL ဒေတာဘေ့စ် |
| **RustFS** | `RustFS/RustFS` | S3-compatible ဖိုင်သိုလှောင်မှု |
| **relay** | `dockurr/WebSocket relay` | အချိန်နှင့်တပြေးညီဖြစ်ရပ်များအတွက် WebSocket relay |

## လျှို့ဝှက်ချက်များ

လျှို့ဝှက်ချက်အားလုံးကို Docker Swarm secrets (ဗားရှင်းသတ်မှတ်ထားသော၊ မပြောင်းလဲနိုင်သော) မှတစ်ဆင့် စီမံပါသည်-

| လျှို့ဝှက်ချက် | အမျိုးအစား | ဖော်ပြချက် |
|---|---|---|
| `hmac_secret` | hex (64 လုံး) | session token များအတွက် HMAC လက်မှတ်သော့ |
| `server_WebSocket` | hex (64 လုံး) | ဆာဗာ WebSocket အထောက်အထားသော့ |
| `db_password` | alnum (32 လုံး) | PostgreSQL စကားဝှက် |
| `RustFS_access` | alnum (20 လုံး) | RustFS ဝင်ရောက်သော့ |
| `RustFS_secret` | alnum (40 လုံး) | RustFS လျှို့ဝှက်သော့ |

လျှို့ဝှက်ချက်အားလုံးကို တစ်ပြိုင်နက်ထုတ်ပေးရန်-

```bash
abra app secret generate -a hotline.example.com
```

သတ်မှတ်ထားသော လျှို့ဝှက်ချက်တစ်ခုကို လှည့်ရန်-

```bash
# ၁။ သင့်အက်ပ်ပြင်ဆင်မှုတွင် ဗားရှင်းကိုတင်ပါ
abra app config hotline.example.com
# SECRET_HMAC_SECRET_VERSION=v2 သို့ပြောင်းပါ

# ၂။ လျှို့ဝှက်ချက်အသစ်ကိုထုတ်ပေးပါ
abra app secret generate hotline.example.com hmac_secret

# ၃။ ပြန်လည်ဖြန့်ကျက်ပါ
abra app deploy hotline.example.com
```

## ပြင်ဆင်မှု

အက်ပ်ပြင်ဆင်မှုကို တည်းဖြတ်ပါ-

```bash
abra app config hotline.example.com
```

အဓိကဆက်တင်များ-

```env
DOMAIN=hotline.example.com
LETS_ENCRYPT_ENV=production

# အက်ပ်တွင်ပြသမည့် နာမည်
HOTLINE_NAME=My Hotline

# တယ်လီဖုန်းဝန်ဆောင်မှုပေးသူ (သတ်မှတ်ခြင်းဝီဇာပြီးနောက် ပြင်ဆင်ပါ)
# PBX_TYPE=twilio
# TWILIO_ACCOUNT_SID=
# TWILIO_AUTH_TOKEN=
# TWILIO_PHONE_NUMBER=

# သို့မဟုတ် SignalWire
# PBX_TYPE=signalwire
# SIGNALWIRE_PROJECT_ID=
# SIGNALWIRE_AUTH_TOKEN=
# SIGNALWIRE_PHONE_NUMBER=
# SIGNALWIRE_SPACE_URL=

# လျှို့ဝှက်ချက်ဗားရှင်းသတ်မှတ်ခြင်း (လှည့်ရန်တင်ပါ)
SECRET_HMAC_SECRET_VERSION=v1
SECRET_SERVER_NOSTR_VERSION=v1
SECRET_DB_PASSWORD_VERSION=v1
SECRET_STORAGE_ACCESS_VERSION=v1
SECRET_STORAGE_SECRET_VERSION=v1
```

## ပထမဆုံးအကောင့်ဝင်ခြင်း

ဖြန့်ကျက်ပြီးနောက်၊ သင့်ဒိုမိုင်းကို ဘရောက်ဆာတွင်ဖွင့်ပြီး သတ်မှတ်ခြင်းဝီဇာကို လိုက်နာပါ-

၁။ **သင့်အက်ဒ်မင်အကောင့်ကို ဖန်တီးပါ** — ပြသမည့်အမည်နှင့် သင့် PIN ကို သတ်မှတ်ပါ
၂။ **သင့်ဟော့လိုင်းကို အမည်ပေးပါ** — အက်ပ်တွင် ပြသမည့် နာမည်ကို သတ်မှတ်ပါ
၃။ **ချန်နယ်များကို ရွေးချယ်ပါ** — အသံ၊ SMS၊ WhatsApp၊ Signal နှင့်/သို့မဟုတ် အစီရင်ခံစာများကို ဖွင့်ပါ
၄။ **ဝန်ဆောင်မှုပေးသူများကို ပြင်ဆင်ပါ** — ဖွင့်ထားသော ချန်နယ်တစ်ခုစီအတွက် အထောက်အထားများကို ထည့်သွင်းပါ
၅။ **ပြန်လည်သုံးသပ်ပြီး အပြီးသတ်ပါ**

## Webhook များကို ပြင်ဆင်ပါ

သင့်တယ်လီဖုန်းဝန်ဆောင်မှုပေးသူ၏ webhook များကို သင့်ဒိုမိုင်းသို့ ညွှန်ပြပါ-

- **အသံ (ဝင်လာသော)**: `https://hotline.example.com/api/telephony/incoming`
- **အသံ (အခြေအနေ)**: `https://hotline.example.com/api/telephony/status`
- **SMS**: `https://hotline.example.com/api/messaging/sms/webhook`
- **WhatsApp**: `https://hotline.example.com/api/messaging/whatsapp/webhook`
- **Signal**: `https://hotline.example.com/api/messaging/signal/webhook` သို့ ထပ်ဆင့်ပို့ရန်တံတားကိုပြင်ဆင်ပါ

ဝန်ဆောင်မှုပေးသူအလိုက် လမ်းညွှန်များ: [Twilio](/docs/en/deploy/providers/twilio), [SignalWire](/docs/en/deploy/providers/signalwire), [Vonage](/docs/en/deploy/providers/vonage), [Plivo](/docs/en/deploy/providers/plivo) တို့ကိုကြည့်ပါ။

## ထည့်သွင်းစရာ: Signal sidecar ဖွင့်ခြင်း

Signal မက်ဆေ့ချ်ပို့ခြင်းအတွက် ([Signal သတ်မှတ်ခြင်း](/docs/en/deploy/providers/signal) တွင်ကြည့်ပါ):

```bash
abra app config hotline.example.com
```

သတ်မှတ်ပါ-

```env
COMPOSE_FILE=compose.yml:compose.signal.yml
SECRET_SIGNAL_NOTIFIER_TOKEN_VERSION=v1
```

ထပ်ဆောင်းလျှို့ဝှက်ချက်ကိုထုတ်ပေးပြီး ပြန်လည်ဖြန့်ကျက်ပါ-

```bash
abra app secret generate hotline.example.com signal_notifier_token
abra app deploy hotline.example.com
```

## ထည့်သွင်းစရာ: SIP တံတားဖွင့်ခြင်း

ကိုယ်တိုင်အိမ်ရှင် SIP တယ်လီဖုန်းအတွက် Asterisk၊ FreeSWITCH သို့မဟုတ် Kamailio မှတစ်ဆင့်:

```bash
abra app config hotline.example.com
```

သတ်မှတ်ပါ-

```env
COMPOSE_FILE=compose.yml:compose.telephony.yml
PBX_TYPE=asterisk
SECRET_ARI_PASSWORD_VERSION=v1
SECRET_BRIDGE_SECRET_VERSION=v1
```

ထပ်ဆောင်းလျှို့ဝှက်ချက်များကိုထုတ်ပေးပြီး ပြန်လည်ဖြန့်ကျက်ပါ-

```bash
abra app secret generate hotline.example.com ari_password bridge_secret
abra app deploy hotline.example.com
```

## ထည့်သွင်းစရာ: စာသားမှတ်တမ်းပြောင်းခြင်းဖွင့်ခြင်း

စာသားမှတ်တမ်းပြောင်းခြင်းအပေါ်လွှာကိုထည့်ပါ (RAM 4 GB+ လိုအပ်သည်):

```bash
abra app config hotline.example.com
```

သတ်မှတ်ပါ-

```env
COMPOSE_FILE=compose.yml:compose.transcription.yml
WHISPER_MODEL=Systran/faster-whisper-base
WHISPER_DEVICE=cpu
```

ထို့နောက် ပြန်လည်ဖြန့်ကျက်ပါ-

```bash
abra app deploy hotline.example.com
```

သင့်ဆာဗာတွင် GPU ရှိပါက `WHISPER_DEVICE=cuda` ကိုသုံးပါ။

## အပ်ဒိတ်လုပ်ခြင်း

```bash
abra app upgrade hotline.example.com
```

၎င်းသည် နောက်ဆုံး recipe ဗားရှင်းကိုဆွဲယူပြီး ပြန်လည်ဖြန့်ကျက်ပါသည်။ ဒေတာကို Docker volumes များတွင် ဆက်လက်သိမ်းဆည်းထားပြီး အဆင့်မြှင့်တင်မှုများကို ကျော်လွန်၍ တည်ရှိနေပါသည်။

## အရန်သိမ်းခြင်း

### Backupbot ပေါင်းစည်းခြင်း

Recipe တွင် အလိုအလျောက် PostgreSQL နှင့် RustFS အရန်သိမ်းခြင်းများအတွက် [backupbot](https://docs.coopcloud.tech/backupbot/) labels များပါဝင်ပါသည်။ သင့်ဆာဗာတွင် backupbot အလုပ်လုပ်နေပါက အရန်သိမ်းခြင်းများသည် အလိုအလျောက်ဖြစ်ပါသည်။

### ကိုယ်တိုင်အရန်သိမ်းခြင်း

ပါဝင်သော အရန်သိမ်း script ကိုသုံးပါ-

```bash
# Recipe လမ်းညွှန်မှ
./pg_backup.sh <stack-name>
./pg_backup.sh <stack-name> /backups    # စိတ်ကြိုက်လမ်းညွှန်၊ ၇ ရက်ကြာ ထိန်းသိမ်းမှု
```

သို့မဟုတ် တိုက်ရိုက်အရန်သိမ်းပါ-

```bash
# PostgreSQL
docker exec $(docker ps -q -f name=<stack-name>_db) \
  pg_dump -U llamenos llamenos | gzip > backup-$(date +%Y%m%d).sql.gz

# RustFS (object သိုလှောင်မှု)
docker run --rm \
  -v <stack-name>_RustFS-data:/data \
  -v /backups:/backups \
  alpine tar czf /backups/RustFS-$(date +%Y%m%d).tar.gz /data
```

PostgreSQL ပြန်လည်ထည့်သွင်းရန်:

```bash
gunzip -c backup-20260101.sql.gz | \
  docker exec -i $(docker ps -q -f name=<stack-name>_db) \
  psql -U llamenos llamenos
```

## စောင့်ကြည့်ခြင်း

### ကျန်းမာရေးစစ်ဆေးချက်များ

ဝန်ဆောင်မှုအားလုံးတွင် Docker ကျန်းမာရေးစစ်ဆေးချက်များရှိပါသည်။ အခြေအနေကိုစစ်ဆေးပါ-

```bash
abra app ps hotline.example.com
```

အက်ပ်သည် ကျန်းမာရေးအဆုံးမှတ်များကိုထုတ်ဖော်ပါသည်-

```bash
curl https://hotline.example.com/health/ready
# {"status":"ok"}
curl https://hotline.example.com/health/live
# {"status":"ok"}
```

### Log များ

```bash
# ဝန်ဆောင်မှုအားလုံး
abra app logs hotline.example.com

# သတ်မှတ်ထားသော ဝန်ဆောင်မှု
abra app logs hotline.example.com app

# Log များကိုအချိန်နှင့်တပြေးညီလိုက်ကြည့်ပါ
abra app logs -f hotline.example.com app

# ဝန်ဆောင်မှုအားလုံးကိုလိုက်ကြည့်ပါ
abra app logs -f hotline.example.com
```

## abra command ကိုးကားချက်

| Command | ဖော်ပြချက် |
|---|---|
| `abra app ps hotline.example.com` | အလုပ်လုပ်နေသော container များနှင့် ကျန်းမာရေးကိုပြသပါ |
| `abra app logs [-f] hotline.example.com [service]` | Log များကြည့်ပါ (နှင့်လိုက်ကြည့်ပါ) |
| `abra app config hotline.example.com` | အက်ပ်ပြင်ဆင်မှုကိုတည်းဖြတ်ပါ (`$EDITOR` ကိုဖွင့်ပါ) |
| `abra app secret ls hotline.example.com` | လျှို့ဝှက်ချက်များနှင့် ၎င်းတို့၏ဗားရှင်းများကိုစာရင်းပြပါ |
| `abra app secret generate hotline.example.com [name]` | လျှို့ဝှက်ချက်တစ်ခု သို့မဟုတ် အားလုံးကိုထုတ်ပေးပါ |
| `abra app deploy hotline.example.com` | အက်ပ်ကိုဖြန့်ကျက်ပါ (သို့မဟုတ် ပြန်လည်ဖြန့်ကျက်ပါ) |
| `abra app upgrade hotline.example.com` | နောက်ဆုံး recipe ကိုဆွဲယူပြီး ပြန်လည်ဖြန့်ကျက်ပါ |
| `abra app undeploy hotline.example.com` | အက်ပ်ကိုရပ်ပြီးဖယ်ရှားပါ (ဒေတာကိုထိန်းသိမ်းပါ) |
| `abra app run hotline.example.com app -- bun run ...` | အက်ပ် container တွင် တစ်ကြိမ်သုံး command တစ်ခုလုပ်ဆောင်ပါ |

## ဝန်ဆောင်မှုဗိသုကာ

![Co-op Cloud Architecture](/diagrams/coopcloud-architecture.svg)

## ပြဿနာဖြေရှင်းခြင်း

### အက်ပ်မစတင်နိုင်ခြင်း

```bash
abra app logs hotline.example.com app
abra app ps hotline.example.com
```

လျှို့ဝှက်ချက်အားလုံးထုတ်ပေးထားကြောင်း စစ်ဆေးပါ-

```bash
abra app secret ls hotline.example.com
```

ဗားရှင်းအလွတ်ဖြင့် ပျောက်ဆုံးနေသော လျှို့ဝှက်ချက်များပေါ်လာပါသည်။ ၎င်းတို့ကိုထုတ်ပေးပါ-

```bash
abra app secret generate hotline.example.com
```

### လက်မှတ်ပြဿနာများ

Traefik သည် TLS ကိုကိုင်တွယ်ပါသည်။ သင့်ဆာဗာရှိ Traefik log များကိုစစ်ဆေးပါ-

```bash
docker service logs traefik
```

သင့်ဒိုမိုင်း၏ DNS သည် ဆာဗာသို့ညွှန်ပြပြီး port 80/443 ဖွင့်ထားကြောင်း သေချာပါစေ။

### ဒေတာဘေ့စ်ချိတ်ဆက်မှုအမှားများ

အက်ပ် container သည် PostgreSQL သို့ရောက်ရှိနိုင်ကြောင်းစစ်ဆေးပါ-

```bash
abra app run hotline.example.com app -- \
  bun -e "const { sql } = await import('bun'); await sql\`SELECT 1\`; console.log('ok')"
```

### လျှို့ဝှက်ချက်လှည့်ခြင်း

လျှို့ဝှက်ချက်တစ်ခုအပေးအယူခံရပါက:

၁။ အက်ပ်ပြင်ဆင်မှုတွင် ဗားရှင်းကိုတင်ပါ: `abra app config hotline.example.com`
   (ဥပမာ `SECRET_HMAC_SECRET_VERSION=v2` သို့ပြောင်းပါ)
၂။ လျှို့ဝှက်ချက်အသစ်ကိုထုတ်ပေးပါ: `abra app secret generate hotline.example.com hmac_secret`
၃။ ပြန်လည်ဖြန့်ကျက်ပါ: `abra app deploy hotline.example.com`

### WebSocket relay မချိတ်ဆက်နိုင်ခြင်း

အချိန်နှင့်တပြေးညီဖြစ်ရပ်များအတွက် WebSocket relay လိုအပ်ပါသည်။ WebSocket အမှားများတွေ့ပါက:

```bash
abra app logs hotline.example.com relay
abra app ps hotline.example.com
```

Nginx config သည် `/WebSocket` ကို port 7777 ရှိ relay container သို့လမ်းကြောင်းပေးကြောင်း အတည်ပြုပါ။

## နောက်အဆင့်များ

- [အက်ဒ်မင်လမ်းညွှန်](/docs/en/guides/?audience=operator) — ဟော့လိုင်းကိုပြင်ဆင်ပါ
- [ကိုယ်တိုင်အိမ်ရှင် ခြုံငုံသုံးသပ်ချက်](/docs/en/deploy/self-hosting) — ဖြန့်ကျက်ရွေးချယ်စရာများကို နှိုင်းယှဉ်ပါ
- [Docker Compose ဖြန့်ကျက်ခြင်း](/docs/en/deploy/docker) — အခြားရွေးချယ်စရာ ဆာဗာတစ်လုံးတည်းဖြန့်ကျက်ခြင်း
- [Recipe သိုလှောင်ရာ](https://github.com/rhonda-rodododo/llamenos-template) — Co-op Cloud recipe အရင်းအမြစ်
- [Co-op Cloud စာရွက်စာတမ်း](https://docs.coopcloud.tech/) — ပလက်ဖောင်းအကြောင်းပိုမိုလေ့လာပါ
