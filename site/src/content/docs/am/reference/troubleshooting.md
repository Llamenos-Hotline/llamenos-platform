---
title: Troubleshooting
description: ለመተግበሪያ፣ ዴስክቶፕ፣ ሞባይል፣ ስልክ፣ እና crypto ከተለመዱ ችግሮች ጋር መፍትሄዎች።
---

ይህ መመሪያ በሁሉም Llamenos መተግበሪያ ሁኔታዎች እና መድረኮች ላይ ተለምዶ የሆኑ ችግሮችን እና መፍትሄዎቻቸውን ይሸፍናል።

## Docker deployment issues

### Containers fail to start

**Missing environment variables:**

Docker Compose ሁሉንም አገልግሎቶች በstartup ላይ ያረጋግጣል፣ እነርሱም profiled ይሁኑ። ስለ missing variables ስህተቶች ካዩ፣ `.env` ፋይልዎ ሁሉንም አስፈላጊ እሴቶች እንደሚያካትት ያረጋግጡ፦

```bash
# Required in .env for Docker Compose
PG_PASSWORD=your_postgres_password
STORAGE_ACCESS_KEY=your_rustfs_access_key
STORAGE_SECRET_KEY=your_rustfs_secret_key
HMAC_SECRET=your_hmac_secret
ARI_PASSWORD=your_ari_password       # Required even if not using Asterisk
BRIDGE_SECRET=your_bridge_secret     # Required even if not using Asterisk
ADMIN_PUBKEY=your_admin_hex_pubkey
```

ከAsterisk bridge ቢጠቀሙም አይጠቀሙም፣ Docker Compose የእሱን አገልግሎት definition ያረጋግጣል እና `ARI_PASSWORD` እና `BRIDGE_SECRET` እንዲኖሩት ይጠይቃል።

**Port conflicts:**

ፖርት ከቀድሞው ጋር ከተጋጨ፣ የትኛው ሂደት እንደያዘው ያረጋግጡ፦

```bash
# Check what's using port 8787 (Worker)
sudo lsof -i :8787

# Check what's using port 5432 (PostgreSQL)
sudo lsof -i :5432

# Check what's using port 9000 (RustFS)
sudo lsof -i :9000
```

የሚጋጨውን ሂደት ያቁሙ ወይም በ`docker-compose.yml` ውስጥ የፖርት mapping ይቀይሩ።

### Database connection errors

App ከPostgreSQL ጋር ካልተገናኘ፦

- `.env` ውስጥ `PG_PASSWORD` ከcontainer በመጀመሪያ ሲፈጠር የተጠቀመውን ጋር መዛመዱን ያረጋግጡ
- PostgreSQL container ጤናማ መሆኑን ያረጋግጡ፦ `docker compose ps`
- Password ከተቀየረ፣ volume ያስወግዱ እና እንደገና ይፍጠሩ፦ `docker compose down -v && docker compose up -d`

### Strfry relay not connecting

WebSocket relay ማዕከላዊ አገልግሎት ነው፣ አማራጭ አይደለም። Relay ካልሰራ፦

```bash
# Check relay status
docker compose logs WebSocket relay

# Restart the relay
docker compose restart WebSocket relay
```

Relay ከመጀመር ካልቻለ፣ ፖርት 7777 conflicts ወይም በdata directory ላይ insufficient permissions ያረጋግጡ።

### RustFS / S3 storage errors

- `STORAGE_ACCESS_KEY` እና `STORAGE_SECRET_KEY` ትክክለኛ መሆናቸውን ያረጋግጡ
- RustFS container እየሰራ መሆኑን ያረጋግጡ፦ `docker compose ps rustfs`
- RustFS console በ`http://localhost:9001` bucket creation ያረጋግጡ

## Cloudflare deployment issues

### Durable Object errors

**"Durable Object not found" or binding errors:**

- DO bindings ትክክለኛ መሆናቸውን ለማረጋገጫ `bun run deploy` ይሂዱ (በቀጥታ `wrangler deploy` አይጠቀሙ)
- `wrangler.jsonc` ውስጥ ትክክለኛ DO class names እና bindings ያረጋግጡ
- አዲስ DO ከጨመሩ በኋላ፣ ከመጠቀም በፊት deploy መደረጉን ያረጋግጡ

