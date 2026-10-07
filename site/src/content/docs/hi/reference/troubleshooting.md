---
title: समस्या निवारण
description: डिप्लॉयमेंट, डेस्कटॉप ऐप, मोबाइल ऐप, टेलीफोनी, और क्रिप्टोग्राफिक ऑपरेशन में सामान्य समस्याओं के समाधान।
---

यह गाइड सभी Llamenos डिप्लॉयमेंट मोड और प्लेटफ़ॉर्म में सामान्य समस्याओं और उनके समाधानों को कवर करती है।

## Docker डिप्लॉयमेंट की समस्याएं

### कंटेनर शुरू नहीं होते

**नज़रअंदाज़ environment variables:**

Docker Compose स्टार्टअप पर सभी सेवाओं को मान्य करता है, यहाँ तक कि प्रोफ़ाइल वाली सेवाओं को भी। यदि आप गायब variables के बारे में त्रुटियाँ देखते हैं, तो सुनिश्चित करें कि आपकी `.env` फ़ाइल में सभी आवश्यक मान हैं:

```bash
# Docker Compose के लिए .env में आवश्यक
PG_PASSWORD=your_postgres_password
STORAGE_ACCESS_KEY=your_rustfs_access_key
STORAGE_SECRET_KEY=your_rustfs_secret_key
HMAC_SECRET=your_hmac_secret
ARI_PASSWORD=your_ari_password       # Asterisk का उपयोग न करने पर भी आवश्यक
BRIDGE_SECRET=your_bridge_secret     # Asterisk का उपयोग न करने पर भी आवश्यक
ADMIN_PUBKEY=your_admin_hex_pubkey
```

भले ही आप Asterisk bridge का उपयोग नहीं कर रहे हों, Docker Compose इसकी सेवा परिभाषा को मान्य करता है और `ARI_PASSWORD` और `BRIDGE_SECRET` सेट होने की आवश्यकता है।

**Port conflicts:**

यदि कोई port पहले से उपयोग में है, तो जांचें कि कौन सी प्रक्रिया उसे hold करती है:

```bash
# जांचें कि port 8787 (Worker) का उपयोग कौन कर रहा है
sudo lsof -i :8787

# जांचें कि port 5432 (PostgreSQL) का उपयोग कौन कर रहा है
sudo lsof -i :5432

# जांचें कि port 9000 (RustFS) का उपयोग कौन कर रहा है
sudo lsof -i :9000
```

परस्पर विरोधी प्रक्रिया को रोकें या `docker-compose.yml` में port mapping बदलें।

### Database कनेक्शन त्रुटियाँ

यदि ऐप PostgreSQL से कनेक्ट नहीं कर सकता:

- सत्यापित करें कि `.env` में `PG_PASSWORD` कंटेनर पहली बार बनाए जाने पर उपयोग किए गए से मेल खाता है
- जांचें कि PostgreSQL कंटेनर स्वस्थ है: `docker compose ps`
- यदि पासवर्ड बदल गया था, तो volume हटाने और फिर से बनाने की आवश्यकता हो सकती है: `docker compose down -v && docker compose up -d`

### Strfry relay कनेक्ट नहीं हो रहा

WebSocket relay एक मुख्य सेवा है, वैकल्पिक नहीं। यदि relay चल नहीं रही है:

```bash
# relay की स्थिति जांचें
docker compose logs WebSocket relay

# relay को पुनः आरंभ करें
docker compose restart WebSocket relay
```

यदि relay शुरू नहीं हो रही, port 7777 conflicts या data directory पर अपर्याप्त अनुमतियों की जांच करें।

### RustFS / S3 storage त्रुटियाँ

- सत्यापित करें कि `STORAGE_ACCESS_KEY` और `STORAGE_SECRET_KEY` सही हैं
- जांचें कि RustFS कंटेनर चल रहा है: `docker compose ps rustfs`
- Bucket निर्माण सत्यापित करने के लिए `http://localhost:9001` पर RustFS console एक्सेस करें

## Cloudflare डिप्लॉयमेंट की समस्याएं

### Durable Object त्रुटियाँ

**"Durable Object not found" या binding त्रुटियाँ:**

- `bun run deploy` चलाएं (कभी भी सीधे `wrangler deploy` नहीं) यह सुनिश्चित करने के लिए कि DO bindings सही हैं
- सही DO class names और bindings के लिए `wrangler.jsonc` जांचें
- नया DO जोड़ने के बाद, उपलब्ध होने से पहले deploy करना होगा

**DO storage सीमाएं:**

Cloudflare Durable Objects की प्रति key-value pair 128 KB सीमा है। यदि आप storage त्रुटियाँ देखते हैं:

- सुनिश्चित करें कि नोट सामग्री सीमा से अधिक नहीं है (बहुत बड़े नोट्स में कई attachments के साथ)
- जांचें कि ECIES envelopes duplicate नहीं हो रहे हैं

### Worker त्रुटियाँ (500 responses)

Worker logs जांचें:

```bash
bunx wrangler tail
```

