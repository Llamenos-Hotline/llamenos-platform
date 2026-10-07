---
title: Troubleshooting
description: Solutions for common issues with deployment, the desktop app, mobile app, telephony, and cryptographic operations.
---

Tilmaahan wuxuu qabtaa arrimaha caadiga ah iyo xalalkooda across all Llamenos deployment modes iyo platforms.

## Docker deployment issues

### Containers fail to start

**Missing environment variables:**

Docker Compose waxay validate gareysaa dhammaan adeegyada at startup, xitaa profiled ones. Haddii aad aragto errors about missing variables, hubi in `.env` file-kaagu uu ku jiro dhammaan values loo baahan yahay:

```bash
# Required in .env for Docker Compose
PG_PASSWORD=your_postgres_password
STORAGE_ACCESS_KEY=your_rustfs_access_key
STORAGE_SECRET_KEY=your_rustfs_secret_key
HMAC_SECRET=your_hmac_secret
ARI_PASSWORD=your_ari_password       # Required xitaa haddii aan la isticmaalin Asterisk
BRIDGE_SECRET=your_bridge_secret     # Required xitaa haddii aan la isticmaalin Asterisk
ADMIN_PUBKEY=your_admin_hex_pubkey
```

Xitaa haddii aanad isticmaalin Asterisk bridge, Docker Compose waxay validate gareysaa service definition-kiisa oo waxay u baahan tahay `ARI_PASSWORD` iyo `BRIDGE_SECRET` in la set gareeyo.

**Port conflicts:**

Haddii port uu horey u jiro in la isticmaalo, hubi which process holds it:

```bash
# Check what's using port 8787 (Worker)
sudo lsof -i :8787

# Check what's using port 5432 (PostgreSQL)
sudo lsof -i :5432

# Check what's using port 9000 (RustFS)
sudo lsof -i :9000
```

Jooji process-ka is-haysta ama beddel port mapping in `docker-compose.yml`.

### Database connection errors

Haddii app-ka aan ku xiri karin PostgreSQL:

- Verify `PG_PASSWORD` in `.env` uu iswaafaqsan yahay waxa la isticmaalay marka container-ka horey loo sameeyay
- Hubi in PostgreSQL container caafimaad qabo: `docker compose ps`
- Haddii password la beddelay, waxaad u baahan tahay inaad ka saarto volume oo aad dib u sameyso: `docker compose down -v && docker compose up -d`

### Strfry relay not connecting

WebSocket relay waa adeeg aasaasi ah, ma aha ikhtiyaar. Haddii relay aan shaqeyn:

```bash
# Check relay status
docker compose logs WebSocket relay

# Restart the relay
docker compose restart WebSocket relay
```

Haddii relay uu fail inuu bilaabo, hubi port 7777 conflicts ama permissions insufficient on data directory.

### RustFS / S3 storage errors

- Verify `STORAGE_ACCESS_KEY` iyo `STORAGE_SECRET_KEY` sax yihiin
- Hubi in RustFS container shaqeeya: `docker compose ps rustfs`
- Access RustFS console at `http://localhost:9001` si aad u verify gareyso bucket creation

## Cloudflare deployment issues

### Durable Object errors

**"Durable Object not found" ama binding errors:**

- Run `bun run deploy` (marnaba `wrangler deploy` directly) si aad u hubiso in DO bindings sax yihiin
- Check `wrangler.jsonc` for correct DO class names iyo bindings
- Kadib adding a new DO, waa inaad deploy gareysaa ka hor inta aanu noqon available

**DO storage limits:**

Cloudflare Durable Objects waxay leeyihiin 128 KB limit per key-value pair. Haddii aad aragto storage errors:

- Hubi in note content aan ka bixin limit-ka (notes aad u weyn with many attachments)
- Hubi in ECIES envelopes aan la duplicatin

### Worker errors (500 responses)

Check Worker logs:

```bash
bunx wrangler tail
```

Causes caadi ah:
- Missing secrets (isticmaal `bunx wrangler secret list` si aad u verify gareyso)
- Incorrect `ADMIN_PUBKEY` format (waa inuu ahaadaa 64 hex characters, ma jirto `npub` prefix)
- Rate limiting on free tier (1,000 requests/minute on Workers Free)

