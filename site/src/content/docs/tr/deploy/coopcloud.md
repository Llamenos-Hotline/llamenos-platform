---
title: "Dağıtım: Co-op Cloud"
description: Llamenos'u kooperatif barındırma kolektifleri için Co-op Cloud tarifi olarak dağıtın.
---

Bu kılavuz, Llamenos'u bir [Co-op Cloud](https://coopcloud.tech) tarifi olarak dağıtma sürecinde size yol gösterir. Co-op Cloud, TLS sonlandırma için Traefik ile Docker Swarm ve standartlaştırılmış uygulama yönetimi için `abra` CLI'yi kullanır — teknoloji kooperatifleri ve küçük barındırma kolektifleri için idealdir.

Tarif, [bağımsız bir depoda](https://github.com/rhonda-rodododo/llamenos-template) tutulur.

## Ön koşullar

- Ters proxy olarak [Traefik](https://doc.traefik.io/traefik/) çalıştıran, başlatılmış [Docker Swarm](https://docs.docker.com/engine/swarm/) ile bir sunucu
- Yerel makinenizde kurulu [`abra` CLI](https://docs.coopcloud.tech/abra/install/)
- Sunucunuzun IP'sine işaret eden bir alan adı
- Sunucuya SSH erişimi

Co-op Cloud'a yeniyseniz, önce [Co-op Cloud kurulum kılavuzunu](https://docs.coopcloud.tech/intro/) takip edin.

## Hızlı başlangıç

```bash
# Sunucunuzu ekleyin (henüz eklenmediyse)
abra server add hotline.example.com

# Tarifi klonlayın (abra tarifleri ~/.abra/recipes/ dizininde arar)
git clone https://github.com/rhonda-rodododo/llamenos-template.git \
  ~/.abra/recipes/llamenos

# Yeni bir Llamenos uygulaması oluşturun
abra app new llamenos --server hotline.example.com --domain hotline.example.com

# Tüm sırları oluşturun
abra app secret generate -a hotline.example.com

# Dağıtın
abra app deploy hotline.example.com
```

`https://hotline.example.com` adresini ziyaret edin ve yönetici hesabınızı oluşturmak için kurulum sihirbazını takip edin.

## Temel hizmetler

Tarif beş hizmet dağıtır:

| Hizmet | İmaj | Amaç |
|---------|-------|---------|
| **web** | `nginx:1.27-alpine` | Traefik etiketleri ile ters proxy |
| **app** | `ghcr.io/rhonda-rodododo/llamenos-platform` | Bun uygulama sunucusu |
| **db** | `postgres:17-alpine` | PostgreSQL veritabanı |
| **RustFS** | `RustFS/RustFS` | S3-uyumlu dosya depolama |
| **relay** | `dockurr/WebSocket relay` | Gerçek zamanlı olaylar için WebSocket rölesi |

## Sırlar

Tüm sırlar Docker Swarm sırları aracılığıyla yönetilir (sürümlü, değiştirilemez):

| Sır | Tür | Açıklama |
|--------|------|-------------|
| `hmac_secret` | onaltılık (64 karakter) | Oturum belirteçleri için HMAC imzalama anahtarı |
| `server_WebSocket` | onaltılık (64 karakter) | Sunucu WebSocket kimlik anahtarı |
| `db_password` | alfanümerik (32 karakter) | PostgreSQL parolası |
| `RustFS_access` | alfanümerik (20 karakter) | RustFS erişim anahtarı |
| `RustFS_secret` | alfanümerik (40 karakter) | RustFS gizli anahtarı |

Tüm sırları bir kerede oluşturun:

```bash
abra app secret generate -a hotline.example.com
```

Belirli bir sırrı döndürmek için:

```bash
# 1. Uygulama yapılandırmanızda sürümü artırın
abra app config hotline.example.com
# SECRET_HMAC_SECRET_VERSION=v2 olarak değiştirin

# 2. Yeni sırrı oluşturun
abra app secret generate hotline.example.com hmac_secret

# 3. Yeniden dağıtın
abra app deploy hotline.example.com
```

## Yapılandırma

Uygulama yapılandırmasını düzenleyin:

```bash
abra app config hotline.example.com
```

Anahtar ayarlar:

```env
DOMAIN=hotline.example.com
LETS_ENCRYPT_ENV=production

# Uygulamada gösterilen görünen ad
HOTLINE_NAME=My Hotline

# Telefon sağlayıcısı (kurulum sihirbazından sonra yapılandırın)
# PBX_TYPE=twilio
# TWILIO_ACCOUNT_SID=
# TWILIO_AUTH_TOKEN=
# TWILIO_PHONE_NUMBER=

# Veya SignalWire
# PBX_TYPE=signalwire
# SIGNALWIRE_PROJECT_ID=
# SIGNALWIRE_AUTH_TOKEN=
# SIGNALWIRE_PHONE_NUMBER=
# SIGNALWIRE_SPACE_URL=

# Sır sürümlendirme (döndürmek için artırın)
SECRET_HMAC_SECRET_VERSION=v1
SECRET_SERVER_NOSTR_VERSION=v1
SECRET_DB_PASSWORD_VERSION=v1
SECRET_STORAGE_ACCESS_VERSION=v1
SECRET_STORAGE_SECRET_VERSION=v1
```

## İlk giriş

Dağıtımdan sonra, tarayıcınızda alan adınızı açın ve kurulum sihirbazını takip edin:

1. **Yönetici hesabınızı oluşturun** — görünen bir ad ve PIN'inizi ayarlayın
2. **Yardım hattınıza bir ad verin** — uygulamada gösterilen görünen adı ayarlayın
3. **Kanalları seçin** — Ses, SMS, WhatsApp, Signal ve/veya Raporları etkinleştirin
4. **Sağlayıcıları yapılandırın** — her etkin kanal için kimlik bilgilerini girin
5. **Gözden geçirin ve bitirin**

## Webhook'ları yapılandırma

Telefon sağlayıcınızın webhook'larını alan adınıza yönlendirin:

- **Ses (gelen)**: `https://hotline.example.com/api/telephony/incoming`
- **Ses (durum)**: `https://hotline.example.com/api/telephony/status`
- **SMS**: `https://hotline.example.com/api/messaging/sms/webhook`
- **WhatsApp**: `https://hotline.example.com/api/messaging/whatsapp/webhook`
- **Signal**: `https://hotline.example.com/api/messaging/signal/webhook` adresine yönlendirmek için köprüyü yapılandırın

Sağlayıcıya özel kılavuzlar için: [Twilio](/docs/en/deploy/providers/twilio), [SignalWire](/docs/en/deploy/providers/signalwire), [Vonage](/docs/en/deploy/providers/vonage), [Plivo](/docs/en/deploy/providers/plivo).

## İsteğe bağlı: Signal yan hizmetini etkinleştir

Signal mesajlaşma için ([Signal kurulumu](/docs/en/deploy/providers/signal)):

```bash
abra app config hotline.example.com
```

Ayarlayın:

```env
COMPOSE_FILE=compose.yml:compose.signal.yml
SECRET_SIGNAL_NOTIFIER_TOKEN_VERSION=v1
```

Ek sırrı oluşturun ve yeniden dağıtın:

```bash
abra app secret generate hotline.example.com signal_notifier_token
abra app deploy hotline.example.com
```

## İsteğe bağlı: SIP köprüsünü etkinleştir

Asterisk, FreeSWITCH veya Kamailio aracılığıyla kendi sunucunuzda barındırılan SIP telefonu için:

```bash
abra app config hotline.example.com
```

Ayarlayın:

```env
COMPOSE_FILE=compose.yml:compose.telephony.yml
PBX_TYPE=asterisk
SECRET_ARI_PASSWORD_VERSION=v1
SECRET_BRIDGE_SECRET_VERSION=v1
```

Ek sırları oluşturun ve yeniden dağıtın:

```bash
abra app secret generate hotline.example.com ari_password bridge_secret
abra app deploy hotline.example.com
```

## İsteğe bağlı: Transkripsiyonu etkinleştir

Transkripsiyon katmanını ekleyin (4 GB+ RAM gerektirir):

```bash
abra app config hotline.example.com
```

Ayarlayın:

```env
COMPOSE_FILE=compose.yml:compose.transcription.yml
WHISPER_MODEL=Systran/faster-whisper-base
WHISPER_DEVICE=cpu
```

Ardından yeniden dağıtın:

```bash
abra app deploy hotline.example.com
```

Sunucunuzda bir GPU varsa `WHISPER_DEVICE=cuda` kullanın.

## Güncelleme

```bash
abra app upgrade hotline.example.com
```

Bu, en son tarif sürümünü çeker ve yeniden dağıtır. Veriler Docker birimlerinde kalıcıdır ve yükseltmelerden sağ kalır.

## Yedeklemeler

### Backupbot entegrasyonu

Tarif, otomatik PostgreSQL ve RustFS yedeklemeleri için [backupbot](https://docs.coopcloud.tech/backupbot/) etiketlerini içerir. Sunucunuz backupbot çalıştırıyorsa, yedeklemeler otomatik olarak gerçekleşir.

### Manuel yedekleme

Dahil edilen yedekleme betiğini kullanın:

```bash
# Tarif dizininden
./pg_backup.sh <stack-name>
./pg_backup.sh <stack-name> /backups    # özel dizin, 7 günlük saklama
```

Veya doğrudan yedekleyin:

```bash
# PostgreSQL
docker exec $(docker ps -q -f name=<stack-name>_db) \
  pg_dump -U llamenos llamenos | gzip > backup-$(date +%Y%m%d).sql.gz

# RustFS (nesne depolama)
docker run --rm \
  -v <stack-name>_RustFS-data:/data \
  -v /backups:/backups \
  alpine tar czf /backups/RustFS-$(date +%Y%m%d).tar.gz /data
```

PostgreSQL'i geri yükleyin:

```bash
gunzip -c backup-20260101.sql.gz | \
  docker exec -i $(docker ps -q -f name=<stack-name>_db) \
  psql -U llamenos llamenos
```

## İzleme

### Sağlık kontrolleri

Tüm hizmetlerin Docker sağlık kontrolleri vardır. Durumu kontrol edin:

```bash
abra app ps hotline.example.com
```

Uygulama sağlık uç noktalarını sunar:

```bash
curl https://hotline.example.com/health/ready
# {"status":"ok"}
curl https://hotline.example.com/health/live
# {"status":"ok"}
```

### Günlükler

```bash
# Tüm hizmetler
abra app logs hotline.example.com

# Belirli hizmet
abra app logs hotline.example.com app

# Gerçek zamanlı olarak günlükleri takip edin
abra app logs -f hotline.example.com app

# Tüm hizmetleri takip edin
abra app logs -f hotline.example.com
```

## abra komut referansı

| Komut | Açıklama |
|---------|-------------|
| `abra app ps hotline.example.com` | Çalışan konteynerleri ve sağlığı göster |
| `abra app logs [-f] hotline.example.com [service]` | Günlükleri görüntüle (ve takip et) |
| `abra app config hotline.example.com` | Uygulama yapılandırmasını düzenle (`$EDITOR` açar) |
| `abra app secret ls hotline.example.com` | Sırları ve sürümlerini listele |
| `abra app secret generate hotline.example.com [name]` | Bir veya tüm sırları oluştur |
| `abra app deploy hotline.example.com` | Uygulamayı dağıt (veya yeniden dağıt) |
| `abra app upgrade hotline.example.com` | En son tarifi çek ve yeniden dağıt |
| `abra app undeploy hotline.example.com` | Uygulamayı durdur ve kaldır (veriler korunur) |
| `abra app run hotline.example.com app -- bun run ...` | Uygulama konteynerinde tek seferlik bir komut çalıştır |

## Hizmet mimarisi

![Co-op Cloud Mimarisi](/diagrams/coopcloud-architecture.svg)

## Sorun giderme

### Uygulama başlamıyor

```bash
abra app logs hotline.example.com app
abra app ps hotline.example.com
```

Tüm sırların oluşturulduğunu kontrol edin:

```bash
abra app secret ls hotline.example.com
```

Eksik sırlar boş bir sürümle görünür. Bunları oluşturun:

```bash
abra app secret generate hotline.example.com
```

### Sertifika sorunları

Traefik TLS'yi yönetir. Sunucunuzdaki Traefik günlüklerini kontrol edin:

```bash
docker service logs traefik
```

Alan adınızın DNS'sinin sunucuyu çözdüğünden ve 80/443 numaralı bağlantı noktalarının açık olduğundan emin olun.

### Veritabanı bağlantı hataları

Uygulama konteynerinin PostgreSQL'e ulaşabildiğini kontrol edin:

```bash
abra app run hotline.example.com app -- \
  bun -e "const { sql } = await import('bun'); await sql\`SELECT 1\`; console.log('ok')"
```

### Sır döndürme

Bir sır ele geçirilirse:

1. Uygulama yapılandırmasında sürümü artırın: `abra app config hotline.example.com`
   (örn. `SECRET_HMAC_SECRET_VERSION=v2` olarak değiştirin)
2. Yeni sırrı oluşturun: `abra app secret generate hotline.example.com hmac_secret`
3. Yeniden dağıtın: `abra app deploy hotline.example.com`

### WebSocket rölesi bağlanmıyor

Gerçek zamanlı olaylar WebSocket rölesi gerektirir. WebSocket hataları görürseniz:

```bash
abra app logs hotline.example.com relay
abra app ps hotline.example.com
```

Nginx yapılandırmasının `/WebSocket`'i 7777 numaralı bağlantı noktasındaki röle konteynerine yönlendirdiğini doğrulayın.

## Sonraki adımlar

- [Yönetici Kılavuzu](/docs/en/guides/?audience=operator) — yardım hattını yapılandırın
- [Kendi Sunucunuzda Barındırma Genel Bakış](/docs/en/deploy/self-hosting) — dağıtım seçeneklerini karşılaştırın
- [Docker Compose dağıtımı](/docs/en/deploy/docker) — alternatif tek sunucu dağıtımı
- [Tarif deposu](https://github.com/rhonda-rodododo/llamenos-template) — Co-op Cloud tarif kaynağı
- [Co-op Cloud dokümantasyonu](https://docs.coopcloud.tech/) — platform hakkında daha fazla bilgi edinin
