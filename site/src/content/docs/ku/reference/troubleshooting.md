---
title: Çareserkirina Arîşeyan
description: Çareseriyên ji bo arîşeyên hevpar li ser sazkirinê, sepa desktop, sepa mobîl, telefoniyê, û operasyonên kriptografîk.
---

Ev rêber arîşeyên hevpar û çareseriyên wan li ser hemû modên sazkirina Llamenos û platforman vedigire nav xwe.

## Arîşeyên sazkirina Docker

### Konteyner nakevin dest pê kirin

**Guhertoyên hawirdorê yên winda:**

Docker Compose hemû karûbar di dema destpêkirinê de erê dike, heke profîl jî hebin. Heke hûn çewtiyên li ser guhertoyên winda dibînin, piştrast bikin ku pelê `.env` ya we hemû nirxên pêwîst dihewîne:

```bash
# Di .env de pêwîst ji bo Docker Compose
PG_PASSWORD=your_postgres_password
STORAGE_ACCESS_KEY=your_rustfs_access_key
STORAGE_SECRET_KEY=your_rustfs_secret_key
HMAC_SECRET=your_hmac_secret
ARI_PASSWORD=your_ari_password       # Tevî ku Asterisk nayê bikar anîn jî pêwîst e
BRIDGE_SECRET=your_bridge_secret     # Tevî ku Asterisk nayê bikar anîn jî pêwîst e
ADMIN_PUBKEY=your_admin_hex_pubkey
```

Tevî ku hûn bridge-a Asterisk nayê bikar anîn, Docker Compose mîhengkirina karûbarê wê erê dike û `ARI_PASSWORD` û `BRIDGE_SECRET` hewce dike ku bêne sazkirin.

**Nakokiyên portê:**

Heke portek berê tê bikar anîn, kontrol bikin ku kîjan pêvajo wê digire:

```bash
# Kontrol bike ku çi port 8787 (Worker) bikar tîne
sudo lsof -i :8787

# Kontrol bike ku çi port 5432 (PostgreSQL) bikar tîne
sudo lsof -i :5432

# Kontrol bike ku çi port 9000 (RustFS) bikar tîne
sudo lsof -i :9000
```

Pêvajoya nakokî rawestînin an jî port mapping di `docker-compose.yml` de biguherînin.

### Çewtiyên girêdana danegehê

Heke sepan nikare bi PostgreSQL re girêbide:

- `PG_PASSWORD` di `.env` de bi ya ku dema ku konteyner cara yekem hatibû çêkirin hatiye bikar anîn re li hev bîne
- Kontrol bikin ku konteynera PostgreSQL saxlem e: `docker compose ps`
- Heke şîfre hatibe guhertin, dibe ku hûn hewce ne ku volume jê bibin û ji nû ve çêbikin: `docker compose down -v && docker compose up -d`

### Strfry relay nagire

WebSocket relay karûbarek bingehîn e, ne bijarte. Heke relay naxebite:

```bash
# Statûya relay kontrol bikin
docker compose logs WebSocket relay

# Relay ji nû ve bidin destpêkirin
docker compose restart WebSocket relay
```

Heke relay nikare bixebite, ji bo nakokiyên port 7777 an mafên têr li ser peldanka daneyê kontrol bikin.

### Çewtiyên storage-a RustFS / S3

- `STORAGE_ACCESS_KEY` û `STORAGE_SECRET_KEY` rast in piştrast bikin
- Kontrol bikin ku konteynera RustFS dixebite: `docker compose ps rustfs`
- Biçin konsola RustFS li `http://localhost:9001` da ku çêkirina bucket-ê erê bikin

## Arîşeyên sazkirina Cloudflare

### Çewtiyên Durable Object

**"Durable Object nehat dîtin" an çewtiyên binding:**

- `bun run deploy` bixebitînin (tu carî rasterast `wrangler deploy` nekin) da ku binding-ên DO rast bin
- `wrangler.jsonc` ji bo navên rast ên polên DO û binding-ê kontrol bikin
- Piştî lê zêdekirina DO-yek nû, divê hûn berî ku bibe berdest bideploy bikin

