---
title: Troubleshooting
description: Solutions for common issues with deployment, the desktop app, mobile app, telephony, and cryptographic operations.
---

This guide covers common issues and their solutions across all Llamenos deployment modes and platforms.

## Docker deployment issues

### Containers fail to start

**Missing environment variables:**

Docker Compose validates all services at startup, even profiled ones. If you see errors about missing variables, make sure your `.env` file includes all required values:

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

Even if you are not using the Asterisk bridge, Docker Compose validates its service definition and requires `ARI_PASSWORD` and `BRIDGE_SECRET` to be set.

**Port conflicts:**

If a port is already in use, check which process holds it:

```bash
# Check what's using port 8787 (Worker)
sudo lsof -i :8787

# Check what's using port 5432 (PostgreSQL)
sudo lsof -i :5432

# Check what's using port 9000 (RustFS)
sudo lsof -i :9000
```

Stop the conflicting process or change the port mapping in `docker-compose.yml`.

### Database connection errors

If the app cannot connect to PostgreSQL:

- Verify the `PG_PASSWORD` in `.env` matches what was used when the container was first created
- Check that the PostgreSQL container is healthy: `docker compose ps`
- If the password was changed, you may need to remove the volume and recreate: `docker compose down -v && docker compose up -d`

### Strfry relay not connecting

The WebSocket relay is a core service, not optional. If the relay is not running:

```bash
# Check relay status
docker compose logs WebSocket relay

# Restart the relay
docker compose restart WebSocket relay
```

If the relay fails to start, check for port 7777 conflicts or insufficient permissions on the data directory.

### RustFS / S3 storage errors

- Verify `STORAGE_ACCESS_KEY` and `STORAGE_SECRET_KEY` are correct
- Check that the RustFS container is running: `docker compose ps rustfs`
- Access the RustFS console at `http://localhost:9001` to verify bucket creation

## Cloudflare deployment issues

### Durable Object errors

**"Durable Object not found" or binding errors:**

- Run `bun run deploy` (never `wrangler deploy` directly) to ensure DO bindings are correct
- Check `wrangler.jsonc` for correct DO class names and bindings
- After adding a new DO, you must deploy before it becomes available

**DO storage limits:**

Cloudflare Durable Objects have a 128 KB limit per key-value pair. If you see storage errors:

- Ensure note content is not exceeding the limit (very large notes with many attachments)
- Check that ECIES envelopes are not being duplicated

### Worker errors (500 responses)

Check Worker logs:

```bash
bunx wrangler tail
```

Common causes:
- Missing secrets (use `bunx wrangler secret list` to verify)
- Incorrect `ADMIN_PUBKEY` format (must be 64 hex characters, no `npub` prefix)
- Rate limiting on free tier (1,000 requests/minute on Workers Free)

### Deployment fails with "Pages deploy" errors

Never run `wrangler pages deploy` or `wrangler deploy` directly. Always use the root `package.json` scripts:

```bash
bun run deploy          # Deploy everything (app + marketing site)
bun run deploy:site     # Deploy marketing site only
```

Running `wrangler pages deploy dist` from the wrong directory deploys the Vite app build to Pages instead of the Astro site, breaking the marketing site with 404 errors.

## Desktop app issues

### Auto-update not working

The desktop app uses the Tauri updater to check for new versions. If updates are not being detected:

- Check your internet connection
- Verify that the update endpoint is reachable: `https://github.com/rhonda-rodododo/llamenos-platform/releases/latest/download/latest.json`
- On Linux, AppImage auto-update requires the file to have write permissions in its directory
- On macOS, the app must be in `/Applications` (not running from the DMG directly)

To manually update, download the latest release from the [Download](/download) page.

### PIN unlock fails

If your PIN is rejected on the desktop app:

- Make sure you are entering the correct PIN (there is no "forgot PIN" recovery)
- PINs are case-sensitive if they contain letters
- If you have forgotten your PIN, you must re-enter your nsec to set a new one. Your encrypted notes remain accessible because they are tied to your identity, not your PIN
- The Tauri Stronghold encrypts your nsec with the PIN-derived key (PBKDF2). A wrong PIN produces an invalid decryption, not an error message — the app detects this by verifying the derived public key

### Key recovery

If you have lost access to your device:

1. Use your nsec (which you should have stored in a password manager) to log in on a new device
2. If you registered a WebAuthn passkey, you can use it on the new device instead
3. Your encrypted notes are stored server-side — once you log in with the same identity, you can decrypt them
4. If you have lost both your nsec and your passkey, contact your admin. They cannot recover your nsec, but they can create a new identity for you. Notes encrypted for your old identity will no longer be readable by you