**DO storage limits:**

Cloudflare Durable Objects በkey-value pair 128 KB limit አላቸው። Storage ስህተቶች ካዩ፦

- Note content limit አለመተላለፉን ያረጋግጡ (ብዙ attachments ያላቸው በጣም ታላቅ notes)
- ECIES envelopes እንዳይደገሙ ያረጋግጡ

### Worker errors (500 responses)

Worker logs ያረጋግጡ፦

```bash
bunx wrangler tail
```

ተለምዶ ምክንያቶች፦
- Missing secrets (በ`bunx wrangler secret list` ያረጋግጡ)
- Incorrect `ADMIN_PUBKEY` format (64 hex ቁምፊዎች መሆን አለባቸው፣ `npub` ቅድመ ቅጥያ የለውም)
- Free tier rate limiting (1,000 requests/minute on Workers Free)

### Deployment fails with "Pages deploy" errors

በቀጥታ `wrangler pages deploy` ወይም `wrangler deploy` አይሂዱ። ሁልጊዜ root `package.json` scripts ይጠቀሙ፦

```bash
bun run deploy          # Deploy everything (app + marketing site)
bun run deploy:site     # Deploy marketing site only
```

`wrangler pages deploy dist` ከትክክለኛው ዳይሬክቶሪ ውጭ መሮጥ Vite app build ከAstro site ፋንታ ወደ Pages ይገባል፣ ይህም marketing site ከ404 errors ጋር ይሰብራል።

## Desktop app issues

### Auto-update not working

ዴስክቶፕ መተግበሪያው Tauri updaterን ከተሻለ ስሪት ለመፈለግ ይጠቀማል። Updates ካልተገኙ፦

- የኢንተርኔት ግንኙነትዎን ያረጋግጡ
- Update endpoint ተደራሽ መሆኑን ያረጋግጡ፦ `https://github.com/rhonda-rodododo/llamenos-platform/releases/latest/download/latest.json`
- በLinux ላይ፣ AppImage auto-update ፋይል በዳይሬክቶሪው ውስጥ write permissions መኖሩን ያረጋግጡ
- በmacOS ላይ፣ መተግበሪያው በ`/Applications` ውስጥ መሆን አለበት (በቀጥታ ከDMG ማሮጥ አይደለም)

ለmanual update፣ ከ[Download](/download) ገጽ ቅርብ ጊዜውን ስሪት ያውርዱ።

### PIN unlock fails

PIN በዴስክቶፕ መተግበሪያው ላይ ከተቀበለ አይደለም፦

- ትክክለኛውን PIN እየገቡ መሆኑን ያረጋግጡ ("forgot PIN" recovery የለም)
- PINs ከፊደሎች የሚያካትቱ ከሆነ case-sensitive ናቸው
- PIN ከተረሱ፣ nsecዎን እንደገና ለማስገባት አዲስ PIN ለማዘጋጀት ይጠቀሙ። የተመሰጠሩ notesዎ ተደራሽ ይሆናሉ ምክንያቱም ከidentity ጋር እንጂ ከPIN ጋር አይዛመዱም
- Tauri Stronghold nsecን በPIN-derived key (PBKDF2) ይመሰጥራል። የተሳሳተ PIN ትክክለኛውን decryption አያመነጭም — መተግበሪያው ይህን በderived public key ማረጋገጫ ይይዛል

### Key recovery

መሳሪያዎን መድረስ ካልቻሉ፦

1. nsecዎን (በpassword manager ውስጥ እንደተቀመጠ) በአዲስ መሳሪያ ላይ ለመግባት ይጠቀሙ
2. WebAuthn passkey ከተመዘገቡ፣ በአዲስ መሳሪያ ላይ ፋንታውን መጠቀም ይችላሉ
3. የተመሰጠሩ notesዎ በሰርቨር ጎን ይቆማሉ — ከተመሳሳይ identity ጋር ከገቡ፣ ሊያጠፏቸው ይችላሉ
4. nsec እና passkey ከጠፉዎት፣ አስተዳዳሪዎን ያነጋግሩ። nsecዎን መልሰው ሊያገኙ አይችሉም፣ ግን አዲስ identity ሊፈጥሩሎት ይችላሉ። ለድሮ identity የተመሰጠሩ notes ከእርስዎ ጋር አይነበቡም