**Sînorên storage-a DO:**

Cloudflare Durable Objects sînorê 128 KB ji bo her coteya key-value hene. Heke hûn çewtiyên storage-ê dibînin:

- Piştrast bikin ku naveroka nîşokê sînorê derbas nake (nîşokên pir mezin bi gelek pêvek)
- Kontrol bikin ku envelope-ên ECIES ne têne dubare kirin

### Çewtiyên Worker (bersivên 500)

Logên Worker kontrol bikin:

```bash
bunx wrangler tail
```

Sedemên hevpar:

- Sirên winda (ji bo verastkirinê `bunx wrangler secret list` bikar bînin)
- Formata çewt a `ADMIN_PUBKEY` (divê 64 karakterên hex be, bêyî pêşgirtiya `npub`)
- Sînorkirina rêjeyê li ser asta belaş (1,000 daxwaz/deqîqe li ser Workers Free)

### Sazkirin bi çewtiyên "Pages deploy" têkstûr dibe

Tu carî rasterast `wrangler pages deploy` an `wrangler deploy` nexin. Her dem skrîptên `package.json` yên rootê bikar bînin:

```bash
bun run deploy          # Her tiştî bideploy bike (app + malpera kirrûbirî)
bun run deploy:site     # Tenê malpera kirrûbirî bideploy bike
```

Meşandina `wrangler pages deploy dist` ji peldanka çewt malpera Vite ji bo Pages-ê dideploy dike li şûna malpera Astro, ku bi çewtiyên 404 malpera kirrûbirî têkstûr dike.

## Arîşeyên sepa desktop

### Nûvekirin naxebite

Sepa desktop nûvekerê Tauri ji bo kontrolkirina guhertoyên nû bikar tîne. Heke nûvekirinên nehatine kifş kirin:

- Girêdana înternetê ya xwe kontrol bikin
- Piştrast bikin ku endpoint-a nûvekerê gihîştî ye: `https://github.com/rhonda-rodododo/llamenos-platform/releases/latest/download/latest.json`
- Li Linux, nûvekirina otomatîk a AppImage hewce dike ku pel mafên nivîsandinê di peldanka xwe de hebe
- Li macOS, divê sep di `/Applications` de be (ne ji DMG-ê rasterast bixebite)

Ji bo nûvekirina destan, dawiya guhertoyê ji rûpela [Download](/download) daxûstandin.

### Açikirina PIN têkstûr dibe

Heke PIN-a we li ser sepa desktop were red kirin:

- Piştrast bikin ku hûn PIN-a rast têkevin (tu "PIN ji bîr kir" tune)
- PIN-ên ku tîpan dihewînin ji bo mezinî-çûçik bihêz in
- Heke hûn PIN-a xwe ji bîr kirine, divê hûn nsec-a xwe ji nû ve têkevin da ku ya nû saz bikin. Nîşokên we yên şîfrekirî berdewam gihîştî ne ji ber ku ew bi nasnameya we ve girêdayî ne, ne bi PIN-a we
- Tauri Stronghold nsec-a we bi kilîta ku ji PIN hatiye derxistin (PBKDF2) şîfre dike. PIN-ek çewt dekîfrekirinê çewt çêdike, ne peyamek çewt -- sepan ev bi erêkirina kilîta giştî ya hatiye derxistin kifş dike

### Vegirtina kilîtê

Heke hûn gihiştina amûra xwe ji dest dabin:

1. Nsec-a xwe (ku divê hûn tomar kiribin di rêveberê şîfreyan de) bikar bînin da ku li ser amûrek nû têkevin
2. Heke hûn nasnameyek WebAuthn passkey tomar kirine, hûn dikarin li şûna wê li ser amûra nû bikar bînin
3. Nîşokên we yên şîfrekirî li aliyê serverê têne tomar kirin -- dema ku hûn bi heman nasnameyê têkevin, hûn dikarin wan veşêrin
4. Heke hûn hem nsec û hem jî passkey xwe ji dest dabin, bi rêveberê xwe re têkilî daynin. Ew nikarin nsec-a we vegirin, lê dikarin nasnameyek nû ji bo we çêbikin. Nîşokên ku ji bo nasnameya weya kevn hatine şîfre kirin êdî ji bo we ne xwendin

