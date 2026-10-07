---
title: Sorun Giderme
description: Dağıtım, masaüstü uygulaması, mobil uygulama, telefon ve şifreleme işlemlerindeki yaygın sorunların çözümleri.
---

Bu kılavuz, tüm Llamenos dağıtım modları ve platformlarındaki yaygın sorunları ve çözümlerini kapsar.

## Docker dağıtım sorunları

### Konteynerler başlamıyor

**Eksik ortam değişkenleri:**

Docker Compose, başlangıçta tüm servisleri doğrular, profilli olanlar bile. Eksik değişkenlerle ilgili hatalar görürseniz, `.env` dosyanızın tüm gerekli değerleri içerdiğinden emin olun:

```bash
# .env dosyasında gerekli olanlar
PG_PASSWORD=your_postgres_password
STORAGE_ACCESS_KEY=your_rustfs_access_key
STORAGE_SECRET_KEY=your_rustfs_secret_key
HMAC_SECRET=your_hmac_secret
ARI_PASSWORD=your_ari_password       # Asterisk kullanmasanız bile gerekli
BRIDGE_SECRET=your_bridge_secret     # Asterisk kullanmasanız bile gerekli
ADMIN_PUBKEY=your_admin_hex_pubkey
```

Asterisk köprüsünü kullanmasanız bile, Docker Compose servis tanımını doğrular ve `ARI_PASSWORD` ile `BRIDGE_SECRET` ayarlarının yapılmış olmasını gerektirir.

**Port çakışmaları:**

Bir port zaten kullanımdaysa, hangi işlemin onu tuttuğunu kontrol edin:

```bash
# Port 8787'yi (Worker) kullananı kontrol et
sudo lsof -i :8787

# Port 5432'yi (PostgreSQL) kullananı kontrol et
sudo lsof -i :5432

# Port 9000'ı (RustFS) kullananı kontrol et
sudo lsof -i :9000
```

Çakışan işlemi durdurun veya `docker-compose.yml` içinde port eşlemesini değiştirin.

### Veritabanı bağlantı hataları

Uygulama PostgreSQL'e bağlanamıyorsa:

- `.env` dosyasındaki `PG_PASSWORD` ile konteyner ilk oluşturulurken kullanılan şifrenin eşleştiğini doğrulayın
- PostgreSQL konteynerinin sağlıklı olduğunu kontrol edin: `docker compose ps`
- Şifre değiştirildiyse, birimi kaldırıp yeniden oluşturmanız gerekebilir: `docker compose down -v && docker compose up -d`

### Strfry relay bağlanmıyor

WebSocket relay temel bir servistir, isteğe bağlı değildir. Relay çalışmıyorsa:

```bash
# Relay durumunu kontrol et
docker compose logs WebSocket relay

# Relay'i yeniden başlat
docker compose restart WebSocket relay
```

Relay başlatılamazsa, port 7777 çakışmalarını veya veri dizini üzerindeki yetersiz izinleri kontrol edin.

### RustFS / S3 depolama hataları

- `STORAGE_ACCESS_KEY` ve `STORAGE_SECRET_KEY` değerlerinin doğru olduğunu doğrulayın
- RustFS konteynerinin çalıştığını kontrol edin: `docker compose ps rustfs`
- RustFS konsoluna `http://localhost:9001` adresinden erişerek kova oluşturmayı doğrulayın

## Cloudflare dağıtım sorunları

### Durable Object hataları

**"Durable Object bulunamadı" veya bağlama hataları:**

- DO bağlamalarının doğru olduğundan emin olmak için `bun run deploy` çalıştırın (doğrudan `wrangler deploy` asla kullanmayın)
- `wrangler.jsonc` dosyasındaki DO sınıf adlarını ve bağlamalarını kontrol edin
- Yeni bir DO eklendikten sonra, kullanılabilir olmadan önce dağıtım yapmanız gerekir

**DO depolama limitleri:**

Cloudflare Durable Objects, anahtar-değer çifti başına 128 KB limiti vardır. Depolama hataları görürseniz:

- Not içeriğinin limiti aşmadığından emin olun (çok sayıda eklenti içeren çok büyük notlar)
- ECIES zarfının çoğaltılmadığını kontrol edin

### Worker hataları (500 yanıtları)

Worker günlüklerini kontrol edin:

```bash
bunx wrangler tail
```

