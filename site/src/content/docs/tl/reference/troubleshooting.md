---
title: Troubleshooting
description: Mga solusyon para sa mga karaniwang isyu sa deployment, desktop app, mobile app, telephony, at cryptographic operations.
---

Saklaw ng gabay na ito ang mga karaniwang isyu at ang kanilang mga solusyon sa lahat ng Llamenos deployment mode at platform.

## Mga isyu sa Docker deployment

### Hindi nagsisimula ang mga container

**Mga kulang na environment variable:**

Vine-validate ng Docker Compose ang lahat ng serbisyo sa startup, pati ang mga may profile. Kung may nakikita kang error tungkol sa mga kulang na variable, siguraduhing ang iyong `.env` file ay may lahat ng kinakailangang value:

```bash
# Kinakailangan sa .env para sa Docker Compose
PG_PASSWORD=your_postgres_password
STORAGE_ACCESS_KEY=your_rustfs_access_key
STORAGE_SECRET_KEY=your_rustfs_secret_key
HMAC_SECRET=your_hmac_secret
ARI_PASSWORD=your_ari_password       # Kinakailangan kahit hindi gumagamit ng Asterisk
BRIDGE_SECRET=your_bridge_secret     # Kinakailangan kahit hindi gumagamit ng Asterisk
ADMIN_PUBKEY=your_admin_hex_pubkey
```

Kahit hindi mo ginagamit ang Asterisk bridge, vine-validate ng Docker Compose ang service definition nito at kinakailangan na nakatakda ang `ARI_PASSWORD` at `BRIDGE_SECRET`.

**Mga port conflict:**

Kung may ginagamit nang port, suriin kung anong proseso ang gumagamit nito:

```bash
sudo lsof -i :8787
sudo lsof -i :5432
sudo lsof -i :9000
```

Ihinto ang conflicting process o palitan ang port mapping sa `docker-compose.yml`.

### Mga error sa database connection

Kung hindi makakonekta ang app sa PostgreSQL:

- I-verify na ang `PG_PASSWORD` sa `.env` ay tugma sa ginamit noong unang ginawa ang container
- Suriin kung healthy ang PostgreSQL container: `docker compose ps`
- Kung binago ang password, maaaring kailangan mong tanggalin ang volume at gawing muli: `docker compose down -v && docker compose up -d`

### Hindi kumokonekta ang Strfry relay

Ang WebSocket relay ay isang core service, hindi opsyonal. Kung hindi tumatakbo ang relay:

```bash
docker compose logs WebSocket relay
docker compose restart WebSocket relay
```

Kung nabigo ang pagsisimula ng relay, suriin ang port 7777 conflicts o kakulangan ng permissions sa data directory.

### Mga error sa RustFS / S3 storage

- I-verify na tama ang `STORAGE_ACCESS_KEY` at `STORAGE_SECRET_KEY`
- Suriin kung tumatakbo ang RustFS container: `docker compose ps rustfs`
- I-access ang RustFS console sa `http://localhost:9001` para i-verify ang bucket creation

## Mga isyu sa Cloudflare deployment

### Mga Durable Object error

**"Durable Object not found" o mga binding error:**

- Patakbuhin ang `bun run deploy` (huwag kailanman `wrangler deploy` nang direkta)
- Suriin ang `wrangler.jsonc` para sa tamang DO class names at bindings
- Pagkatapos magdagdag ng bagong DO, kailangan mong mag-deploy bago ito maging available

**Mga limitasyon sa DO storage:**

Ang Cloudflare Durable Objects ay may 128 KB na limitasyon bawat key-value pair. Kung may nakikita kang storage error:

- Siguraduhing hindi lumalampas sa limitasyon ang content ng note
- Suriin na hindi nagdo-duplicate ang ECIES envelopes

### Mga Worker error (500 response)

```bash
bunx wrangler tail
```

Mga karaniwang sanhi:
- Mga kulang na secret (gamitin ang `bunx wrangler secret list` para i-verify)
- Maling format ng `ADMIN_PUBKEY` (kailangang 64 na hex characters, walang `npub` prefix)
- Rate limiting sa free tier (1,000 requests/minute sa Workers Free)

### Nabigo ang deployment na may "Pages deploy" error

Huwag kailanman patakbuhin ang `wrangler pages deploy` o `wrangler deploy` nang direkta. Palaging gamitin ang mga script sa root `package.json`:

```bash
bun run deploy
bun run deploy:site
```

## Mga isyu sa desktop app

### Hindi gumagana ang auto-update