सामान्य कारण:
- गायब secrets (सत्यापित करने के लिए `bunx wrangler secret list` उपयोग करें)
- गलत `ADMIN_PUBKEY` format (64 hex characters होने चाहिए, कोई `npub` prefix नहीं)
- Free tier पर rate limiting (Workers Free पर 1,000 requests/minute)

### "Pages deploy" त्रुटियों के साथ डिप्लॉयमेंट विफल

कभी भी `wrangler pages deploy` या `wrangler deploy` सीधे न चलाएं। हमेशा root `package.json` scripts का उपयोग करें:

```bash
bun run deploy          # सब कुछ डिप्लॉय करें (app + marketing site)
bun run deploy:site     # केवल marketing site डिप्लॉय करें
```

गलत directory से `wrangler pages deploy dist` चलाने से Vite app build Astro site के बजाय Pages में deploy हो जाता है, जिससे marketing site 404 errors के साथ टूट जाती है।

## Desktop app की समस्याएं

### Auto-update काम नहीं कर रहा

Desktop app नए version की जांच के लिए Tauri updater का उपयोग करता है। यदि updates detect नहीं हो रहे:

- अपना internet connection जांचें
- सत्यापित करें कि update endpoint पहुंच योग्य है: `https://github.com/rhonda-rodododo/llamenos-platform/releases/latest/download/latest.json`
- Linux पर, AppImage auto-update के लिए उसकी directory में file को write permissions की आवश्यकता है
- macOS पर, app को `/Applications` में होना चाहिए (DMG से सीधे नहीं चल रहा)

मैन्युअल रूप से update करने के लिए, [Download](/download) पेज से नवीनतम release डाउनलोड करें।

### Desktop app पर PIN unlock विफल

यदि desktop app पर आपका PIN अस्वीकार किया जाता है:

- सुनिश्चित करें कि आप सही PIN दर्ज कर रहे हैं (कोई "PIN भूल गए" recovery नहीं है)
- यदि letters हैं तो PINs case-sensitive होते हैं
- यदि आप अपना PIN भूल गए हैं, तो नया सेट करने के लिए अपना nsec फिर से दर्ज करना होगा। आपके नोट्स आपकी identity से जुड़े हैं, PIN से नहीं, इसलिए accessible रहते हैं
- Tauri Stronghold आपके nsec को PIN-derived key (PBKDF2) से encrypt करता है। गलत PIN एक error message नहीं, बल्कि invalid decryption उत्पन्न करता है — app derived public key सत्यापित करके यह detect करती है

### Key recovery

यदि आपने अपने device तक पहुंच खो दी है:

1. नए device पर login करने के लिए अपना nsec (जो password manager में संग्रहीत होना चाहिए) उपयोग करें
2. यदि आपने WebAuthn passkey पंजीकृत किया है, तो आप इसे नए device पर उपयोग कर सकते हैं
3. आपके encrypted नोट्स server-side संग्रहीत हैं — एक ही identity से login करने पर आप उन्हें decrypt कर सकते हैं
4. यदि आपने अपना nsec और passkey दोनों खो दिए हैं, तो अपने admin से संपर्क करें। वे आपका nsec recover नहीं कर सकते, लेकिन आपके लिए नई identity बना सकते हैं

### App शुरू नहीं होता (blank window)

- जांचें कि आपका system न्यूनतम requirements को पूरा करता है ([Download](/download) देखें)
- Linux पर, सुनिश्चित करें कि WebKitGTK installed है: `sudo apt install libwebkit2gtk-4.1-0` (Debian/Ubuntu) या समकक्ष
- Error output देखने के लिए terminal से लॉन्च करने का प्रयास करें: `./llamenos` (AppImage) या system logs जांचें
- Wayland का उपयोग करते समय, fallback के रूप में `GDK_BACKEND=x11` के साथ प्रयास करें

### Single instance conflict

Llamenos single-instance mode enforce करता है। यदि app कहता है कि यह पहले से चल रहा है लेकिन आप window नहीं ढूंढ पा रहे:

- Background processes जांचें: `ps aux | grep llamenos`
- किसी भी orphaned process को kill करें: `pkill llamenos`
- Linux पर, stale lock file के लिए जांचें और यदि app crash हो गया था तो उसे हटाएं

## Mobile app की समस्याएं

### Provisioning विफलताएं