Yaygın nedenler:
- Eksik sırlar (doğrulamak için `bunx wrangler secret list` kullanın)
- Yanlış `ADMIN_PUBKEY` formatı (64 onaltılık karakter olmalı, `npub` öneki olmamalı)
- Ücretsiz katmanda hız sınırlaması (Workers Free'de dakikada 1.000 istek)

### "Pages deploy" hatalarıyla dağıtım başarısız oluyor

`wrangler pages deploy` veya `wrangler deploy` komutlarını asla doğrudan çalıştırmayın. Her zaman kök `package.json` betiklerini kullanın:

```bash
bun run deploy          # Her şeyi dağıt (uygulama + pazarlama sitesi)
bun run deploy:site     # Sadece pazarlama sitesini dağıt
```

`wrangler pages deploy dist` komutunu yanlış dizinden çalıştırmak, Vite uygulama derlemesini Pages'e Astro sitesi yerine dağıtır ve pazarlama sitesini 404 hatalarıyla bozar.

## Masaüstü uygulaması sorunları

### Otomatik güncelleme çalışmıyor

Masaüstü uygulaması, yeni sürümleri kontrol etmek için Tauri güncelleyicisini kullanır. Güncellemeler algılanmıyorsa:

- İnternet bağlantınızı kontrol edin
- Güncelleme uç noktasının erişilebilir olduğunu doğrulayın: `https://github.com/rhonda-rodododo/llamenos-platform/releases/latest/download/latest.json`
- Linux'ta, AppImage otomatik güncelleme için dosyanın bulunduğu dizinde yazma izinlerine sahip olmasını gerektirir
- macOS'ta, uygulama `/Applications` içinde olmalıdır (doğrudan DMG'den çalıştırılmamalı)

Manuel güncelleme için, [İndir](/download) sayfasından en son sürümü indirin.

### PIN kilidi açılmıyor

PIN'iniz masaüstü uygulamasında reddedilirse:

- Doğru PIN'i girdiğinizden emin olun ("PIN'i unuttum" kurtarma seçeneği yoktur)
- PIN'ler harf içeriyorsa büyük-küçük harfe duyarlıdır
- PIN'inizi unuttuysanız, yeni bir PIN belirlemek için nsec'inizi yeniden girmeniz gerekir. Şifreli notlarınız kimliğinize bağlı olduğu için, PIN'inize değil, erişilebilir kalırlar
- Tauri Stronghold, nsec'inizi PIN'den türetilen anahtarla (PBKDF2) şifreler. Yanlış PIN geçersiz bir şifre çözme üretir — hata mesajı vermez — uygulama, türetilen açık anahtarı doğrulayarak bunu tespit eder

### Anahtar kurtarma

Cihazınıza erişiminizi kaybettiyseniz:

1. Yeni bir cihazda giriş yapmak için nsec'inizi (şifre yöneticinizde saklamış olmanız gereken) kullanın
2. Bir WebAuthn passkey kaydettirdiyseniz, bunun yerine yeni cihazda kullanabilirsiniz
3. Şifreli notlarınız sunucu tarafında saklanır — aynı kimlikle giriş yaptıktan sonra bunları şifre çözebilirsiniz
4. Hem nsec'inizi hem de passkey'inizi kaybettiyseniz, yöneticinizle iletişime geçin. Nsec'inizi kurtaramazlar, ancak sizin için yeni bir kimlik oluşturabilirler. Eski kimliğiniz için şifrelenmiş notlar artık sizin tarafınızdan okunamaz

### Uygulama başlamıyor (boş pencere)

- Sisteminizin minimum gereksinimleri karşıladığını kontrol edin (bkz. [İndir](/download))
- Linux'ta, WebKitGTK'nin kurulu olduğundan emin olun: `sudo apt install libwebkit2gtk-4.1-0` (Debian/Ubuntu) veya eşdeğeri
- Uçbirimden başlatarak hata çıktısını görmeyi deneyin: `./llamenos` (AppImage) veya sistem günlüklerini kontrol edin
- Wayland kullanıyorsanız, `GDK_BACKEND=x11` ile geri dönüş olarak deneyin

### Tek örnek çakışması

Llamenos tek örnek modunu zorunlu kılar. Uygulama zaten çalışıyor diyor ancak pencereyi bulamıyorsanız:

- Arka plan işlemlerini kontrol edin: `ps aux | grep llamenos`
- Yetim işlemleri sonlandırın: `pkill llamenos`
- Linux'ta, uygulama çöktüyse eski bir kilit dosyası olup olmadığını kontrol edin ve kaldırın

## Mobil uygulama sorunları

### Hazırlık/üyelik açma başarısızlıkları