### Sep dest pê nake (paceleya vala)

- Kontrol bikin ku pergala we pêwîstiyên kêmtirîn pêk tîne (ji bo hûrgulî [Download](/download) bibînin)
- Li Linux, piştrast bikin ku WebKitGTK hatiye sazkirin: `sudo apt install libwebkit2gtk-4.1-0` (Debian/Ubuntu) an jî hevber
- Ji bo dîtina çewtiyên derketinê, ji terminalê bixin: `./llamenos` (AppImage) an jî logên pergala kontrol bikin
- Heke Wayland bikar tînin, bi `GDK_BACKEND=x11` wekî alternatîf biceribînin

### Nakokiya instance-ya yekane

Llamenos moda yek-instance ferz dike. Heke sep dibêje ku berê dixebite lê hûn paceleyê nabînin:

- Ji bo pêvajoyên paşnavê kontrol bikin: `ps aux | grep llamenos`
- Hemû pêvajoyên yetîm bikuje: `pkill llamenos`
- Li Linux, ji bo pelê kilîtê ya kevn kontrol bikin û heke sep qeza bûye wê jê bibin

## Arîşeyên sepa mobîl

### Têkiliyên provisioning

Ji bo çareserkirina arîşeyên provisioning-ê ya berfireh, [Rêbera Mobîl](/docs/mobile-guide#troubleshooting-mobile-issues) bibînin.

Sedemên hevpar:
- QR code biqede (token piştî 5 deqîqan biqede)
- Tu girêdana înternetê li ser her du amûran
- Sepa desktop û sepa mobîl guhertoyên protokolê yên cuda dixebitînin

### Hişyariyên push nagihin

- Mafên hişyariyê di mîhengên OS de hatine dayîn piştrast bikin
- Li Android, kontrol bikin ku optimîzasyona pîlê sepê li paşnavê nakuje
- Li iOS, piştrast bikin ku Background App Refresh ji bo Llamenos çalak e
- Kontrol bikin ku hûn şevek çalak heye û li ser betilandinê nînin

## Arîşeyên telefoniyê

### Mîhengkirina webhookê ya Twilio

Heke bang ber bi xwebexşan nayên rêvebirin:

1. URL-yên webhookê yên xwe di panela Twilio de piştrast bikin:
   - Webhook-a deng: `https://your-worker.your-domain.com/telephony/incoming` (POST)
   - Callback-a statûyê: `https://your-worker.your-domain.com/telephony/status` (POST)
2. Kontrol bikin ku nasnameyên Twilio di mîhengên we de bi panelê re li hev tên:
   - Account SID
   - Auth Token
   - Hejmara telefonê (divê koda welatê tê de be, mînak, `+1234567890`)
3. Ji bo çewtiyan debugger-a Twilio kontrol bikin: [twilio.com/console/debugger](https://www.twilio.com/console/debugger)

### Sazkirina hejmarê

- Hejmara telefonê divê hejmarek Twilio be an jî nasnameyek bangerê ya erêkirî
- Ji bo pêşvebirinê ya herêmî, Cloudflare Tunnel an ngrok bikar bînin da ku Worker-a herêmî ya xwe ji Twilio re eşkere bikin
- Piştrast bikin ku mîhengkirina Voice ya hejmarê ber bi URL-ya webhookê ya we tê, ne TwiML Bin-a xwerû

### Bang girêdidin lê deng tune

- Piştrast bikin ku serverên medya yên pêşkêşkarê telefoniyê dikarin bigihin telefona xwebexş
- Ji bo arîşeyên NAT/firewall ku trafîka RTP asteng dikin kontrol bikin
- Heke WebRTC bikar tînin, piştrast bikin ku serverên STUN/TURN hatine mîhengkirin
- Hin VPN trafîka VoIP asteng dikin -- bêyî VPN biceribînin

### Peyamên SMS/WhatsApp nagihin

- URL-yên webhookê yên peyaman di panela pêşkêşkarê xwe de rast hatine mîhengkirin piştrast bikin
- Ji bo WhatsApp, piştrast bikin ku tokena verastkirina webhookê ya Meta bi mîhengên we re li hev tê
- Kontrol bikin ku kanala peyamê di **Admin Settings > Channels** de çalak e
- Ji bo Signal, piştrast bikin ku bridge-a signal-cli dixebite û hatiye mîhengkirin ku ber bi webhookê we ve were şandin

## Çewtiyên kripto

### Çewtiyên lihevnekirina kilîtê

**"Vekirina şîfrekirinê têkstûr bû" an "Kilîta çewt" dema ku nîşok tên vekirin:**

- Ev bi gelemperî tê vê wateyê ku nîşok ji bo nasnameyek cuda ji ya ku hûn bi wê têketine hatiye şîfre kirin
- Piştrast bikin ku hûn nsec-a rast bikar tînin (npub-a we di Settings de bi ya ku rêveber dibîne re li hev bîne)
- Heke hûn nêzîkê nasnameya xwe ji nû ve ava kirine, nîşokên kevn ku ji bo kilîta giştîya weya berê hatine şîfre kirin bi kilîta nû nikarin bêne vekirin

**"Îmaza çewt" dema ku têketinê:**

- Dibe ku nsec şikestî be -- ji rêveberê şîfreyan dîsa têkevin
- Piştrast bikin ku nsec-a tevahî hatiye paste kirin (bi `nsec1` dest pê dike, bi tevahî 63 karakter)
- Ji bo karakterên vala an jî nûlineyên zêde kontrol bikin

### Têkiliyên erêkirina îmazê

Heke bûyerên hub erêkirina îmazê têkstûr bibin:

- Piştrast bikin ku saeta pergala we hevseng e (NTP). Cihê demê yên mezin dikarin bi timestamp-ên bûyerê arîşe çêbikin
- Piştrast bikin ku WebSocket relay bûyerên ji pubkey-ên nenas nagire
- Sep ji nû ve bidin destpêkirin da ku lîsta endamên heyî ya hub-ê dîsa bistînin

### Çewtiyên envelope-a ECIES

**"Vekirina kilîtê têkstûr bû" dema ku nîşok tê vekirin:**

- Dibe ku envelope-a ECIES bi kilîta giştî ya çewt hatibe çêkirin
- Ev dikare çêbibe heke rêveber xwebexşek bi çewtiya di pubkey de lê zêde kiribe
- Rêveber divê kilîta giştî ya xwebexşê piştrast bike û hewce be dîsa vexwîne

**"Dirêjahiya ciphertext çewt":**

- Ev nîşana şikestina daneyê ye, dibe ku ji bersiva torê ya kurt
- Operasyonê dîsa biceribînin. Heke berdewam dike, daneyên şîfrekirî dibe ku bi temamî şikestî bin
- Ji bo arîşeyên proxy an CDN ku dikarin laşên bersivê kurt bikin kontrol bikin

### Çewtiyên kilîta hub

**"Bûyera hub nehat vekirin":**

- Dibe ku kilîta hub ji dema ku we cara dawî girêdayî bûye hatibe nûve kirin
- Sep bigirin û dîsa vekin da ku kilîta hub-ê ya herî dawî bistînin
- Heke we nêzîkê ji hub hatibe jêbirin û dîsa lê zêde kirin, dibe ku kilît di dema nebûna we de hatibe nûve kirin

## Alîkarî bistînin

Heke arîşa we li vir nehatiye nav xwe kirin:

- [GitHub Issues](https://github.com/rhonda-rodododo/llamenos-platform/issues) ji bo çewtiyên naskirî û alternatîfan kontrol bikin
- Berî ku yek nû çêbikin, arîşeyên heyî lê bigerin
- Dema ku raportek çewtiyê dikin, ev tê de bibin: moda sazkirina we (Cloudflare/Docker/Kubernetes), platform (Desktop/Mobîl), û her peyamên çewtiyê ji konsola gerok an terminalê
