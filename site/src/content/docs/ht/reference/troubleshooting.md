---
title: Depannaj
description: Solisyon pou pwoblèm kouran ak deplwaman, aplikasyon biwo, aplikasyon mobil, telefoni, ak operasyon kriptografik.
---

Gid sa a kouvri pwoblèm kouran ak solisyon yo nan tout mòd deplwaman ak platfòm Llamenos.

## Pwoblèm deplwaman Docker

### Konteyè yo pa kòmanse

**Varyab anviwonnman ki manke :**

Docker Compose valide tout sèvis yo nan demarraj, menm ki gen pwofil. Si ou wè erè sou varyab ki manke, asire fichye `.env` ou genyen tout valè obligatwa :

```bash
# Obligatwa nan .env pou Docker Compose
PG_PASSWORD=your_postgres_password
STORAGE_ACCESS_KEY=your_rustfs_access_key
STORAGE_SECRET_KEY=your_rustfs_secret_key
HMAC_SECRET=your_hmac_secret
ARI_PASSWORD=your_ari_password       # Obligatwa menm si ou pa itilize Asterisk
BRIDGE_SECRET=your_bridge_secret     # Obligatwa menm si ou pa itilize Asterisk
ADMIN_PUBKEY=your_admin_hex_pubkey
```

Menm si ou pa itilize bridge Asterisk la, Docker Compose valide definisyon sèvis li a epi mande `ARI_PASSWORD` ak `BRIDGE_SECRET` pou defini.

**Konfli pò :**

Si yon pò deja nan itilizasyon, verifye ki pwosesis ki kenbe li :

```bash
# Verifye sa k ap itilize pò 8787 (Worker)
sudo lsof -i :8787

# Verifye sa k ap itilize pò 5432 (PostgreSQL)
sudo lsof -i :5432

# Verifye sa k ap itilize pò 9000 (RustFS)
sudo lsof -i :9000
```

Kanpe pwosesis ki an konfli a oswa chanje mapaj pò nan `docker-compose.yml`.

### Erè koneksyon baz done

Si aplikasyon an pa kapab konekte ak PostgreSQL :

- Verifye `PG_PASSWORD` nan `.env` matche sa ki te itilize lè konteyè a te kreye premye fwa
- Verifye konteyè PostgreSQL la an bon sante : `docker compose ps`
- Si modpas la chanje, ou ka bezwen retire volim nan epi rekree : `docker compose down -v && docker compose up -d`

### Relè Strfry pa konekte

Relè WebSocket se yon sèvis prensipal, pa opsyonèl. Si relè a pa kouri :

```bash
# Verifye estati relè a
docker compose logs WebSocket relay

# Rekòmanse relè a
docker compose restart WebSocket relay
```

Si relè a pa kòmanse, verifye konfli pò 7777 oswa pèmisyon ensifizans sou repertwa done a.

### Erè estokaj RustFS / S3

- Verifye `STORAGE_ACCESS_KEY` ak `STORAGE_SECRET_KEY` kòrèk
- Verifye konteyè RustFS a kouri : `docker compose ps rustfs`
- Aksede konsòl RustFS a nan `http://localhost:9001` pou verifye kreyasyon seau

## Pwoblèm deplwaman Cloudflare

### Erè Durable Object

**"Durable Object not found" oswa erè binding :**

- Kouri `bun run deploy` (pa janm `wrangler deploy` dirèkteman) pou asire binding DO yo kòrèk
- Verifye `wrangler.jsonc` pou non klas DO ak binding kòrèk
- Apre ajoute yon nouvo DO, ou dwe deplwaye anvan li disponib

**Limit estokaj DO :**

Cloudflare Durable Objects gen yon limit 128 Ko pa pè kle-valè. Si ou wè erè estokaj :

- Asire kontni nòt pa depase limit la (nòt trè gwo ak anpil atachman)
- Verifye anvlòp ECIES pa dupliye

### Erè Worker (500 repons)

Verifye jounal Worker :

```bash
bunx wrangler tail
```

Kòz kouran :
- Sekrè ki manke (itilize `bunx wrangler secret list` pou verifye)
- Fòma `ADMIN_PUBKEY` enkòrèk (dwe 64 karaktè hex, san prefiks `npub`)
- Rate limiting sou nivo gratis (1,000 demann/minit sou Workers Free)

### Deplwaman echwe ak erè "Pages deploy"

Pa janm kouri `wrangler pages deploy` oswa `wrangler deploy` dirèkteman. Toujou itilize skrip `package.json` rasin yo :

