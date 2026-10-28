---
title: شروع کار
description: خط تلفن Llámenos خود را در چند دقیقه مستقر کنید.
---

یک خط تلفن Llámenos را به صورت محلی یا روی یک سرور راه‌اندازی کنید. فقط Docker مورد نیاز است — بدون Node.js، Bun یا سایر زمان‌های اجرا روی میزبان.

## چگونه کار می‌کند

وقتی کسی با شماره خط تلفن شما تماس می‌گیرد، Llámenos تماس را به طور همزمان به همه کاربران شیفت فعال مسیریابی می‌کند. اولین کاربری که پاسخ دهد متصل می‌شود و بقیه از زنگ خوردن بازمی‌ایستند. پس از پایان تماس، کاربر می‌تواند یادداشت‌های رمزنگاری‌شده درباره مکالمه ذخیره کند.

![مسیریابی تماس](/diagrams/call-routing.svg)

همین مسیریابی برای SMS، WhatsApp، Signal و سایر کانال‌های پیام‌رسانی اعمال می‌شود — آنها در یک نمای **مکالمات** یکپارچه ظاهر می‌شوند.

## پیش‌نیازها

- [Docker](https://docs.docker.com/get-docker/) با Docker Compose v2
- `openssl` (از قبل روی بیشتر سیستم‌های لینوکس و macOS نصب شده است)
- Git

## شروع سریع

```bash
git clone https://github.com/rhonda-rodododo/llamenos-platform.git
cd llamenos-platform
./scripts/docker-setup.sh
```

این همه رازهای مورد نیاز را تولید می‌کند، برنامه را می‌سازد و سرویس‌ها را شروع می‌کند. پس از اتمام، به **http://localhost:8000** مراجعه کرده و جادوگر راه‌اندازی را دنبال کنید:

1. **حساب مدیر خود را ایجاد کنید** — یک نام نمایشی و PIN خود را تنظیم کنید
2. **نام خط تلفن خود را تعیین کنید** — نام نمایشی که در برنامه نشان داده می‌شود را تنظیم کنید
3. **انتخاب کانال‌ها** — صدا، SMS، WhatsApp، Signal و/یا گزارش‌ها را فعال کنید
4. **پیکربندی ارائه‌دهندگان** — اعتبارنامه‌های هر کانال فعال را وارد کنید
5. **مرور و پایان**

## استقرار تولید

برای یک سرور با دامنه واقعی و TLS خودکار:

```bash
./scripts/docker-setup.sh --domain hotline.yourorg.com --email admin@yourorg.com
```

Caddy به طور خودکار گواهینامه‌های TLS Let's Encrypt را تأمین می‌کند. مطمئن شوید پورت‌های ۸۰ و ۴۴۳ باز هستند. پرچم `--domain` روکش Docker Compose تولید را فعال می‌کند که TLS، چرخش لاگ و محدودیت‌های منابع را اضافه می‌کند.

برای جزئیات کامل درباره سخت‌افزاری سرور، پشتیبان‌گیری، نظارت و سرویس‌های اختیاری، به [راهنمای استقرار Docker Compose](/docs/en/deploy/docker) مراجعه کنید.

## سرویس‌های اصلی

راه‌اندازی Docker این سرویس‌های اصلی را شروع می‌کند:

| سرویس | هدف | پورت |
|---|---|---|
| **app** | برنامه Llámenos (Bun) | ۳۰۰۰ (داخلی) |
| **postgres** | پایگاه داده PostgreSQL | ۵۴۳۲ (داخلی) |
| **caddy** | پروکسی معکوس + TLS خودکار | ۸۰۰۰ (محلی)، ۸۰/۴۴۳ (تولید) |
| **RustFS** | ذخیره‌سازی فایل سازگار با S3 | ۹۰۰۰ (داخلی) |
| **رله WebSocket** | رله WebSocket برای رویدادهای بلادرنگ | ۷۷۷۷ (داخلی) |

پروفایل‌های اختیاری اضافه می‌کنند: sidecar signal-notifier، پل SIP (Asterisk/FreeSWITCH/Kamailio)، استنتاج Ollama/vLLM، نظارت Prometheus.

## بررسی‌های سلامت

برنامه دو نقطه پایانی سلامت را ارائه می‌دهد که توسط بررسی‌های سلامت Docker و کاوشگرهای Kubernetes استفاده می‌شوند:

- `GET /health/ready` — ۲۰۰ را زمانی برمی‌گرداند که برنامه آماده ارائه ترافیک است (DB متصل، مهاجرت‌ها اعمال شده)
- `GET /health/live` — ۲۰۰ را زمانی برمی‌گرداند که فرآیند برنامه زنده است

## پیکربندی webhook

پس از استقرار، webhookهای ارائه‌دهنده تلفنی خود را به آدرس استقرار خود指向 کنید:

| Webhook | URL |
|---|---|
| صدا (ورودی) | `https://your-domain/api/telephony/incoming` |
| صدا (وضعیت) | `https://your-domain/api/telephony/status` |
| SMS | `https://your-domain/api/messaging/sms/webhook` |
| WhatsApp | `https://your-domain/api/messaging/whatsapp/webhook` |
| Signal | ارسال به `https://your-domain/api/messaging/signal/webhook` |

برای راه‌اندازی خاص ارائه‌دهنده: [Twilio](/docs/en/deploy/providers/twilio)، [SignalWire](/docs/en/deploy/providers/signalwire)، [Vonage](/docs/en/deploy/providers/vonage)، [Plivo](/docs/en/deploy/providers/plivo)، [Asterisk](/docs/en/deploy/providers/asterisk)، [SMS](/docs/en/deploy/providers/sms)، [WhatsApp](/docs/en/deploy/providers/whatsapp)، [Signal](/docs/en/deploy/providers/signal).

## مراحل بعدی

- [استقرار Docker Compose](/docs/en/deploy/docker) — راهنمای کامل استقرار تولید با پشتیبان‌گیری و نظارت
- [استقرار Kubernetes](/docs/en/deploy/kubernetes) — استقرار با Helm
- [استقرار Co-op Cloud](/docs/en/deploy/coopcloud) — استقرار برای مجموعه‌های میزبانی تعاونی
- [ارائه‌دهندگان تلفنی](/docs/en/deploy/providers/) — مقایسه ارائه‌دهندگان صوتی
- [نمای کلی میزبانی شخصی](/docs/en/deploy/self-hosting) — مقایسه همه گزینه‌های استقرار
