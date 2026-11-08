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

Pinning strategy: root CA pins (ISRG Root X1, X2, YR, YE) so that routine leaf and intermediate
renewal never breaks the app. Four independent roots for backup (RFC 7469 §2.5): a chain
containing **any** pinned key is accepted, one containing none is refused.

| Domain | Type | Hash (base64 SHA-256 SPKI) | Root expires |
|--------|------|---------------------------|---------|
| *.llamenos-hotline.org | ISRG Root X1 (RSA 4096) | `C5+lpZ7tcVwmwQIMcRtPbsQtWLABXhQzejna0wHFr8M=` | 2035-06-04 |
| *.llamenos-hotline.org | ISRG Root X2 (ECDSA P-384) | `diGVwiVYbubAI3RW4hB9xU8e/CH2GnkuvVFZE8zmgzI=` | 2040-09-17 |
| *.llamenos-hotline.org | ISRG Root YR (RSA 4096, Gen-Y) | `fk6IOKit1ild5647BH06ujSIq5XbCgqlbYl6ANhhi88=` | 2045-09-02 |
| *.llamenos-hotline.org | ISRG Root YE (ECDSA P-384, Gen-Y) | `sCkq5UWXjg+7mKu9lMhhYF5bGLsy7VI/UNW3tccdR7w=` | 2045-09-02 |

Each was derived from the certificate Let's Encrypt publishes, never copied from a page:

```bash
curl -s https://letsencrypt.org/certs/gen-y/root-yr.pem \
  | openssl x509 -pubkey -noout | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -binary | base64      # -> fk6IOKit1ild5647BH06ujSIq5XbCgqlbYl6ANhhi88=
```

(`isrgrootx1.pem`, `isrg-root-x2.pem` and `gen-y/root-ye.pem` for the others.) The cross-signed
copies (`gen-y/root-yr-by-x1.pem`, `gen-y/root-ye-by-x2.pem`) carry the same keys as the
self-signed ones, so one pin matches a root in either form, and each cross-signature verifies
against the already-pinned X1 / X2 (`openssl verify -CAfile isrgrootx1.pem root-yr-by-x1.pem`).
Every platform's tests re-derive all four hashes from the real certificates.

These hashes are identical in every enforcement layer:
- `apps/android/app/src/main/java/org/llamenos/hotline/api/ApiService.kt`
  (`ISRG_ROOT_{X1,X2,YR,YE}_HASH`, `DEFAULT_PIN_HASHES`)
- `apps/android/app/src/main/res/xml/network_security_config.xml`
  (`<pin-set expiration="2028-01-01">` — after the expiration Android stops enforcing the
  `<pin-set>`; the OkHttp pinner above still does. Extend it with every release.)
- `apps/ios/Sources/Services/CertificatePinning.swift`
  (`CertificatePins.isrgRootX1Hash`, `isrgRootX2Hash`, `isrgRootYRHash`, `isrgRootYEHash`)
- `apps/desktop/src/cert_pin.rs` (`ISRG_ROOT_PINS`). The desktop enforces the compiled-in set at
  startup, not the copy persisted when the backend was configured, so an updated install picks up
  new roots without the user re-entering the server address.

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

### Let's Encrypt's "Generation Y" roots (#2505)

Let's Encrypt has issued from `YR1`/`YR2`/`YE1`/`YE2` under **ISRG Root YR / Root YE** by default
since 2026-05-13 (the date on the cross-signed Root YR / YE certificates it published, and the
switch date its announcements gave). Its published
default chains (https://letsencrypt.org/certificates/, "Chains of Trust") are:

- RSA: `leaf ← YR1/YR2 ← Root YR ← ISRG Root X1`
- ECDSA: `leaf ← YE1/YE2 ← Root YE ← ISRG Root X2 ← ISRG Root X1`

Root YR and Root YE are served **cross-signed** by X1 / X2. The page lists them as "not yet
included in Root Program Trust Stores, but will be submitted for inclusion soon". No root program
has published an inclusion date that we could find, so there is **no date to plan against**: the
client pin set is immutable once released and the outage has no in-app remedy, so the pins ship
before the trust stores change, not after.

Today the evaluated chain ends at X1 / X2 (via the cross-sign), so the X1 / X2 pins match. Checked:
Apple's store (macOS 26.6, iOS 26.5 simulator, #2501) and the Mozilla bundle desktop validates
against (`webpki-root-certs` 1.0.10) hold X1 / X2 and not YR / YE; Android's system store was not
inspected, which is one more reason not to wait for it. The day a platform trust store adds Root YR / YE as an anchor, path building stops
there, X1 / X2 are no longer on the chain, and a client pinning only X1 / X2 would refuse every
connection while the web stayed healthy. That is why all four roots are pinned.

Verified 2026-11-06 against `valid-isrgrootx1.letsencrypt.org` / `valid-isrgrootx2.letsencrypt.org`
(both served `leaf ← YR1|YE1 ← Root YR|YE cross-signed`) and by the tests on each platform, which
evaluate real chains anchored at each of the four roots (accepted) and at an unpinned root
(refused), and show that a Y-anchored chain is refused under the old X1 / X2-only set.

**Caddy**: `acme_ca` is pinned to Let's Encrypt with no fallback issuer and does not choose a root.
Nothing in `deploy/` constrains which root a renewal ends at, and nothing needs to; do not add
`preferred_chains` or an ACME `profile` to steer it, because a chain ending at an unpinned root is
the outage.

**Not covered here**: the SIP/TLS leg of in-app calling (liblinphone) validates against the SDK's
own bundled roots, not these pins; whether that bundle holds Root YR / YE is separate.

**Self-hosters**: If your hub is not hosted under `llamenos-hotline.org`, you must update the
`<domain>` in `network_security_config.xml` and ensure your TLS chain leads back to these
root CAs (or update the pin hashes accordingly).

## Pin Rotation Procedure

1. Derive the new hashes from the published certificate (recipe above), and add the certificate
   to each platform's test fixtures — the tests re-derive every pin from them
2. Update `apps/android/app/src/main/res/xml/network_security_config.xml` `<pin-set>`
3. Update `apps/android/app/src/main/java/org/llamenos/hotline/api/ApiService.kt`
   `ISRG_ROOT_*_HASH` constants and `DEFAULT_PIN_HASHES`
4. Update `apps/ios/Sources/Services/CertificatePinning.swift` pin hashes
4a. Update `apps/desktop/src/cert_pin.rs` `ISRG_ROOT_PINS`
5. Update `/api/config` endpoint `pinConfig` response (signed by server Ed25519 key)
6. Deploy backend first (with both old + new pins in `pinConfig`)
7. Ship mobile update with new pin hashes (keep old as backup until expiry)
8. After old certs expire: remove old pins from backend `pinConfig`

## Hard-Fail Policy

Pin mismatch → connection refused, no fallback. No soft-fail period.
Pin failures are logged to admin dashboard as `cert_pin_mismatch` events.