```bash
bun run deploy          # Deplwaye tout bagay (app + sit maketing)
bun run deploy:site     # Deplwaye sèlman sit maketing
```

Kouri `wrangler pages deploy dist` soti nan move repertwa deplwaye build Vite app la nan Pages olye sit Astro a, kase sit maketing la ak erè 404.

## Pwoblèm aplikasyon biwo

### Mizajou otomatik pa fonksyone

Aplikasyon biwo a itilize Tauri updater pou verifye nouvèl vèsyon. Si mizajou pa detekte :

- Verifye koneksyon entènèt ou
- Verifye pwen finisman mizajou aksesib : `https://github.com/rhonda-rodododo/llamenos-platform/releases/latest/download/latest.json`
- Sou Linux, mizajou otomatik AppImage mande fichye a gen pèmisyon ekri nan repertwa li
- Sou macOS, aplikasyon an dwe nan `/Applications` (pa kouri soti nan DMG dirèkteman)

Pou mete ajou manyèlman, telechaje dènye vèsyon an soti nan paj [Telechajman](/download).

### Debloukaj PIN echwe

Si PIN ou rejte nan aplikasyon biwo :

- Asire ou ap antre PIN kòrèk la (pa gen rekiperasyon "bliye PIN")
- PIN yo ka-ka-sensitif si yo genyen lèt
- Si ou bliye PIN ou, ou dwe resaisi nsec ou pou defini yon nouvo. Nòt chifre ou yo rete aksesib paske yo mare ak idantite ou, pa PIN ou
- Tauri Stronghold chifre nsec ou ak kle derive PIN (PBKDF2). Yon PIN fos pwodui yon dechifraj envalid, pa yon mesaj erè — aplikasyon an detekte sa lè l verifye kle piblik derive a

### Rekiperasyon kle

Si ou pedi aksè nan aparèy ou :

1. Itilize nsec ou (ke ou ta dwe estoke nan yon jestyon modpas) pou konekte sou yon nouvo aparèy
2. Si ou anrejistre yon paskey WebAuthn, ou ka itilize li sou nouvo aparèy la
3. Nòt chifre ou yo estoke sèvè — yon fwa ou konekte ak menm idantite, ou ka dechifre yo
4. Si ou pedi nsec ak paskey ou a, kontakte admin ou. Yo pa ka rekipere nsec ou, men yo ka kreye yon nouvo idantite pou ou. Nòt ki chifre pou ansyen idantite ou a pa pral lisib pa ou ankò

### Aplikasyon pa kòmanse (fenèt vid)

- Verifye sistèm ou satisfè egzijans minimòm (gade [Telechajman](/download))
- Sou Linux, asire WebKitGTK enstale : `sudo apt install libwebkit2gtk-4.1-0` (Debian/Ubuntu) oswa ekvalan
- Eseye kouri soti nan tèminal pou wè sòti erè : `./llamenos` (AppImage) oswa verifye jounal sistèm
- Si ou ap itilize Wayland, eseye ak `GDK_BACKEND=x11` kòm yon dènyè rekours

### Konfli yon sèl enstans

Llamenos aplike mòd yon sèl enstans. Si aplikasyon an di li deja kouri men ou pa ka jwenn fenèt la :

- Verifye pwosesis background : `ps aux | grep llamenos`
- Touye nenpòt pwosesis ofant : `pkill llamenos`
- Sou Linux, verifye yon fichye vèrouye demode epi retire li si aplikasyon an plante

## Pwoblèm aplikasyon mobil

### Echèk pwovizyon