- Suriin ang iyong internet connection
- I-verify na maabot ang update endpoint: `https://github.com/rhonda-rodododo/llamenos-platform/releases/latest/download/latest.json`
- Sa Linux, nangangailangan ang AppImage auto-update ng write permissions sa directory nito
- Sa macOS, kailangang nasa `/Applications` ang app

Para manual na mag-update, i-download ang pinakabagong release mula sa [Download](/download) page.

### Nabigo ang PIN unlock

- Siguraduhing tama ang inilalagay mong PIN (walang "forgot PIN" recovery)
- Case-sensitive ang mga PIN kung may mga letra
- Kung nakalimutan mo ang iyong PIN, kailangan mong muling ilagay ang iyong nsec para magtakda ng bago
- Ine-encrypt ng Tauri Stronghold ang iyong nsec gamit ang PIN-derived key (PBKDF2). Ang maling PIN ay gumagawa ng invalid na decryption — dine-detect ng app ito sa pamamagitan ng pag-verify ng derived public key

### Key recovery

1. Gamitin ang iyong nsec mula sa password manager para mag-login sa bagong device
2. Kung nag-register ka ng WebAuthn passkey, magagamit mo ito sa bagong device
3. Ang mga naka-encrypt na nota ay naka-store sa server-side — maide-decrypt mo ang mga ito kapag nag-login ka gamit ang parehong identity
4. Kung nawala ang nsec at passkey, makipag-ugnay sa iyong admin para sa bagong identity

### Hindi nagsisimula ang app (blangkong window)

- Suriin ang minimum na mga kinakailangan (tingnan ang [Download](/download))
- Sa Linux: `sudo apt install libwebkit2gtk-4.1-0`
- Subukang i-launch mula sa terminal: `./llamenos`
- Kung gumagamit ng Wayland: `GDK_BACKEND=x11`

### Single instance conflict

- Suriin ang mga background process: `ps aux | grep llamenos`
- Patayin ang mga orphaned process: `pkill llamenos`

## Mga isyu sa mobile app

### Mga pagkabigo sa provisioning

Tingnan ang [Gabay sa Mobile](/docs/mobile-guide#troubleshooting-ng-mga-isyu-sa-mobile) para sa mga detalye.

### Hindi dumarating ang push notifications

- I-verify ang notification permissions sa OS settings
- Sa Android, suriin ang battery optimization
- Sa iOS, i-enable ang Background App Refresh
- Suriin na may aktibong shift ka

## Mga isyu sa telephony

### Twilio webhook configuration

1. I-verify ang webhook URLs sa Twilio console
2. Suriin ang Twilio credentials sa iyong settings
3. Suriin ang Twilio debugger: [twilio.com/console/debugger](https://www.twilio.com/console/debugger)

### Kumokonekta ang tawag pero walang audio

- Suriin ang NAT/firewall para sa RTP traffic
- Kung gumagamit ng WebRTC, i-verify ang STUN/TURN servers
- May ilang VPN na nagba-block ng VoIP traffic

### Hindi dumarating ang SMS/WhatsApp messages

- I-verify ang messaging webhook URLs
- Para sa WhatsApp, suriin ang Meta webhook verification token
- Suriin na naka-enable ang messaging channel sa **Admin Settings > Channels**

## Mga crypto error

### Mga key mismatch error

**"Failed to decrypt" o "Invalid key":**

- Ang nota ay naka-encrypt para sa ibang identity
- I-verify ang iyong nsec (suriin ang npub sa Settings)
- Ang mga lumang nota para sa dating public key ay hindi maide-decrypt gamit ang bagong key

**"Invalid signature" sa pag-login:**

- Subukang muling ilagay ang nsec mula sa password manager
- Siguraduhing buo ang nsec (nagsisimula sa `nsec1`, 63 characters)

### Mga ECIES envelope error

**"Failed to unwrap key":** Maaaring ginawa ang ECIES envelope gamit ang maling public key. I-verify at muling mag-invite kung kinakailangan.

**"Invalid ciphertext length":** Data corruption mula sa truncated network response. Subukan muli ang operasyon.

### Mga Hub key error

**"Failed to decrypt hub event":** Isara at buksan muli ang app para i-fetch ang pinakabagong hub key.

## Paghingi ng tulong

- Suriin ang [GitHub Issues](https://github.com/rhonda-rodododo/llamenos-platform/issues)
- Maghanap sa mga umiiral na issue bago gumawa ng bago
- Isama ang deployment mode, platform, at error messages kapag nag-uulat ng bug
