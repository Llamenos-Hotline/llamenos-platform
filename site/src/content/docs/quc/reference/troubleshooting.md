---
title: Ruk'axk'olil taq K'axk'olil
description: Taq solucion richin taq k'axk'olil k'o pa ronojel ri taq rub'eyal ruyakik Llamenos chuqa' taq ruk'ojlib'al.
---

Re re nuk'wal re' nuk'üt taq k'axk'olil k'ate' chuqa' ri taq ruk'ayixik chupam ronojel ri taq rub'eyal ruyakik Llamenos chuqa' taq ruk'ojlib'al.

## Taq k'axk'olil pa ri ruyakik Docker

### Taq containers majun nikiya' q'ij

**Missing environment variables:**

Docker Compose validates ronojel services pa startup, even profiled ones. We nawäx taq errors chi rij missing variables, make sure a `.env` file includes ronojel required values:

```bash
# Required pa .env richin Docker Compose
PG_PASSWORD=your_postgres_password
STORAGE_ACCESS_KEY=your_rustfs_access_key
STORAGE_SECRET_KEY=your_rustfs_secret_key
HMAC_SECRET=your_hmac_secret
ARI_PASSWORD=your_ari_password       # Required even we majun nokisäx Asterisk
BRIDGE_SECRET=your_bridge_secret     # Required even we majun nokisäx Asterisk
ADMIN_PUBKEY=your_admin_hex_pubkey
```

Even we majun nawokisaj ri Asterisk bridge, Docker Compose validates its service definition chuqa' requires `ARI_PASSWORD` chuqa' `BRIDGE_SECRET` to be set.

**Port conflicts:**

We jun port already pa okisaxik, check which process holds it:

```bash
# Check achike nokisaj port 8787 (Worker)
sudo lsof -i :8787

# Check achike nokisaj port 5432 (PostgreSQL)
sudo lsof -i :5432

# Check achike nokisaj port 9000 (RustFS)
sudo lsof -i :9000
```

Stop ri conflicting process o change ri port mapping pa `docker-compose.yml`.

### Database connection errors

We ri app majun tikirel nok pa PostgreSQL:

- Verify ri `PG_PASSWORD` pa `.env` matches achike okisax toq ri container first created
- Check chi re PostgreSQL container healthy: `docker compose ps`
- We ri password changed, you may need to remove ri volume chuqa' recreate: `docker compose down -v && docker compose up -d`

### Strfry relay majun nok

Ri WebSocket relay jun core service, majun optional. We ri relay majun running:

```bash
# Check relay status
docker compose logs WebSocket relay

# Restart ri relay
docker compose restart WebSocket relay
```

We ri relay fails to start, check richin port 7777 conflicts o insufficient permissions pa ri data directory.

### RustFS / S3 storage errors

- Verify `STORAGE_ACCESS_KEY` chuqa' `STORAGE_SECRET_KEY` correct
- Check chi re RustFS container running: `docker compose ps rustfs`
- Access ri RustFS console pa `http://localhost:9001` richin verify bucket creation

## Taq k'axk'olil pa ri ruyakik Cloudflare

### Durable Object errors

**"Durable Object majun found" o binding errors:**

- Run `bun run deploy` (never `wrangler deploy` directly) richin ensure DO bindings correct
- Check `wrangler.jsonc` richin correct DO class names chuqa' bindings
- Chuwäch nitz'aqatisäx jun new DO, you must deploy chuwäch it becomes available

**DO storage limits:**

Cloudflare Durable Objects jun 128 KB limit per key-value pair. We nawäx storage errors:

