---
title: Başlangıç
description: Kendi Llamenos yardım hattınızı dakikalar içinde dağıtın.
---

Llamenos yardım hattınızı yerel olarak veya bir sunucuda çalıştırın. Yalnızca Docker gereklidir — ana bilgisayarda Node.js, Bun veya başka bir çalışma zamanına gerek yoktur.

## Nasıl çalışır

Birisi yardım hattı numaranızı aradığında, Llamenos çağrıyı aynı anda tüm vardiyadaki kullanıcılara yönlendirir. İlk yanıtlayan bağlanır ve diğerlerinin çalması durur. Çağrı bittikten sonra, kullanıcı konuşma hakkında şifrelenmiş notlar kaydedebilir.

![Çağrı Yönlendirme](/diagrams/call-routing.svg)

Aynı yönlendirme SMS, WhatsApp, Signal ve diğer mesajlaşma kanalları için de geçerlidir — bunlar birleşik bir **Konuşmalar** görünümünde görünür.

## Ön koşullar

- [Docker](https://docs.docker.com/get-docker/) ve Docker Compose v2
- `openssl` (çoğu Linux ve macOS sisteminde önceden yüklenmiş)
- Git

## Hızlı başlangıç

```bash
git clone https://github.com/rhonda-rodododo/llamenos-platform.git
cd llamenos-platform
./scripts/docker-setup.sh
```

Bu, tüm gerekli gizli anahtarları oluşturur, uygulamayı derler ve hizmetleri başlatır. Tamamlandığında **http://localhost:8000** adresini ziyaret edin ve kurulum sihirbazını takip edin:

1. **Yönetici hesabınızı oluşturun** — görünen bir ad ve PIN'inizi ayarlayın
2. **Yardım hattınıza bir ad verin** — uygulamada gösterilen görünen adı ayarlayın
3. **Kanalları seçin** — Ses, SMS, WhatsApp, Signal ve/veya Raporları etkinleştirin
4. **Sağlayıcıları yapılandırın** — her etkin kanal için kimlik bilgilerini girin
5. **Gözden geçirin ve bitirin**

## Üretim dağıtımı

Gerçek bir alan adı ve otomatik TLS ile bir sunucu için:

```bash
./scripts/docker-setup.sh --domain hotline.yourorg.com --email admin@yourorg.com
```

Caddy otomatik olarak Let's Encrypt TLS sertifikaları sağlar. 80 ve 443 numaralı bağlantı noktalarının açık olduğundan emin olun. `--domain` bayrağı, üretim Docker Compose katmanını etkinleştirir; bu, TLS, günlük döndürme ve kaynak limitleri ekler.

Sunucu sertleştirme, yedeklemeler, izleme ve isteğe bağlı hizmetler hakkında tüm ayrıntılar için [Docker Compose dağıtım kılavuzuna](/docs/en/deploy/docker) bakın.

## Temel hizmetler

Docker kurulumu şu temel hizmetleri başlatır:

| Hizmet | Amaç | Bağlantı Noktası |
|---------|---------|------|
| **app** | Llamenos uygulaması (Bun) | 3000 (dahili) |
| **postgres** | PostgreSQL veritabanı | 5432 (dahili) |
| **caddy** | Ters proxy + otomatik TLS | 8000 (yerel), 80/443 (üretim) |
| **RustFS** | S3-uyumlu dosya depolama | 9000 (dahili) |
| **WebSocket relay** | Gerçek zamanlı olaylar için WebSocket rölesi | 7777 (dahili) |

İsteğe bağlı profiller şunları ekler: signal-notifier yan hizmeti, sip-bridge (Asterisk/FreeSWITCH/Kamailio), Ollama/vLLM çıkarımı, Prometheus izleme.

## Sağlık kontrolleri

Uygulama, Docker sağlık kontrolleri ve Kubernetes prob'ları tarafından kullanılan iki sağlık uç noktası sunar:

- `GET /health/ready` — uygulama trafiğe hazır olduğunda 200 döndürür (DB bağlı, göçler uygulandı)
- `GET /health/live` — uygulama süreci canlı olduğunda 200 döndürür

## Webhook'ları yapılandırma

Dağıttıktan sonra, telefon sağlayıcınızın webhook'larını dağıtım URL'nize yönlendirin:

| Webhook | URL |
|---------|-----|
| Ses (gelen) | `https://your-domain/api/telephony/incoming` |
| Ses (durum) | `https://your-domain/api/telephony/status` |
| SMS | `https://your-domain/api/messaging/sms/webhook` |
| WhatsApp | `https://your-domain/api/messaging/whatsapp/webhook` |
| Signal | `https://your-domain/api/messaging/signal/webhook` adresine yönlendirin |

Sağlayıcıya özel kurulum için: [Twilio](/docs/en/deploy/providers/twilio), [SignalWire](/docs/en/deploy/providers/signalwire), [Vonage](/docs/en/deploy/providers/vonage), [Plivo](/docs/en/deploy/providers/plivo), [Asterisk](/docs/en/deploy/providers/asterisk), [SMS](/docs/en/deploy/providers/sms), [WhatsApp](/docs/en/deploy/providers/whatsapp), [Signal](/docs/en/deploy/providers/signal).

## Sonraki adımlar

- [Docker Compose Dağıtımı](/docs/en/deploy/docker) — yedeklemeler ve izleme ile tam üretim dağıtım kılavuzu
- [Kubernetes Dağıtımı](/docs/en/deploy/kubernetes) — Helm ile dağıtım
- [Co-op Cloud Dağıtımı](/docs/en/deploy/coopcloud) — kooperatif barındırma kolektifleri için dağıtım
- [Telefon Sağlayıcıları](/docs/en/deploy/providers/) — ses sağlayıcılarını karşılaştırın
- [Kendi Sunucunuzda Barındırma Genel Bakış](/docs/en/deploy/self-hosting) — tüm dağıtım seçeneklerini karşılaştırın