### Deployment fails with "Pages deploy" errors

Marnaba run `wrangler pages deploy` ama `wrangler deploy` directly. Had iyo jeer isticmaal root `package.json` scripts:

```bash
bun run deploy          # Deploy dhammaan (app + marketing site)
bun run deploy:site     # Deploy marketing site kaliya
```

Running `wrangler pages deploy dist` from wrong directory waxay deploy gareysaa Vite app build to Pages beddelka Astro site, breaking marketing site with 404 errors.

## Desktop app issues

### Auto-update not working

Desktop app-ka waxa uu isticmaalaa Tauri updater si uu u hubiyo versions cusub. Haddii updates aan la ogaan:

- Hubi internet connection-kaaga
- Verify in update endpoint la heli karo: `https://github.com/rhonda-rodododo/llamenos-platform/releases/latest/download/latest.json`
- On Linux, AppImage auto-update waxay u baahan tahay in file uu leeyahay write permissions in directory-kiisa
- On macOS, app-ka waa inuu ku jiraa `/Applications` (ma aha running from DMG directly)

Si aad u update gareyso manually, download latest release from [Download](/download) page.

### PIN unlock fails

Haddii PIN-kaaga la diido on desktop app:

- Hubi inaad gelinayso PIN sax ah (ma jirto "forgot PIN" recovery)
- PINs waxay ahaan karaan case-sensitive haddii ay contains letters
- Haddii aad illowday PIN-kaaga, waa inaad dib u gelisaa nsec-kaaga si aad u set gareyso PIN cusub. Encrypted notes-kaaga way sii accessible yihiin sababtoo ah waxay ku xiran yihiin identity-kaaga, ma aha PIN-kaaga
- Tauri Stronghold waxay encrypt gareysaa nsec-kaaga with PIN-derived key (PBKDF2). Wrong PIN waxay soo saartaa invalid decryption, ma aha error message — app-ka waxay detect gareysaa tani by verifying derived public key

### Key recovery

Haddii aad lumisay access to your device:

1. Isticmaal nsec-kaaga (waxaad keydshould have stored in a password manager) si aad u log in gareyso on a new device
2. Haddii aad diiwaan gelisay WebAuthn passkey, waxaad isticmaali kartaa on new device beddelka
3. Encrypted notes-kaaga waxay ku kaydsan yihiin server-side — marka aad log in gareyso with same identity, waxaad decrypt gareyi kartaa
4. Haddii aad lumisay both nsec iyo passkey, la xidhiidh admin-kaaga. Ma soo celin karaan nsec-kaaga, laakiin waxay kuu sameyn karaan identity cusub. Notes encrypted for old identity ma ahaan doonaan readable by you

### App does not start (blank window)

- Hubi in system-kaagu buuxiyo minimum requirements (eeg [Download](/download))
- On Linux, hubi in WebKitGTK installed yahay: `sudo apt install libwebkit2gtk-4.1-0` (Debian/Ubuntu) ama equivalent
- Isku day inaad ka bilaabato terminal si aad u aragto error output: `./llamenos` (AppImage) ama check system logs
- Haddii isticmaalayo Wayland, isku day with `GDK_BACKEND=x11` as fallback

### Single instance conflict

Llamenos waxay ku adag tahay single-instance mode. Haddii app-ka yiraahdo already running laakiin aadan heli karin window:

- Hubi background processes: `ps aux | grep llamenos`
- Dil any orphaned processes: `pkill llamenos`
- On Linux, hubi stale lock file oo ka saar haddii app-ka crash gareeyay

## Mobile app issues

### Provisioning failures

