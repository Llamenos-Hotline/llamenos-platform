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
| *.llamenos-hotline.org | ISRG Root X2 (ECDSA P-384) | `diGVwiVYbubAI3RW4hB9xU8e/CH2GnkuvVFZE8zmgzI=` | 2040-09-17 |

These hashes are identical in every enforcement layer:
- `apps/android/app/src/main/java/org/llamenos/hotline/api/ApiService.kt`
  (`ISRG_ROOT_X1_HASH`, `ISRG_ROOT_X2_HASH`)
- `apps/android/app/src/main/res/xml/network_security_config.xml`
  (`<pin-set expiration="2027-01-01">`)
- `apps/ios/Sources/Services/CertificatePinning.swift`
  (`CertificatePins.isrgRootX1Hash`, `isrgRootX2Hash`)

## How a pin is matched

A pin is `base64(SHA-256(DER SubjectPublicKeyInfo))` (RFC 7469) — what the `openssl pkey -pubin
-outform der` recipe hashes. Every platform must hash exactly those bytes:

- **Android** — OkHttp's `CertificatePinner` and the `<pin-set>` hash the SPKI natively.
- **iOS** — there is no Security-framework API that returns a certificate's SPKI.
  `SecKeyCopyExternalRepresentation` returns PKCS#1 `RSAPublicKey` (RSA) or the X9.63 point (EC),
  whose hashes can never equal an SPKI pin; hashing it made iOS refuse every real deployment
  (#2159). `SubjectPublicKeyInfo` reads the SPKI element verbatim out of the certificate DER instead.

Order matters: the chain is **evaluated first** — system trust store, SSL policy bound to the host
being connected to — and pins are checked only against the chain that evaluation built. A pinned
key merely *appearing* in what the server sent proves nothing: anyone can append the public ISRG
root certificate to a self-signed leaf (#2160). `CertificatePinValidator.evaluate` refuses an
invalid chain before it looks at a pin, and an empty pin set refuses everything.

Loopback hosts (`localhost`, `127.0.0.1`, `::1`) are exempt from pinning on iOS and get the system's
default TLS handling — local dev backends do not hold a Let's Encrypt certificate.

### Let's Encrypt's "Generation Y" roots

As of 2026-11 Let's Encrypt issues from `YR1`/`YE1`/`YE2` under **ISRG Root YR / Root YE**, which
the server sends cross-signed by ISRG Root X1 / X2. Apple's trust store does not yet hold Root YR/YE
as anchors, so the evaluated chain ends at X1/X2 and the pins match (verified on macOS 26.6 against
`valid-isrgrootx1.letsencrypt.org` and `valid-isrgrootx2.letsencrypt.org`; Android's store was not
checked here). Once a
platform trust store adds Root YR/YE as anchors, path building may stop at them and X1/X2 would no
longer be on the evaluated chain. Before that happens, add the Root YR/YE SPKI pins on every
platform together. The iOS test `CertificatePinningTests.testRealLetsEncryptChainIsAccepted`
evaluates a captured Gen-Y chain against the simulator's real trust store, so it fails on the first
iOS release whose store changes path building.

**Self-hosters**: If your hub is not hosted under `llamenos-hotline.org`, you must update the
`<domain>` in `network_security_config.xml` and ensure your TLS chain leads back to these
root CAs (or update the pin hashes accordingly).

## Pin Rotation Procedure

1. Extract new cert hashes (see extraction commands above)
2. Update `apps/android/app/src/main/res/xml/network_security_config.xml` `<pin-set>`
3. Update `apps/android/app/src/main/java/org/llamenos/hotline/api/ApiService.kt`
   `ISRG_ROOT_X1_HASH` / `ISRG_ROOT_X2_HASH` constants
4. Update `apps/ios/Sources/Services/CertificatePinning.swift` pin hashes
5. Update `/api/config` endpoint `pinConfig` response (signed by server Ed25519 key)
6. Deploy backend first (with both old + new pins in `pinConfig`)
7. Ship mobile update with new pin hashes (keep old as backup until expiry)
8. After old certs expire: remove old pins from backend `pinConfig`

## Hard-Fail Policy

Pin mismatch → connection refused, no fallback. No soft-fail period.
Pin failures are logged to admin dashboard as `cert_pin_mismatch` events.