Gade [Gid Mobil](/docs/mobile-guide#troubleshooting-mobile-issues) pou depannaj pwovizyon detaye.

Kòz kouran :
- Kòd QR ekspiré (jeton ekspire apre 5 minit)
- Pa gen koneksyon entènèt sou youn nan de aparèy yo
- Aplikasyon biwo ak aplikasyon mobil kouri diferan vèsyon protokòl

### Notifikasyon push pa rive

- Verifye pèmisyon notifikasyon akòde nan paramèt OS
- Sou Android, verifye optimizasyon batri pa touye aplikasyon nan background
- Sou iOS, verifye Rechaj Aplikasyon Background aktive pou Llamenos
- Verifye ou gen yon vire wouk aktif epi ou pa nan poz

## Pwoblèm telefoni

### Konfigirasyon webhook Twilio

Si apèl yo pa route pou vòlontè :

1. Verifye URL webhook ou yo kòrèk nan konsòl Twilio :
   - Webhook vwa : `https://your-worker.your-domain.com/telephony/incoming` (POST)
   - Callback estati : `https://your-worker.your-domain.com/telephony/status` (POST)
2. Verifye kalifikasyon Twilio nan paramèt ou matche konsòl la :
   - Account SID
   - Auth Token
   - Nimewo telefòn (dwe genyen kòd peyi, pa egzanp `+1234567890`)
3. Verifye debbugeur Twilio pou erè : [twilio.com/console/debugger](https://www.twilio.com/console/debugger)

### Konfigirasyon nimewo

- Nimewo telefòn dwe yon nimewo Twilio-posede oswa yon ID moun k ap rele verifye
- Pou devlopman lokal, itilize yon Cloudflare Tunnel oswa ngrok pou ekspoze Worker lokal ou nan Twilio
- Verifye konfigirasyon Vwa nimewo a montre sou URL webhook ou a, pa TwiML Bin defo a

### Apèl konekte men pa gen son

- Asire sèvè medya founisè telefoni a ka rive nan telefòn vòlontè a
- Verifye pwoblèm NAT/firewall ki bloke trafik RTP
- Si ou ap itilize WebRTC, verifye sèvè STUN/TURN konfigire kòrèkteman
- Kèk VPN bloke trafik VoIP — eseye san VPN

### Mesaj SMS/WhatsApp pa rive

- Verifye URL webhook mesaj yo konfigire kòrèkteman nan konsòl founisè ou a
- Pou WhatsApp, asire jeton verifikasyon webhook Meta matche paramèt ou yo
- Verifye chanèl mesaj la aktive nan **Paramèt Admin > Chanèl**
- Pou Signal, verifye bridge signal-cli kouri epi konfigire pou transfere nan webhook ou a

## Erè kriptografik

### Erè kle pa matche

**"Echèk dechifraj" oswa "Kle envalid" lè ou ouvri nòt :**

- Sa anjeneral vle di nòt la te chifre pou yon idantite diferan de youn ou konekte ak
- Verifye ou ap itilize nsec kòrèk la (verifye npub ou nan Paramèt matche sa admin wè a)
- Si ou rekreye idantite ou resamman, ansyen nòt ki chifre pou ansyen kle piblik ou pa pral dechifrab ak nouvo kle a

**"Siyati envalid" sou koneksyon :**

- nsec la ka korónpe — eseye resaisi li soti nan jestyon modpas ou
- Asire nsec konplè a kole (kòmanse ak `nsec1`, 63 karaktè total)
- Verifye pou espas ekstra oswa karaktè retou a laliy

### Echèk verifikasyon siyati

Si evènman hub echwe verifikasyon siyati :

- Verifye oraj sistèm senkronize (NTP). Gwo dekalkaj oraj ka koze pwoblèm ak timestamp evènman
- Verifye relè WebSocket pa relè evènman ki soti nan pubkey enkoni
- Relance aplikasyon an pou rekipere lis manm hub aktyèl la

### Erè anvlòp ECIES

**"Echèk devlopman kle" sou dechifraj nòt :**

- Anvlòp ECIES la ka kreye ak yon kle piblik enkòrèk
- Sa ka pase si admin ajoute yon vòlontè ak yon erè tèp nan pubkey
- Admin ta dwe verifye kle piblik vòlontè a epi envite ankò si nesesè

**"Longè tèks chifre envalid" :**

- Sa endike kòripsyon done, posibleman soti nan yon repons rezo tronke
- Eseye operasyon an ankò. Si li kontinye, done chifre yo ka korónpe pèmanantman
- Verifye pwoblèm proxy oswa CDN ki ka tronke kò repons

### Erè kle hub

**"Echèk dechifraj evènman hub" :**

- Kle hub la ka woulte depi dènye fwa ou konekte
- Fèmen ak rouvri aplikasyon an pou jwenn dènye kle hub la
- Si ou te retire resamman epi ajoute nan hub la, kle a ka te woulte pandan absans ou

## Jwenn èd

Si pwoblèm ou pa kouvri la a :

- Verifye [GitHub Issues](https://github.com/rhonda-rodododo/llamenos-platform/issues) pou bug ki konnen ak solisyon travay
- Rechèche pwoblèm egzistan anvan ou kreye yon nouvo
- Lè ou rapòte yon bug, enkli : mòd deplwaman ou (Cloudflare/Docker/Kubernetes), platfòm (Biwo/Mobil), ak nenpòt mesaj erè soti nan konsòl navigatè oswa tèminal
