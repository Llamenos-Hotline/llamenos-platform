# Certificate Pins

## Production SPKI Hashes

The production API is served from `api.<domain>` (`api.llamenos-hotline.org` for the reference
deployment). Caddy on that host terminates TLS itself with a Let's Encrypt certificate — there is no
CDN in front of it, so the chain these commands print is the chain clients actually pin against.
`app.<domain>` has no DNS record and no Caddy vhost; see `docs/deployment/first-deploy.md`.

Note that the commands below print the **leaf** and **intermediate** SPKI hashes. The pins actually
shipped (below) are **root CA** pins, regenerated from the published ISRG root certificates — see the
`curl https://letsencrypt.org/certs/isrgrootx1.pem | ...` recipe in
`apps/android/app/src/main/res/xml/network_security_config.xml`. Use the commands below to inspect a
deployed chain, not to produce the pin-set values.

Extract with:
```bash
openssl s_client -connect api.llamenos-hotline.org:443 </dev/null 2>/dev/null \
  | openssl x509 -pubkey -noout \
  | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -binary \
  | base64
```

For intermediate CA (pin this as backup, rotate leaf pin independently):
```bash
openssl s_client -connect api.llamenos-hotline.org:443 -showcerts </dev/null 2>/dev/null \
  | awk '/BEGIN CERT/{c++} c==2{print}' \
  | openssl x509 -pubkey -noout \
  | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -binary \
  | base64
```

## Current Pins

Pinning strategy: root CA pins (ISRG Root X1 + X2) so that routine leaf-cert
renewal never breaks the app. Two independent CA roots for backup (RFC 7469 §2.5).

| Domain | Type | Hash (base64 SHA-256 SPKI) | Expires |
|--------|------|---------------------------|---------|
| *.llamenos-hotline.org | ISRG Root X1 (RSA 4096) | `C5+lpZ7tcVwmwQIMcRtPbsQtWLABXhQzejna0wHFr8M=` | 2035-06-04 |
| *.llamenos-hotline.org | ISRG Root X2 (ECDSA P-384) | `diGVwiVYbubAI3RW4hB9xU8e/CH2GGvrTcuvhPy/MzA=` | 2040-09-17 |

These hashes are identical in both enforcement layers:
- `apps/android/app/src/main/java/org/llamenos/hotline/api/ApiService.kt`
  (`ISRG_ROOT_X1_HASH`, `ISRG_ROOT_X2_HASH`)
- `apps/android/app/src/main/res/xml/network_security_config.xml`
  (`<pin-set expiration="2027-01-01">`)

**Self-hosters**: If your hub is not hosted under `llamenos-hotline.org`, you must update the
`<domain>` in `network_security_config.xml` and ensure your TLS chain leads back to these
root CAs (or update the pin hashes accordingly).

## Pin Rotation Procedure

1. Extract new cert hashes (see extraction commands above)
2. Update `apps/android/app/src/main/res/xml/network_security_config.xml` `<pin-set>`
3. Update `apps/android/app/src/main/java/org/llamenos/hotline/api/ApiService.kt`
   `ISRG_ROOT_X1_HASH` / `ISRG_ROOT_X2_HASH` constants
4. Update `apps/ios/Sources/Services/APIService.swift` pin hashes
5. Update `/api/config` endpoint `pinConfig` response (signed by server Ed25519 key)
6. Deploy backend first (with both old + new pins in `pinConfig`)
7. Ship mobile update with new pin hashes (keep old as backup until expiry)
8. After old certs expire: remove old pins from backend `pinConfig`

## Hard-Fail Policy

Pin mismatch → connection refused, no fallback. No soft-fail period.
Pin failures are logged to admin dashboard as `cert_pin_mismatch` events.