Ayrıntılı hazırlık sorun giderme için [Mobil Kılavuz](/docs/mobile-guide#troubleshooting-mobile-issues) sayfasına bakın.

Yaygın nedenler:
- Süresi dolmuş QR kodu (tokenlar 5 dakika sonra geçersiz olur)
- Her iki cihazda da internet bağlantısı yok
- Masaüstü uygulaması ve mobil uygulama farklı protokol sürümleri çalıştırıyor

### Push bildirimleri gelmiyor

- İşletim sistemi ayarlarında bildirim izinlerinin verildiğini doğrulayın
- Android'de, pil optimizasyonunun uygulamayı arka planda sonlandırmadığını kontrol edin
- iOS'ta, Llamenos için Arka Plan Uygulama Yenileme'nin etkin olduğunu doğrulayın
- Aktif bir vardiyanız olduğunu ve molada olmadığınızı kontrol edin

## Telefon sorunları

### Twilio webhook yapılandırması

Çağrılar gönüllülere yönlendirilmiyorsa:

1. Twilio konsolunda webhook URL'lerinizin doğru olduğunu doğrulayın:
   - Ses webhook: `https://your-worker.your-domain.com/telephony/incoming` (POST)
   - Durum geri çağrısı: `https://your-worker.your-domain.com/telephony/status` (POST)
2. Ayarlarınızdaki Twilio kimlik bilgilerinin konsol ile eşleştiğini kontrol edin:
   - Hesap SID
   - Auth Token
   - Telefon numarası (ülke kodu içermeli, örn. `+1234567890`)
3. Twilio hata ayıklayıcısını kontrol edin: [twilio.com/console/debugger](https://www.twilio.com/console/debugger)

### Numara kurulumu

- Telefon numarası Twilio'ya ait bir numara veya doğrulanmış bir arayan kimliği olmalıdır
- Yerel geliştirme için, yerel Worker'ınızı Twilio'ya açmak için Cloudflare Tunnel veya ngrok kullanın
- Numaranın Ses yapılandırmasının varsayılan TwiML Bin yerine webhook URL'nize işaret ettiğini doğrulayın

### Çağrılar bağlanıyor ancak ses yok

- Telefon sağlayıcısının medya sunucularının gönüllünün telefonuna ulaşabildiğinden emin olun
- RTP trafiğini engelleyen NAT/güvenlik duvarı sorunlarını kontrol edin
- WebRTC kullanıyorsanız, STUN/TURN sunucularının doğru yapılandırıldığını doğrulayın
- Bazı VPN'ler VoIP trafiğini engeller — VPN olmadan deneyin

### SMS/WhatsApp mesajları gelmiyor

- Mesajlaşma webhook URL'lerinin sağlayıcınızın konsolunda doğru yapılandırıldığını doğrulayın
- WhatsApp için, Meta webhook doğrulama tokeninin ayarlarınızla eşleştiğinden emin olun
- Mesajlaşma kanalının **Yönetici Ayarları > Kanallar** bölümünde etkin olduğunu kontrol edin
- Signal için, signal-cli köprüsünün çalıştığını ve webhook'unuza iletecek şekilde yapılandırıldığını doğrulayın

## Kripto hataları

### Anahtar uyumsuzluğu hataları

**Notları açarken "Şifre çözme başarısız" veya "Geçersiz anahtar":**

- Bu genellikle notun, giriş yaptığınız kimlikten farklı bir kimlik için şifrelendiği anlamına gelir
- Doğru nsec'i kullandığınızı doğrulayın (Ayarlar'daki npub'unuzun yöneticinin gördüğüyle eşleştiğini kontrol edin)
- Yakın zamanda kimliğinizi yeniden oluşturduysanız, önceki açık anahtarınız için şifrelenmiş eski notlar yeni anahtarla şifre çözülemez

**Girişte "Geçersiz imza":**

- Nsec bozulmuş olabilir — şifre yöneticinizden yeniden girmeyi deneyin
- Tam nsec'in yapıştırıldığından emin olun (`nsec1` ile başlar, toplam 63 karakter)
- Ekstra boşluk veya yeni satır karakterlerini kontrol edin

### İmza doğrulama başarısızlıkları

Hub olayları imza doğrulamasından geçemezse:

- Sistem saatinin senkronize olduğunu kontrol edin (NTP). Büyük saat sapması, olay zaman damgalarıyla sorunlara neden olabilir
- WebSocket relay'nin bilinmeyen pubkeys'ten olayları iletmediğini doğrulayın
- Uygulamayı yeniden başlatarak mevcut hub üye listesini yeniden alın

### ECIES zarf hataları

**Not şifre çözme sırasında "Anahtar açma başarısız":**

- ECIES zarfı yanlış açık anahtarla oluşturulmuş olabilir
- Bu, yöneticinin pubkeye yazım hatasıyla bir gönüllü eklediğinde olabilir
- Yönetici, gönüllünün açık anahtarını doğrulamalı ve gerekirse yeniden davet etmelidir

**"Geçersiz şifreli metin uzunluğu":**

- Bu, muhtemelen kısaltılmış bir ağ yanıtından kaynaklanan veri bozulmasını gösterir
- İşlemi yeniden deneyin. Devam ederse, şifreli veri kalıcı olarak bozulmuş olabilir
- Yanıt gövdelerini kısaltabilecek proxy veya CDN sorunlarını kontrol edin

### Hub anahtarı hataları

**"Hub olayını şifre çözme başarısız":**

- Hub anahtarı, son bağlantınızdan bu yana döndürülmüş olabilir
- En son hub anahtarını almak için uygulamayı kapatıp yeniden açın
- Yakın zamanda hub'dan çıkarılıp yeniden eklendiyseniz, anahtar yokluğunuz sırasında döndürülmüş olabilir

## Yardım alma

Sorununuz burada kapsanmıyorsa:

- Bilinen hatalar ve geçici çözümler için [GitHub Issues](https://github.com/rhonda-rodododo/llamenos-platform/issues) sayfasını kontrol edin
- Yeni bir sorun oluşturmadan önce mevcut sorunları arayın
- Bir hata bildirirken şunları ekleyin: dağıtım modunuz (Cloudflare/Docker/Kubernetes), platformunuz (Masaüstü/Mobil) ve tarayıcı konsolundan veya uçbirimden aldığınız hata mesajları
