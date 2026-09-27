---
title: "استقرار: Co-op Cloud"
description: Llámenos را به عنوان یک دستورالعمل Co-op Cloud برای مجموعه‌های میزبانی تعاونی مستقر کنید.
---

این راهنما شما را در استقرار Llámenos به عنوان یک دستورالعمل [Co-op Cloud](https://coopcloud.tech) راهنمایی می‌کند. Co-op Cloud از Docker Swarm با Traefik برای خاتمه TLS و CLI `abra` برای مدیریت استاندارد برنامه استفاده می‌کند — ایده‌آل برای تعاونی‌های فناوری و مجموعه‌های کوچک میزبانی.

دستورالعمل در یک [مخزن مستقل](https://github.com/rhonda-rodododo/llamenos-template) نگهداری می‌شود.

## پیش‌نیازها

- یک سرور با [Docker Swarm](https://docs.docker.com/engine/swarm/) راه‌اندازی شده و [Traefik](https://doc.traefik.io/traefik/) به عنوان پروکسی معکوس در حال اجرا
- [`abra` CLI](https://docs.coopcloud.tech/abra/install/) روی ماشین محلی شما نصب شده است
- یک نام دامنه با DNS指向 آدرس IP سرور شما
- دسترسی SSH به سرور

اگر در Co-op Cloud تازه‌کار هستید، ابتدا [راهنمای راه‌اندازی Co-op Cloud](https://docs.coopcloud.tech/intro/) را دنبال کنید.

## شروع سریع

```bash
# سرور خود را اضافه کنید (اگر قبلاً اضافه نشده است)
abra server add hotline.example.com

# مخزن دستورالعمل را کلون کنید (abra دستورالعمل‌ها را در ~/.abra/recipes/ جستجو می‌کند)
git clone https://github.com/rhonda-rodododo/llamenos-template.git \
  ~/.abra/recipes/llamenos

# یک برنامه Llámenos جدید ایجاد کنید
abra app new llamenos --server hotline.example.com --domain hotline.example.com

# همه رازها را تولید کنید
abra app secret generate -a hotline.example.com

# استقرار
abra app deploy hotline.example.com
```

به `https://hotline.example.com` مراجعه کرده و جادوگر راه‌اندازی را برای ایجاد حساب مدیر خود دنبال کنید.

## سرویس‌های اصلی

دستورالعمل پنج سرویس را مستقر می‌کند:

| سرویس | تصویر | هدف |
|---|---|---|
| **web** | `nginx:1.27-alpine` | پروکسی معکوس با برچسب‌های Traefik |
| **app** | `ghcr.io/rhonda-rodododo/llamenos-platform` | سرور برنامه Bun |
| **db** | `postgres:17-alpine` | پایگاه داده PostgreSQL |
| **RustFS** | `RustFS/RustFS` | ذخیره‌سازی فایل سازگار با S3 |
| **relay** | `dockurr/WebSocket relay` | رله WebSocket برای رویدادهای بلادرنگ |

## رازها

همه رازها از طریق رازهای Docker Swarm مدیریت می‌شوند (نسخه‌بندی شده، تغییرناپذیر):

| راز | نوع | توضیحات |
|---|---|---|
| `hmac_secret` | hex (۶۴ کاراکتر) | کلید امضای HMAC برای توکن‌های جلسه |
| `server_WebSocket` | hex (۶۴ کاراکتر) | کلید هویت WebSocket سرور |
| `db_password` | alnum (۳۲ کاراکتر) | رمز عبور PostgreSQL |
| `RustFS_access` | alnum (۲۰ کاراکتر) | کلید دسترسی RustFS |
| `RustFS_secret` | alnum (۴۰ کاراکتر) | کلید مخفی RustFS |

همه رازها را یکجا تولید کنید:

```bash
abra app secret generate -a hotline.example.com
```

برای چرخش یک راز خاص:

```bash
# ۱. نسخه را در پیکربندی برنامه خود افزایش دهید
abra app config hotline.example.com
# تغییر SECRET_HMAC_SECRET_VERSION=v2

# ۲. راز جدید را تولید کنید
abra app secret generate hotline.example.com hmac_secret

# ۳. دوباره استقرار دهید
abra app deploy hotline.example.com
```

## پیکربندی

پیکربندی برنامه را ویرایش کنید:

```bash
abra app config hotline.example.com
```

تنظیمات کلیدی:

```env
DOMAIN=hotline.example.com
LETS_ENCRYPT_ENV=production

# نام نمایشی که در برنامه نشان داده می‌شود
HOTLINE_NAME=خط تلفن من

# ارائه‌دهنده تلفنی (پس از جادوگر راه‌اندازی پیکربندی کنید)
# PBX_TYPE=twilio
# TWILIO_ACCOUNT_SID=
# TWILIO_AUTH_TOKEN=
# TWILIO_PHONE_NUMBER=

# یا SignalWire
# PBX_TYPE=signalwire
# SIGNALWIRE_PROJECT_ID=
# SIGNALWIRE_AUTH_TOKEN=
# SIGNALWIRE_PHONE_NUMBER=
# SIGNALWIRE_SPACE_URL=

# نسخه‌بندی راز (برای چرخش افزایش دهید)
SECRET_HMAC_SECRET_VERSION=v1
SECRET_SERVER_NOSTR_VERSION=v1
SECRET_DB_PASSWORD_VERSION=v1
SECRET_STORAGE_ACCESS_VERSION=v1
SECRET_STORAGE_SECRET_VERSION=v1
```

## اولین ورود

پس از استقرار، دامنه خود را در مرورگر باز کنید و جادوگر راه‌اندازی را دنبال کنید:

1. **حساب مدیر خود را ایجاد کنید** — یک نام نمایشی و PIN خود را تنظیم کنید
2. **نام خط تلفن خود را تعیین کنید** — نام نمایشی که در برنامه نشان داده می‌شود را تنظیم کنید
3. **انتخاب کانال‌ها** — صدا، SMS، WhatsApp، Signal و/یا گزارش‌ها را فعال کنید
4. **پیکربندی ارائه‌دهندگان** — اعتبارنامه‌های هر کانال فعال را وارد کنید
5. **مرور و پایان**

## پیکربندی webhook

webhookهای ارائه‌دهنده تلفنی خود را به دامنه خود指向 کنید:

- **صدا (ورودی)**: `https://hotline.example.com/api/telephony/incoming`
- **صدا (وضعیت)**: `https://hotline.example.com/api/telephony/status`
- **SMS**: `https://hotline.example.com/api/messaging/sms/webhook`
- **WhatsApp**: `https://hotline.example.com/api/messaging/whatsapp/webhook`
- **Signal**: پل را برای ارسال به `https://hotline.example.com/api/messaging/signal/webhook` پیکربندی کنید

راهنماهای خاص ارائه‌دهنده را ببینید: [Twilio](/docs/en/deploy/providers/twilio)، [SignalWire](/docs/en/deploy/providers/signalwire)، [Vonage](/docs/en/deploy/providers/vonage)، [Plivo](/docs/en/deploy/providers/plivo).

## اختیاری: فعال‌سازی سایدکار Signal

برای پیام‌رسانی Signal (به [راه‌اندازی Signal](/docs/en/deploy/providers/signal) مراجعه کنید):

```bash
abra app config hotline.example.com
```

تنظیم کنید:

```env
COMPOSE_FILE=compose.yml:compose.signal.yml
SECRET_SIGNAL_NOTIFIER_TOKEN_VERSION=v1
```

راز اضافی را تولید کرده و دوباره استقرار دهید:

```bash
abra app secret generate hotline.example.com signal_notifier_token
abra app deploy hotline.example.com
```

## اختیاری: فعال‌سازی پل SIP

برای تلفن SIP میزبانی شخصی از طریق Asterisk، FreeSWITCH یا Kamailio:

```bash
abra app config hotline.example.com
```

تنظیم کنید:

```env
COMPOSE_FILE=compose.yml:compose.telephony.yml
PBX_TYPE=asterisk
SECRET_ARI_PASSWORD_VERSION=v1
SECRET_BRIDGE_SECRET_VERSION=v1
```

رازهای اضافی را تولید کرده و دوباره استقرار دهید:

```bash
abra app secret generate hotline.example.com ari_password bridge_secret
abra app deploy hotline.example.com
```

## اختیاری: فعال‌سازی رونویسی

روکش رونویسی را اضافه کنید (نیاز به ۴ گیگابایت + RAM):

```bash
abra app config hotline.example.com
```

تنظیم کنید:

```env
COMPOSE_FILE=compose.yml:compose.transcription.yml
WHISPER_MODEL=Systran/faster-whisper-base
WHISPER_DEVICE=cpu
```

سپس دوباره استقرار دهید:

```bash
abra app deploy hotline.example.com
```

اگر سرور شما GPU دارد از `WHISPER_DEVICE=cuda` استفاده کنید.

## به‌روزرسانی

```bash
abra app upgrade hotline.example.com
```

این آخرین نسخه دستورالعمل را دریافت کرده و دوباره استقرار می‌دهد. داده‌ها در حجم‌های Docker نگهداری می‌شوند و در ارتقاها باقی می‌مانند.

## پشتیبان‌گیری

### یکپارچه‌سازی backupbot

دستورالعمل شامل برچسب‌های [backupbot](https://docs.coopcloud.tech/backupbot/) برای پشتیبان‌گیری خودکار PostgreSQL و RustFS است. اگر سرور شما backupbot را اجرا می‌کند، پشتیبان‌گیری به طور خودکار انجام می‌شود.

### پشتیبان‌گیری دستی

از اسکریپت پشتیبان‌گیری موجود استفاده کنید:

```bash
# از دایرکتوری دستورالعمل
./pg_backup.sh <stack-name>
./pg_backup.sh <stack-name> /backups    # دایرکتوری سفارشی، نگهداری ۷ روزه
```

یا مستقیماً پشتیبان‌گیری کنید:

```bash
# PostgreSQL
docker exec $(docker ps -q -f name=<stack-name>_db) \
  pg_dump -U llamenos llamenos | gzip > backup-$(date +%Y%m%d).sql.gz

# RustFS (ذخیره‌سازی اشیاء)
docker run --rm \
  -v <stack-name>_RustFS-data:/data \
  -v /backups:/backups \
  alpine tar czf /backups/RustFS-$(date +%Y%m%d).tar.gz /data
```

بازیابی PostgreSQL:

```bash
gunzip -c backup-20260101.sql.gz | \
  docker exec -i $(docker ps -q -f name=<stack-name>_db) \
  psql -U llamenos llamenos
```

## نظارت

### بررسی‌های سلامت

همه سرویس‌ها بررسی‌های سلامت Docker دارند. وضعیت را بررسی کنید:

```bash
abra app ps hotline.example.com
```

برنامه نقاط پایانی سلامت را ارائه می‌دهد:

```bash
curl https://hotline.example.com/health/ready
# {"status":"ok"}
curl https://hotline.example.com/health/live
# {"status":"ok"}
```

### لاگ‌ها

```bash
# همه سرویس‌ها
abra app logs hotline.example.com

# سرویس خاص
abra app logs hotline.example.com app

# دنبال کردن لاگ‌ها به صورت بلادرنگ
abra app logs -f hotline.example.com app

# دنبال کردن همه سرویس‌ها
abra app logs -f hotline.example.com
```

## مرجع دستورات abra

| دستور | توضیحات |
|---|---|
| `abra app ps hotline.example.com` | نمایش کانتینرهای در حال اجرا و سلامت |
| `abra app logs [-f] hotline.example.com [service]` | مشاهده (و دنبال کردن) لاگ‌ها |
| `abra app config hotline.example.com` | ویرایش پیکربندی برنامه (باز می‌کند `$EDITOR`) |
| `abra app secret ls hotline.example.com` | فهرست رازها و نسخه‌های آنها |
| `abra app secret generate hotline.example.com [name]` | تولید یک یا همه رازها |
| `abra app deploy hotline.example.com` | استقرار (یا استقرار مجدد) برنامه |
| `abra app upgrade hotline.example.com` | دریافت آخرین دستورالعمل و استقرار مجدد |
| `abra app undeploy hotline.example.com` | توقف و حذف برنامه (داده‌ها حفظ می‌شوند) |
| `abra app run hotline.example.com app -- bun run ...` | اجرای یک دستور یکباره در کانتینر برنامه |

## معماری سرویس

![معماری Co-op Cloud](/diagrams/coopcloud-architecture.svg)

## عیب‌یابی

### برنامه شروع نمی‌شود

```bash
abra app logs hotline.example.com app
abra app ps hotline.example.com
```

بررسی کنید همه رازها تولید شده‌اند:

```bash
abra app secret ls hotline.example.com
```

رازهای گمشده با یک نسخه خالی ظاهر می‌شوند. آنها را تولید کنید:

```bash
abra app secret generate hotline.example.com
```

### مشکلات گواهینامه

Traefik TLS را مدیریت می‌کند. لاگ‌های Traefik را روی سرور خود بررسی کنید:

```bash
docker service logs traefik
```

اطمینان حاصل کنید DNS دامنه شما به سرور و پورت‌های ۸۰/۴۴۳ باز هستند.

### خطاهای اتصال پایگاه داده

بررسی کنید کانتینر برنامه می‌تواند به PostgreSQL برسد:

```bash
abra app run hotline.example.com app -- \
  bun -e "const { sql } = await import('bun'); await sql\`SELECT 1\`; console.log('ok')"
```

### چرخش راز

اگر یک راز به خطر بیفتد:

1. نسخه را در پیکربندی برنامه افزایش دهید: `abra app config hotline.example.com`
   (مثلاً تغییر `SECRET_HMAC_SECRET_VERSION=v2`)
2. راز جدید را تولید کنید: `abra app secret generate hotline.example.com hmac_secret`
3. دوباره استقرار دهید: `abra app deploy hotline.example.com`

### رله WebSocket متصل نمی‌شود

رویدادهای بلادرنگ به رله WebSocket نیاز دارند. اگر خطاهای WebSocket می‌بینید:

```bash
abra app logs hotline.example.com relay
abra app ps hotline.example.com
```

تأیید کنید پیکربندی Nginx مسیر `/WebSocket` را به کانتینر رله در پورت ۷۷۷۷ مسیریابی می‌کند.

## مراحل بعدی

- [راهنمای مدیر](/docs/en/guides/?audience=operator) — پیکربندی خط تلفن
- [نمای کلی میزبانی شخصی](/docs/en/deploy/self-hosting) — مقایسه گزینه‌های استقرار
- [استقرار Docker Compose](/docs/en/deploy/docker) — جایگزین استقرار تک سرور
- [مخزن دستورالعمل](https://github.com/rhonda-rodododo/llamenos-template) — منبع دستورالعمل Co-op Cloud
- [مستندات Co-op Cloud](https://docs.coopcloud.tech/) — اطلاعات بیشتر درباره پلتفرم