- Ensure note content majun exceeding ri limit (nimalaj notes ruk'wan many attachments)
- Check chi re ECIES envelopes majun duplicated

### Worker errors (500 responses)

Check Worker logs:

```bash
bunx wrangler tail
```

Common causes:
- Missing secrets (okisax `bunx wrangler secret list` richin verify)
- Incorrect `ADMIN_PUBKEY` format (must 64 hex characters, majun `npub` prefix)
- Rate limiting pa free tier (1,000 requests/minute pa Workers Free)

### Deployment fails ruk'wan "Pages deploy" errors

Never run `wrangler pages deploy` o `wrangler deploy` directly. Always okisax ri root `package.json` scripts:

```bash
bun run deploy          # Deploy ronojel (app + marketing site)
bun run deploy:site     # Deploy marketing site only
```

Running `wrangler pages deploy dist` from ri wrong directory deploys ri Vite app build to Pages instead ri Astro site, breaking ri marketing site ruk'wan 404 errors.

## Taq k'axk'olil pa ri chokoy chupam kematz'ib'

### Auto-update majun nusamaj

Ri chokoy chupam kematz'ib' okisax ri Tauri updater richin check richin new versions. We updates majun detected:

- Check a internet connection
- Verify chi re update endpoint reachable: `https://github.com/rhonda-rodododo/llamenos-platform/releases/latest/download/latest.json`
- Pa Linux, AppImage auto-update requires ri file to jun write permissions pa its directory
- Pa macOS, ri app must pa `/Applications` (majun running from ri DMG directly)

To manually update, download ri latest release from ri [Download](/download) ruwuj.

### PIN unlock fails

We a PIN rejected pa ri chokoy chupam kematz'ib':

- Make sure you entering ri correct PIN (majun k'o "forgot PIN" recovery)
- PINs case-sensitive we contains letters
- We you forgotten a PIN, you must re-enter a nsec richin set jun new one. A encrypted notes remain accessible ruma ri tied to a identity, majun a PIN
- Ri Tauri Stronghold encrypts a nsec ruk'wan ri PIN-derived key (PBKDF2). Jun wrong PIN produces jun invalid decryption, majun jun error message — ri app detects re' by verifying ri derived public key

### Key recovery

We you lost access to a device:

1. Okisax a nsec (ri you should have stored pa jun password manager) richin log in pa jun new device
2. We you registered jun WebAuthn passkey, you can okisax it pa ri new device instead
3. A encrypted notes stored server-side — once you log in ruk'wan ri junam identity, you can decrypt ri
4. We you lost both a nsec chuqa' a passkey, contact a admin. Ri cannot recover a nsec, pero ri can create jun new identity richin you. Notes encrypted richin a old identity will majun longer readable by you

### App majun nikiya' q'ij (blank window)

- Check chi re a system meets ri minimum requirements (see [Download](/download))
- Pa Linux, ensure WebKitGTK installed: `sudo apt install libwebkit2gtk-4.1-0` (Debian/Ubuntu) o equivalent
- Try launching from ri terminal richin see error output: `./llamenos` (AppImage) o check system logs
- We okisax Wayland, try ruk'wan `GDK_BACKEND=x11` chi re fallback

### Single instance conflict

Llámenos enforces single-instance mode. We ri app says already running pero you cannot find ri window:

- Check richin background processes: `ps aux | grep llamenos`
- Kill any orphaned processes: `pkill llamenos`
- Pa Linux, check richin jun stale lock file chuqa' remove it we ri app crashed

## Taq k'axk'olil pa ri chokoy pa oyonib'al

### Provisioning failures

See ri [Mobile Guide](/docs/mobile-guide#troubleshooting-mobile-issues) richin detailed provisioning troubleshooting.

Common causes:
- Expired QR code (tokens expire chuwäch 5 minutes)
- Majun internet connection pa either device
- Chokoy chupam kematz'ib' chuqa' chokoy pa oyonib'al running different protocol versions

### Push notifications majun arriving

- Verify notification permissions granted pa OS settings
- Pa Android, check chi re battery optimization majun killing ri app pa ri background
- Pa iOS, verify chi re Background App Refresh enabled richin Llámenos
- Check chi re you jun active shift chuqa' majun pa break

## Taq k'axk'olil telefonía

### Twilio webhook configuration

We calls majun routing to volunteers:

1. Verify a webhook URLs correct pa ri Twilio console:
   - Voice webhook: `https://your-worker.your-domain.com/telephony/incoming` (POST)
   - Status callback: `https://your-worker.your-domain.com/telephony/status` (POST)
2. Check chi re Twilio credentials pa a settings match ri console:
   - Account SID
   - Auth Token
   - Phone number (must include country code, e.g., `+1234567890`)
3. Check ri Twilio debugger richin errors: [twilio.com/console/debugger](https://www.twilio.com/console/debugger)

### Number setup

- Ri phone number must jun Twilio-owned number o jun verified caller ID
- Richin local development, okisax jun Cloudflare Tunnel o ngrok richin expose a local Worker to Twilio
- Verify ri number's Voice configuration points to a webhook URL, majun ri default TwiML Bin

### Calls connect pero majun audio

- Ensure ri telephony provider's media servers can reach ri volunteer's phone
- Check richin NAT/firewall issues blocking RTP traffic
- We okisax WebRTC, verify chi re STUN/TURN servers configured correctly
- Some VPNs block VoIP traffic — try chuwäch ri VPN

### SMS/WhatsApp messages majun arriving

- Verify ri messaging webhook URLs configured correctly pa a provider's console
- Richin WhatsApp, ensure ri Meta webhook verification token matches a settings
- Check chi re ri messaging channel enabled pa **Admin Settings > Channels**
- Richin Signal, verify ri signal-cli bridge running chuqa' configured to forward to a webhook

## Crypto errors

### Key mismatch errors

**"Failed to decrypt" o "Invalid key" we opening notes:**

- Re' usually means ri note encrypted richin jun different identity than ri one you logged in ruk'wan
- Verify you okisax ri correct nsec (check a npub pa Settings matches achike ri admin sees)
- We you recently re-created a identity, old notes encrypted richin a previous public key will majun decryptable ruk'wan ri new key

**"Invalid signature" pa login:**

- Ri nsec may corrupted — try re-entering it from a password manager
- Ensure ri full nsec pasted (starts ruk'wan `nsec1`, 63 characters total)
- Check richin extra whitespace o newline characters

### Signature verification failures

We hub events fail signature verification:

- Check chi re ri system clock synchronized (NTP). Nimalaj clock skew can cause issues ruk'wan event timestamps
- Verify chi re ri WebSocket relay majun relaying events from unknown pubkeys
- Restart ri app richin re-fetch ri current hub member list

### ECIES envelope errors

**"Failed to unwrap key" pa note decryption:**

- Ri ECIES envelope may have created ruk'wan jun incorrect public key
- Re' can happen we ri admin added jun volunteer ruk'wan jun typo pa ri pubkey
- Ri admin should verify ri volunteer's public key chuqa' re-invite we necessary

**"Invalid ciphertext length":**

- Re' indicates data corruption, possibly from jun truncated network response
- Retry ri operation. We persists, ri encrypted data may permanently corrupted
- Check richin proxy o CDN issues ri might truncate response bodies

### Hub key errors

**"Failed to decrypt hub event":**

- Ri hub key may have rotated since you last connected
- Close chuqa' reopen ri app richin fetch ri latest hub key
- We you recently removed chuqa' re-added to ri hub, ri key may have rotated during a absence

## Ruk'amik to'ïk

We a issue majun covered here:

- Check ri [GitHub Issues](https://github.com/rhonda-rodododo/llamenos-platform/issues) richin known bugs chuqa' workarounds
- Search existing issues chuwäch nitz'aqatisäx jun new one
- We reporting jun bug, include: a deployment mode (Cloudflare/Docker/Kubernetes), platform (Desktop/Mobile), chuqa' any error messages from ri browser console o terminal