### App does not start (blank window)

- Check that your system meets the minimum requirements (see [Download](/download))
- On Linux, ensure WebKitGTK is installed: `sudo apt install libwebkit2gtk-4.1-0` (Debian/Ubuntu) or equivalent
- Try launching from the terminal to see error output: `./llamenos` (AppImage) or check system logs
- If using Wayland, try with `GDK_BACKEND=x11` as a fallback

### Single instance conflict

Llamenos enforces single-instance mode. If the app says it is already running but you cannot find the window:

- Check for background processes: `ps aux | grep llamenos`
- Kill any orphaned processes: `pkill llamenos`
- On Linux, check for a stale lock file and remove it if the app crashed

## Mobile app issues

### Provisioning failures

See the [Mobile Guide](/docs/mobile-guide#troubleshooting-mobile-issues) for detailed provisioning troubleshooting.

Common causes:
- Expired QR code (tokens expire after 5 minutes)
- No internet connection on either device
- Desktop app and mobile app running different protocol versions

### Push notifications not arriving

- Verify notification permissions are granted in OS settings
- On Android, check that battery optimization is not killing the app in the background
- On iOS, verify that Background App Refresh is enabled for Llamenos
- Check that you have an active shift and are not on break

## Telephony issues

### Twilio webhook configuration

If calls are not routing to volunteers:

1. Verify your webhook URLs are correct in the Twilio console:
   - Voice webhook: `https://your-worker.your-domain.com/telephony/incoming` (POST)
   - Status callback: `https://your-worker.your-domain.com/telephony/status` (POST)
2. Check that the Twilio credentials in your settings match the console:
   - Account SID
   - Auth Token
   - Phone number (must include country code, e.g., `+1234567890`)
3. Check the Twilio debugger for errors: [twilio.com/console/debugger](https://www.twilio.com/console/debugger)

### Number setup

- The phone number must be a Twilio-owned number or a verified caller ID
- For local development, use a Cloudflare Tunnel or ngrok to expose your local Worker to Twilio
- Verify the number's Voice configuration points to your webhook URL, not the default TwiML Bin

### Calls connect but no audio

- Ensure the telephony provider's media servers can reach the volunteer's phone
- Check for NAT/firewall issues blocking RTP traffic
- If using WebRTC, verify that STUN/TURN servers are configured correctly
- Some VPNs block VoIP traffic — try without the VPN

### SMS/WhatsApp messages not arriving

- Verify the messaging webhook URLs are configured correctly in your provider's console
- For WhatsApp, ensure the Meta webhook verification token matches your settings
- Check that the messaging channel is enabled in **Admin Settings > Channels**
- For Signal, verify the signal-cli bridge is running and configured to forward to your webhook

## Crypto errors

### Key mismatch errors

**"Failed to decrypt" or "Invalid key" when opening notes:**

- This usually means the note was encrypted for a different identity than the one you are logged in with
- Verify you are using the correct nsec (check your npub in Settings matches what the admin sees)
- If you recently re-created your identity, old notes encrypted for your previous public key will not be decryptable with the new key

**"Invalid signature" on login:**

- The nsec may be corrupted — try re-entering it from your password manager
- Ensure the full nsec is pasted (starts with `nsec1`, 63 characters total)
- Check for extra whitespace or newline characters

### Signature verification failures

If hub events fail signature verification:

- Check that the system clock is synchronized (NTP). Large clock skew can cause issues with event timestamps
- Verify that the WebSocket relay is not relaying events from unknown pubkeys
- Restart the app to re-fetch the current hub member list

### ECIES envelope errors

**"Failed to unwrap key" on note decryption:**

- The ECIES envelope may have been created with an incorrect public key
- This can happen if the admin added a volunteer with a typo in the pubkey
- The admin should verify the volunteer's public key and re-invite if necessary

**"Invalid ciphertext length":**

- This indicates data corruption, possibly from a truncated network response
- Retry the operation. If it persists, the encrypted data may be permanently corrupted
- Check for proxy or CDN issues that might truncate response bodies

### Hub key errors

**"Failed to decrypt hub event":**

- The hub key may have been rotated since you last connected
- Close and reopen the app to fetch the latest hub key
- If you were recently removed and re-added to the hub, the key may have rotated during your absence

## Getting help

If your issue is not covered here:

- Check the [GitHub Issues](https://github.com/rhonda-rodododo/llamenos-platform/issues) for known bugs and workarounds
- Search existing issues before creating a new one
- When reporting a bug, include: your deployment mode (Cloudflare/Docker/Kubernetes), platform (Desktop/Mobile), and any error messages from the browser console or terminal