Eeg [Mobile Guide](/docs/mobile-guide#troubleshooting-mobile-issues) for detailed provisioning troubleshooting.

Causes caadi ah:
- Expired QR code (tokens expire kadib 5 minutes)
- No internet connection on labada device
- Desktop app iyo mobile app running different protocol versions

### Push notifications not arriving

- Verify notification permissions granted in OS settings
- On Android, hubi in battery optimization aan ku dilin app-ka in background
- On iOS, verify in Background App Refresh enabled yahay for Llamenos
- Hubi inaad leedahay active shift oo aadan ahayn on break

## Telephony issues

### Twilio webhook configuration

Haddii calls aan u gudbin volunteers:

1. Verify webhook URLs-kaaga sax yihiin in Twilio console:
   - Voice webhook: `https://your-worker.your-domain.com/telephony/incoming` (POST)
   - Status callback: `https://your-worker.your-domain.com/telephony/status` (POST)
2. Hubi in Twilio credentials in your settings iswaafaqaqaan console:
   - Account SID
   - Auth Token
   - Phone number (waa inuu includes country code, e.g., `+1234567890`)
3. Hubi Twilio debugger for errors: [twilio.com/console/debugger](https://www.twilio.com/console/debugger)

### Number setup

- Phone number waa inuu ahaadaa Twilio-owned number ama verified caller ID
- For local development, isticmaal Cloudflare Tunnel ama ngrok si aad u expose gareyso your local Worker to Twilio
- Verify number's Voice configuration u jeeddo your webhook URL, ma aha default TwiML Bin

### Calls connect but no audio

- Hubi in telephony provider's media servers ka heli karaan volunteer's phone
- Hubi NAT/firewall issues blocking RTP traffic
- Haddii isticmaalayo WebRTC, verify in STUN/TURN servers configured correctly
- Qaar VPNs block VoIP traffic — isku day without VPN

### SMS/WhatsApp messages not arriving

- Verify messaging webhook URLs configured correctly in your provider's console
- For WhatsApp, hubi in Meta webhook verification token iswaafaqsan your settings
- Hubi in messaging channel enabled in **Admin Settings > Channels**
- For Signal, verify signal-cli bridge running oo configured to forward to your webhook

## Crypto errors

### Key mismatch errors

**"Failed to decrypt" ama "Invalid key" marka la furo notes:**

- Tani guud ahaan macnaheedu waa note waxaa loo encrypt gareeyay different identity than one you are logged in with
- Verify inaad isticmaalayso correct nsec (hubi npub-kaaga in Settings matches what admin sees)
- Haddii aad recently re-created identity-kaaga, old notes encrypted for previous public key ma ahaan doonaan decryptable with new key

**"Invalid signature" on login:**

- Nsec waxaa laga yaabaa inuu corrupted yahay — isku day inaad dib u geliso from your password manager
- Hubi in full nsec la paste gareeyay (starts with `nsec1`, 63 characters total)
- Hubi extra whitespace ama newline characters

### Signature verification failures

Haddii hub events fail signature verification:

- Hubi in system clock synchronized yahay (NTP). Large clock skew waxay keeni kartaa issues with event timestamps
- Verify in WebSocket relay aan relaying events from unknown pubkeys
- Restart app-ka si aad dib u fetch gareyso current hub member list

### ECIES envelope errors

**"Failed to unwrap key" on note decryption:**

- ECIES envelope waxaa laga yaabaa in la sameeyay with incorrect public key
- Tani waxay dhici kartaa haddii admin uu daray volunteer with typo in pubkey
- Admin waa inuu verify gareeyaa volunteer's public key oo dib u soo ceshadaa haddii loo baahdo

**"Invalid ciphertext length":**

- Tani waxay muujinaysaa data corruption, laga yaabee from truncated network response
- Isku day operation-ka mar kale. Haddii uu sii socdo, encrypted data waxaa laga yaabaa inuu permanently corrupted yahay
- Hubi proxy ama CDN issues kuwa truncate gareya response bodies

### Hub key errors

**"Failed to decrypt hub event":**

- Hub key waxaa laga yaabaa in la rotated since last connection
- Xir oo fur app-ka si aad u fetch gareyso latest hub key
- Haddii aad recently laga saaray oo dib loogu daray hub-ka, key waxaa laga yaabaa inuu rotated during your absence

## Getting help

Haddii issue-gaagu aan ku jirin halkan:

- Hubi [GitHub Issues](https://github.com/rhonda-rodododo/llamenos-platform/issues) for known bugs iyo workarounds
- Raadi issues hore inta aanad sameyn mid cusub
- Marka aad report gareyso bug, ku dar: deployment mode-kaaga (Cloudflare/Docker/Kubernetes), platform-kaaga (Desktop/Mobile), iyo error messages from browser console ama terminal