विस्तृत provisioning troubleshooting के लिए [Mobile Guide](/docs/mobile-guide#troubleshooting-mobile-issues) देखें।

सामान्य कारण:
- Expired QR code (5 मिनट के बाद tokens expire हो जाते हैं)
- किसी भी device पर internet connection नहीं
- Desktop app और mobile app अलग-अलग protocol versions चला रहे हैं

### Push notifications नहीं आ रहीं

- सत्यापित करें कि OS settings में notification permissions दी गई हैं
- Android पर, जांचें कि battery optimization background में app को बंद नहीं कर रही
- iOS पर, सत्यापित करें कि Llamenos के लिए Background App Refresh enabled है
- जांचें कि आपके पास active shift है और आप break पर नहीं हैं

## Telephony की समस्याएं

### Twilio webhook कॉन्फ़िगरेशन

यदि calls volunteers को route नहीं हो रहीं:

1. Twilio console में अपने webhook URLs सत्यापित करें:
   - Voice webhook: `https://your-worker.your-domain.com/telephony/incoming` (POST)
   - Status callback: `https://your-worker.your-domain.com/telephony/status` (POST)
2. जांचें कि आपकी settings में Twilio credentials console से मेल खाते हैं:
   - Account SID
   - Auth Token
   - Phone number (country code सहित होना चाहिए, जैसे `+1234567890`)
3. Errors के लिए Twilio debugger जांचें: [twilio.com/console/debugger](https://www.twilio.com/console/debugger)

### Number setup

- Phone number एक Twilio-owned number या verified caller ID होना चाहिए
- Local development के लिए, अपने local Worker को Twilio के सामने expose करने के लिए Cloudflare Tunnel या ngrok का उपयोग करें
- सत्यापित करें कि number का Voice configuration default TwiML Bin नहीं, बल्कि आपके webhook URL की ओर इंगित करता है

### Calls connect होती हैं लेकिन कोई audio नहीं

- सुनिश्चित करें कि telephony provider के media servers volunteer के phone तक पहुंच सकते हैं
- RTP traffic को block करने वाले NAT/firewall issues जांचें
- WebRTC का उपयोग करते समय, सत्यापित करें कि STUN/TURN servers सही तरीके से configured हैं
- कुछ VPNs VoIP traffic को block करते हैं — VPN के बिना प्रयास करें

### SMS/WhatsApp messages नहीं आ रहे

- सत्यापित करें कि messaging webhook URLs आपके provider के console में सही तरीके से configured हैं
- WhatsApp के लिए, सुनिश्चित करें कि Meta webhook verification token आपकी settings से मेल खाता है
- जांचें कि **Admin Settings > Channels** में messaging channel enabled है
- Signal के लिए, सत्यापित करें कि signal-cli bridge चल रहा है और आपके webhook को forward करने के लिए configured है

## Crypto त्रुटियाँ

### Key mismatch त्रुटियाँ

**नोट्स खोलते समय "Failed to decrypt" या "Invalid key":**

- इसका आमतौर पर मतलब है कि नोट एक अलग identity के लिए encrypt किया गया था
- सत्यापित करें कि आप सही nsec का उपयोग कर रहे हैं (जांचें कि Settings में आपका npub admin जो देखता है उससे मेल खाता है)
- यदि आपने हाल ही में अपनी identity फिर से बनाई है, तो पुरानी public key के लिए encrypt किए गए पुराने नोट्स नई key से decrypt नहीं होंगे

**Login पर "Invalid signature":**

- nsec corrupt हो सकता है — अपने password manager से इसे फिर से दर्ज करने का प्रयास करें
- सुनिश्चित करें कि पूरा nsec paste किया गया है (`nsec1` से शुरू होता है, कुल 63 characters)
- अतिरिक्त whitespace या newline characters जांचें

### Signature verification विफलताएं

यदि hub events signature verification विफल हो जाते हैं:

- जांचें कि system clock synchronized है (NTP)। बड़ी clock skew event timestamps के साथ समस्याएं पैदा कर सकती है
- सत्यापित करें कि WebSocket relay अज्ञात pubkeys से events relay नहीं कर रहा
- वर्तमान hub member list फिर से प्राप्त करने के लिए app restart करें

### ECIES envelope त्रुटियाँ

**नोट decryption पर "Failed to unwrap key":**

- ECIES envelope गलत public key के साथ बनाया गया हो सकता है
- यह तब हो सकता है जब admin ने pubkey में typo के साथ volunteer जोड़ा हो
- Admin को volunteer की public key सत्यापित करनी चाहिए और यदि आवश्यक हो तो फिर से invite करना चाहिए

**"Invalid ciphertext length":**

- यह data corruption का संकेत है, संभवतः truncated network response से
- Operation retry करें। यदि यह बना रहता है, तो encrypted data स्थायी रूप से corrupt हो सकता है
- Proxy या CDN issues जांचें जो response bodies को truncate कर सकते हैं

### Hub key त्रुटियाँ

**"Failed to decrypt hub event":**

- Hub key आपके आखिरी connect होने के बाद rotate हो सकती है
- नवीनतम hub key प्राप्त करने के लिए app बंद करें और फिर खोलें
- यदि आपको हाल ही में hub से हटाया गया और फिर जोड़ा गया, तो आपकी अनुपस्थिति के दौरान key rotate हो सकती थी

## सहायता प्राप्त करना

यदि आपकी समस्या यहाँ कवर नहीं है:

- ज्ञात bugs और workarounds के लिए [GitHub Issues](https://github.com/rhonda-rodododo/llamenos-platform/issues) जांचें
- नई issue बनाने से पहले मौजूदा issues खोजें
- bug report करते समय शामिल करें: आपका deployment mode (Cloudflare/Docker/Kubernetes), platform (Desktop/Mobile), और browser console या terminal से कोई भी error messages
