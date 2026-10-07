---
title: Fehlerbehebung
description: Loesungen fuer haeufige Probleme mit Bereitstellung, Desktop-App, Mobile-App, Telefonie und kryptografischen Operationen.
---

Dieser Leitfaden behandelt haeufige Probleme und deren Loesungen ueber alle Llamenos-Bereitstellungsmodi und Plattformen hinweg.

## Docker-Bereitstellungsprobleme

### Container starten nicht

**Fehlende Umgebungsvariablen:**

Docker Compose validiert alle Dienste beim Start, auch profilierte. Wenn Sie Fehler ueber fehlende Variablen sehen, stellen Sie sicher, dass Ihre `.env`-Datei alle erforderlichen Werte enthaelt:

```bash
# Erforderlich in .env fuer Docker Compose
PG_PASSWORD=ihr_postgres_passwort
STORAGE_ACCESS_KEY=ihr_rustfs_zugangsschluessel
STORAGE_SECRET_KEY=ihr_rustfs_geheimschluessel
HMAC_SECRET=ihr_hmac_geheimnis
ARI_PASSWORD=ihr_ari_passwort       # Erforderlich auch ohne Asterisk
BRIDGE_SECRET=ihr_bridge_geheimnis  # Erforderlich auch ohne Asterisk
ADMIN_PUBKEY=ihre_admin_hex_pubkey
```

Auch wenn Sie die Asterisk-Bridge nicht verwenden, validiert Docker Compose deren Dienstdefinition und erfordert, dass `ARI_PASSWORD` und `BRIDGE_SECRET` gesetzt sind.

**Port-Konflikte:**

Wenn ein Port bereits belegt ist, pruefen Sie, welcher Prozess ihn verwendet:

```bash
# Pruefen, was Port 8787 verwendet (Worker)
sudo lsof -i :8787

# Pruefen, was Port 5432 verwendet (PostgreSQL)
sudo lsof -i :5432

# Pruefen, was Port 9000 verwendet (RustFS)
sudo lsof -i :9000
```

Stoppen Sie den konfliktverursachenden Prozess oder aendern Sie das Port-Mapping in `docker-compose.yml`.

### Datenbankverbindungsfehler

Wenn die App keine Verbindung zu PostgreSQL herstellen kann:

- Ueberpruefen Sie, ob das `PG_PASSWORD` in `.env` mit dem uebereinstimmt, das beim ersten Erstellen des Containers verwendet wurde
- Pruefen Sie, ob der PostgreSQL-Container gesund ist: `docker compose ps`
- Wenn das Passwort geaendert wurde, muessen Sie moeglicherweise das Volume entfernen und neu erstellen: `docker compose down -v && docker compose up -d`

### Strfry-Relay verbindet sich nicht

Das WebSocket-Relay ist ein Kerndienst, nicht optional. Wenn das Relay nicht laeuft:

```bash
# Relay-Status pruefen
docker compose logs WebSocket relay

# Relay neu starten
docker compose restart WebSocket relay
```

Wenn das Relay nicht startet, pruefen Sie auf Konflikte an Port 7777 oder unzureichende Berechtigungen im Datenverzeichnis.

### RustFS / S3-Speicherfehler

- Ueberpruefen Sie, ob `STORAGE_ACCESS_KEY` und `STORAGE_SECRET_KEY` korrekt sind
- Pruefen Sie, ob der RustFS-Container laeuft: `docker compose ps rustfs`
- Greifen Sie auf die RustFS-Konsole unter `http://localhost:9001` zu, um die Bucket-Erstellung zu ueberpruefen

## Cloudflare-Bereitstellungsprobleme

### Durable-Object-Fehler

**"Durable Object not found" oder Binding-Fehler:**

- Fuehren Sie `bun run deploy` aus (niemals `wrangler deploy` direkt), um sicherzustellen, dass DO-Bindings korrekt sind
- Pruefen Sie `wrangler.jsonc` auf korrekte DO-Klassennamen und Bindings
- Nach dem Hinzufuegen eines neuen DO muessen Sie deployen, bevor es verfuegbar wird

**DO-Speicherlimits:**

Cloudflare Durable Objects haben ein Limit von 128 KB pro Schluessel-Wert-Paar. Wenn Sie Speicherfehler sehen:

- Stellen Sie sicher, dass Notizinhalte das Limit nicht ueberschreiten (sehr grosse Notizen mit vielen Anhaengen)
- Pruefen Sie, ob ECIES-Envelopes nicht dupliziert werden

### Worker-Fehler (500-Antworten)

Pruefen Sie die Worker-Logs:

```bash
bunx wrangler tail
```

Haeufige Ursachen:
- Fehlende Secrets (verwenden Sie `bunx wrangler secret list` zur Ueberpruefung)
- Falsches `ADMIN_PUBKEY`-Format (muss 64 Hex-Zeichen sein, kein `npub`-Praefix)
- Rate-Limiting im kostenlosen Tarif (1.000 Anfragen/Minute bei Workers Free)

### Bereitstellung schlaegt mit "Pages deploy"-Fehlern fehl

Fuehren Sie niemals `wrangler pages deploy` oder `wrangler deploy` direkt aus. Verwenden Sie immer die Skripte aus der `package.json` im Stammverzeichnis:

```bash
bun run deploy          # Alles bereitstellen (App + Marketing-Site)
bun run deploy:site     # Nur Marketing-Site bereitstellen
```

Das Ausfuehren von `wrangler pages deploy dist` aus dem falschen Verzeichnis stellt den Vite-App-Build auf Pages bereit statt der Astro-Site, was die Marketing-Site mit 404-Fehlern zerstoert.

## Desktop-App-Probleme

### Auto-Update funktioniert nicht

Die Desktop-App verwendet den Tauri Updater, um nach neuen Versionen zu suchen. Wenn Updates nicht erkannt werden:

- Ueberpruefen Sie Ihre Internetverbindung
- Ueberpruefen Sie, ob der Update-Endpunkt erreichbar ist: `https://github.com/rhonda-rodododo/llamenos-platform/releases/latest/download/latest.json`
- Unter Linux erfordert AppImage Schreibberechtigungen im Verzeichnis der Datei fuer Auto-Updates
- Unter macOS muss die App in `/Applications` sein (nicht direkt vom DMG ausfuehren)

Um manuell zu aktualisieren, laden Sie die neueste Version von der [Download](/download)-Seite herunter.

### PIN-Entsperrung schlaegt fehl

Wenn Ihre PIN in der Desktop-App abgelehnt wird:

- Stellen Sie sicher, dass Sie die richtige PIN eingeben (es gibt keine "PIN vergessen"-Wiederherstellung)
- PINs sind gross-/kleinschreibungsempfindlich, wenn sie Buchstaben enthalten
- Wenn Sie Ihre PIN vergessen haben, muessen Sie Ihren nsec erneut eingeben, um eine neue festzulegen. Ihre verschluesselten Notizen bleiben zugaenglich, da sie an Ihre Identitaet gebunden sind, nicht an Ihre PIN
- Der Tauri Stronghold verschluesselt Ihren nsec mit dem PIN-abgeleiteten Schluessel (PBKDF2). Eine falsche PIN erzeugt eine ungueltige Entschluesselung, keine Fehlermeldung -- die App erkennt dies durch Ueberpruefen des abgeleiteten oeffentlichen Schluessels

### Schluesselwiederherstellung

Wenn Sie den Zugang zu Ihrem Geraet verloren haben:

1. Verwenden Sie Ihren nsec (den Sie in einem Passwort-Manager gespeichert haben sollten), um sich auf einem neuen Geraet anzumelden
2. Wenn Sie einen WebAuthn-Passkey registriert haben, koennen Sie ihn auf dem neuen Geraet verwenden
3. Ihre verschluesselten Notizen sind serverseitig gespeichert -- sobald Sie sich mit derselben Identitaet anmelden, koennen Sie sie entschluesseln
4. Wenn Sie sowohl Ihren nsec als auch Ihren Passkey verloren haben, kontaktieren Sie Ihren Administrator. Er kann Ihren nsec nicht wiederherstellen, aber eine neue Identitaet fuer Sie erstellen. Notizen, die fuer Ihre alte Identitaet verschluesselt wurden, sind fuer Sie nicht mehr lesbar

### App startet nicht (leeres Fenster)