### App does not start (blank window)

- ስርዓትዎ minimum requirements እንደሚያሟላ ያረጋግጡ (ከ[Download](/download) ይመልከቱ)
- በLinux ላይ፣ WebKitGTK መጫኑን ያረጋግጡ፦ `sudo apt install libwebkit2gtk-4.1-0` (Debian/Ubuntu) ወይም ተመሳሳይ
- ከterminal ለመጀመር ይሞክሩ ስህተት output ለማየት፦ `./llamenos` (AppImage) ወይም system logs ያረጋግጡ
- Wayland ከሆነ፣ fallback አድርገው `GDK_BACKEND=x11` ይሞክሩ

### Single instance conflict

Llamenos single-instance mode ይጠብቃል። መተግበሪያው ቀድሞ እየሰራ ነው ግን window ካላገኙ፦

- Background processes ያረጋግጡ፦ `ps aux | grep llamenos`
- Orphaned processes ያጥፉ፦ `pkill llamenos`
- በLinux ላይ፣ stale lock file ካለ እና መተግበሪያው ከተሰበረ ያስወግዱት

## Mobile app issues

### Provisioning failures

ዝርዝር provisioning troubleshooting ለማየት [Mobile Guide](/docs/mobile-guide#troubleshooting-mobile-issues) ይመልከቱ።

ተለምዶ ምክንያቶች፦
- QR code ጊዜ አልፏል (tokens ከ5 ደቂቃዎች በኋላ ያብቃሉ)
- በማንኛውም መሳሪያ ላይ የኢንተርኔት ግንኙነት የለም
- ዴስክቶፕ እና ሞባይል መተግበሪያዎች የተለያዩ protocol versions እየሄዱ ነው

### Push notifications not arriving

- Notification permissions በOS settings ውስጥ እንደተሰጡ ያረጋግጡ
- በAndroid ላይ፣ battery optimization መተግበሪያውን በኋላ-ቀን እንዳይገድል ያረጋግጡ
- በiOS ላይ፣ Background App Refresh ለLlamenos እንደተንቀሳቀሰ ያረጋግጡ
- በፊት ለፊት ላይ እንደሚሰሩ እና በbreak ላይ እንዳልሆኑ ያረጋግጡ

## Telephony issues

### Twilio webhook configuration

ጥሪዎች ወደ በጎ ፈቃደኞች ካልደረሱ፦

1. Webhook URLs ትክክለኛ መሆናቸውን በTwilio console ውስጥ ያረጋግጡ፦
   - Voice webhook: `https://your-worker.your-domain.com/telephony/incoming` (POST)
   - Status callback: `https://your-worker.your-domain.com/telephony/status` (POST)
2. Twilio credentials በቅንጅቶችዎ ውስጥ ከconsole ጋር መዛመዱን ያረጋግጡ፦
   - Account SID
   - Auth Token
   - Phone number (country code ጨምሮ መሆን አለበት፣ ለምሳሌ፣ `+1234567890`)
3. Twilio debugger ለስህተቶች ይመልከቱ፦ [twilio.com/console/debugger](https://www.twilio.com/console/debugger)

### Number setup

- ስልክ ቁጥሩ Twilio-owned number ወይም verified caller ID መሆን አለበት
- ለአካባቢ ልማት፣ Cloudflare Tunnel ወይም ngrok ለlocal Worker ለTwilio ማጋለጥ ይጠቀሙ
- ቁጥሩ Voice configuration webhook URL ወደሚያመለክት መሆኑን ያረጋግጡ፣ ከነባሩ TwiML Bin ፋንታ

### Calls connect but no audio

- Telephony provider media servers volunteer ስልክ ሊደርሱ መሆኑን ያረጋግጡ
- NAT/firewall RTP trafficን ለመከላከል ያረጋግጡ
- WebRTC ከሆነ፣ STUN/TURN servers ትክክለኛ መሆናቸውን ያረጋግጡ
- አንዳንዸ VPNs VoIP trafficን ያገዳሉ — VPN ያጥፉ እና ይሞክሩ

### SMS/WhatsApp messages not arriving

- Messaging webhook URLs በprovider console ውስጥ ትክክለኛ መሆናቸውን ያረጋግጡ
- ለWhatsApp፣ Meta webhook verification token በቅንጅቶችዎ ጋር መዛመዱን ያረጋግጡ
- Messaging channel በ**Admin Settings > Channels** እንደተንቀሳቀሰ ያረጋግጡ
- ለSignal፣ signal-cli bridge እየሰራ እና ወደ webhook እንደሚያስተላልፍ ያረጋግጡ

## Crypto errors

### Key mismatch errors

**"Failed to decrypt" or "Invalid key" notes ሲከፍቱ፦**

- ይህ ብዙውን ጊዜ note ለተለየ identity ከተመሰጠረ ማለት ነው ከእርስዎ የገቡት
- ትክክለኛ nsec እየተጠቀሙ መሆኑን ያረጋግጡ (Settings ውስጥ npub ከአስተዳዳሪ የሚያየው ጋር መዛመዱን ያረጋግጡ)
- Identityዎን ቀደም ብሎ ከደነሱ፣ ለድሮ public key የተመሰጠሩ notes በአዲስ key ጋር አይነበቡም

**"Invalid signature" on login:**

- nsec ሊበላሽ ይችላል — ከpassword manager ውስጥ እንደገና ያስገቡ
- ሙሉ nsec መለጠፍዎን ያረጋግጡ (ከ`nsec1` ጀምሮ፣ ጠቅላላ 63 ቁምፊዎች)
- ተጨማሪ whitespace ወይም newline characters ያሉበትን ያረጋግጡ

### Signature verification failures

Hub events signature verification ካልተሳካ፦

- ስርዓት clock synchronized (NTP) መሆኑን ያረጋግጡ። ታላቅ clock skew ከevent timestamps ጋር ችግር ሊፈጥር ይችላል
- WebSocket relay ከያልታወቁ pubkeys events እንዳይrelay ያረጋግጡ
- መተግበሪያውን እንደገና ያስጀምሩ current hub member list እንዲደርስ

### ECIES envelope errors

**"Failed to unwrap key" note decryption ላይ፦**

- ECIES envelope በትክክለኛ public key ካልተፈጠረ ሊሆን ይችላል
- ይህ አስተዳዳሪ volunteerን በpubkey typo ጨምረው ከሆነ ሊከሰት ይችላል
- አስተዳዳሪ volunteer public key ያረጋግጡ እና አስፈላጊ ከሆነ እንደገና ይጋብዙ

**"Invalid ciphertext length":**

- ይህ data corruption ያመለክታል፣ ምናልባት ከtruncated network response
- ክዋኔውን እንደገና ይሞክሩ። ከቀጠለ፣ የተመሰጠረው ውሂብ ሊበላሽ ይችላል
- Response bodiesን ሊያጭሩ proxy ወይም CDN issues ያረጋግጡ

### Hub key errors

**"Failed to decrypt hub event":**

- Hub key ከመጨረሻ መገናኘትዎ በኋላ rotated ሊሆን ይችላል
- መተግበሪያውን ይዝጉ እና እንደገና ይክፈቱ latest hub key ለማግኘት
- ከhub ቀደም ብሎ ተወግደው እንደገና ከተጨመሩ፣ key በአለመኖራቸው ጊዜ rotated ሊሆን ይችላል

## Getting help

ችግርዎ እዚህ ካልተሸፈነ፦

- [GitHub Issues](https://github.com/rhonda-rodododo/llamenos-platform/issues) ለታወቁ ሳንካዎች እና መፍትሄዎች ያረጋግጡ
- አዲስ issue ከመፍጠርዎ በፊት ያሉ issues ያፈሱ
- Bug ሲገልጹ፣ ያካትቱ፦ deployment mode (Cloudflare/Docker/Kubernetes)፣ መድረክ (Desktop/Mobile)፣ እና ከbrowser console ወይም terminal ማንኛውም error messages