- Ueberpruefen Sie, ob Ihr System die Mindestanforderungen erfuellt (siehe [Download](/download))
- Unter Linux stellen Sie sicher, dass WebKitGTK installiert ist: `sudo apt install libwebkit2gtk-4.1-0` (Debian/Ubuntu) oder Aequivalent
- Versuchen Sie, vom Terminal aus zu starten, um Fehlerausgaben zu sehen: `./llamenos` (AppImage) oder pruefen Sie Systemlogs
- Bei Verwendung von Wayland versuchen Sie mit `GDK_BACKEND=x11` als Fallback

### Einzelinstanz-Konflikt

Llamenos erzwingt den Einzelinstanz-Modus. Wenn die App sagt, dass sie bereits laeuft, Sie aber das Fenster nicht finden:

- Pruefen Sie auf Hintergrundprozesse: `ps aux | grep llamenos`
- Beenden Sie verwaiste Prozesse: `pkill llamenos`
- Unter Linux pruefen Sie auf eine veraltete Sperrdatei und entfernen Sie sie, wenn die App abgestuerzt ist

## Mobile-App-Probleme

### Bereitstellungsfehler

Siehe die [Mobile-App-Anleitung](/docs/mobile-guide#fehlerbehebung-der-mobile-app) fuer detaillierte Bereitstellungs-Fehlerbehebung.

Haeufige Ursachen:
- Abgelaufener QR-Code (Tokens laufen nach 5 Minuten ab)
- Keine Internetverbindung auf einem der Geraete
- Desktop-App und Mobile-App verwenden verschiedene Protokollversionen

### Push-Benachrichtigungen kommen nicht an

- Ueberpruefen Sie, ob Benachrichtigungsberechtigungen in den OS-Einstellungen erteilt sind
- Auf Android: Pruefen Sie, ob die Akkuoptimierung die App im Hintergrund nicht beendet
- Auf iOS: Ueberpruefen Sie, ob die Hintergrund-App-Aktualisierung fuer Llamenos aktiviert ist
- Ueberpruefen Sie, ob Sie eine aktive Schicht haben und nicht in der Pause sind

## Telefonieprobleme

### Twilio-Webhook-Konfiguration

Wenn Anrufe nicht an Freiwillige weitergeleitet werden:

1. Ueberpruefen Sie, ob Ihre Webhook-URLs in der Twilio-Konsole korrekt sind:
   - Sprach-Webhook: `https://ihr-worker.ihre-domain.com/telephony/incoming` (POST)
   - Status-Callback: `https://ihr-worker.ihre-domain.com/telephony/status` (POST)
2. Pruefen Sie, ob die Twilio-Anmeldedaten in Ihren Einstellungen mit der Konsole uebereinstimmen:
   - Account SID
   - Auth Token
   - Telefonnummer (muss Landesvorwahl enthalten, z.B. `+1234567890`)
3. Pruefen Sie den Twilio-Debugger auf Fehler: [twilio.com/console/debugger](https://www.twilio.com/console/debugger)

### Nummerneinrichtung

- Die Telefonnummer muss eine Twilio-eigene Nummer oder eine verifizierte Anrufer-ID sein
- Fuer lokale Entwicklung verwenden Sie einen Cloudflare Tunnel oder ngrok, um Ihren lokalen Worker fuer Twilio erreichbar zu machen
- Ueberpruefen Sie, ob die Sprachkonfiguration der Nummer auf Ihre Webhook-URL verweist, nicht auf den Standard-TwiML-Bin

### Anrufe verbinden sich, aber kein Audio

- Stellen Sie sicher, dass die Medienserver des Telefonieanbieters das Telefon des Freiwilligen erreichen koennen
- Pruefen Sie auf NAT/Firewall-Probleme, die RTP-Traffic blockieren
- Bei WebRTC ueberpruefen Sie, ob STUN/TURN-Server korrekt konfiguriert sind
- Einige VPNs blockieren VoIP-Traffic -- versuchen Sie es ohne VPN

### SMS/WhatsApp-Nachrichten kommen nicht an

- Ueberpruefen Sie, ob die Messaging-Webhook-URLs in der Konsole Ihres Anbieters korrekt konfiguriert sind
- Fuer WhatsApp stellen Sie sicher, dass das Meta-Webhook-Verifizierungstoken mit Ihren Einstellungen uebereinstimmt
- Pruefen Sie, ob der Nachrichtenkanal in **Admin-Einstellungen > Kanaele** aktiviert ist
- Fuer Signal ueberpruefen Sie, ob die signal-cli-Bridge laeuft und zur Weiterleitung an Ihren Webhook konfiguriert ist

## Kryptografiefehler

### Schluessel-Mismatch-Fehler

**"Entschluesselung fehlgeschlagen" oder "Ungueltiger Schluessel" beim Oeffnen von Notizen:**

- Dies bedeutet normalerweise, dass die Notiz fuer eine andere Identitaet verschluesselt wurde als die, mit der Sie angemeldet sind
- Ueberpruefen Sie, ob Sie den richtigen nsec verwenden (pruefen Sie, ob Ihr npub in den Einstellungen mit dem uebereinstimmt, was der Administrator sieht)
- Wenn Sie Ihre Identitaet kuerzlich neu erstellt haben, sind alte Notizen, die fuer Ihren vorherigen oeffentlichen Schluessel verschluesselt wurden, mit dem neuen Schluessel nicht entschluesselbar

**"Ungueltige Signatur" bei der Anmeldung:**

- Der nsec koennte beschaedigt sein -- versuchen Sie, ihn aus Ihrem Passwort-Manager erneut einzugeben
- Stellen Sie sicher, dass der vollstaendige nsec eingefuegt ist (beginnt mit `nsec1`, 63 Zeichen insgesamt)
- Pruefen Sie auf zusaetzliche Leerzeichen oder Zeilenumbrueche

### Signaturverifikationsfehler

Wenn Hub-Events die Signaturverifikation nicht bestehen:

- Pruefen Sie, ob die Systemuhr synchronisiert ist (NTP). Grosse Zeitabweichungen koennen Probleme mit Event-Zeitstempeln verursachen
- Ueberpruefen Sie, ob das WebSocket-Relay keine Events von unbekannten Pubkeys weiterleitet
- Starten Sie die App neu, um die aktuelle Hub-Mitgliederliste erneut abzurufen

### ECIES-Envelope-Fehler

**"Schluessel-Enthuellung fehlgeschlagen" bei der Notiz-Entschluesselung:**

- Der ECIES-Envelope wurde moeglicherweise mit einem falschen oeffentlichen Schluessel erstellt
- Dies kann passieren, wenn der Administrator einen Freiwilligen mit einem Tippfehler im Pubkey hinzugefuegt hat
- Der Administrator sollte den oeffentlichen Schluessel des Freiwilligen ueberpruefen und bei Bedarf neu einladen

**"Ungueltige Chiffretext-Laenge":**

- Dies deutet auf Datenkorruption hin, moeglicherweise durch eine abgeschnittene Netzwerkantwort
- Versuchen Sie die Operation erneut. Wenn es weiterhin auftritt, koennten die verschluesselten Daten dauerhaft beschaedigt sein
- Pruefen Sie auf Proxy- oder CDN-Probleme, die Antworttexte abschneiden koennten

### Hub-Schluessel-Fehler

**"Hub-Event konnte nicht entschluesselt werden":**

- Der Hub-Schluessel wurde moeglicherweise seit Ihrer letzten Verbindung rotiert
- Schliessen Sie die App und oeffnen Sie sie erneut, um den neuesten Hub-Schluessel abzurufen
- Wenn Sie kuerzlich entfernt und wieder zum Hub hinzugefuegt wurden, koennte der Schluessel waehrend Ihrer Abwesenheit rotiert worden sein

## Hilfe erhalten

Wenn Ihr Problem hier nicht behandelt wird:

- Pruefen Sie die [GitHub Issues](https://github.com/rhonda-rodododo/llamenos-platform/issues) auf bekannte Fehler und Workarounds
- Suchen Sie in bestehenden Issues, bevor Sie ein neues erstellen
- Wenn Sie einen Fehler melden, geben Sie an: Ihren Bereitstellungsmodus (Cloudflare/Docker/Kubernetes), Plattform (Desktop/Mobile) und alle Fehlermeldungen aus der Browserkonsole oder dem Terminal
