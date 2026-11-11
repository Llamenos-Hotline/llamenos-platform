# ISRG root certificates (public certificate material)

Let's Encrypt's four published roots, fetched verbatim from letsencrypt.org:

| File | Source | SHA-256 fingerprint |
|------|--------|---------------------|
| `isrg-root-x1.crt` | https://letsencrypt.org/certs/isrgrootx1.pem | `96:BC:EC:06:26:49:76:F3:74:60:77:9A:CF:28:C5:A7:CF:E8:A3:C0:AA:E1:1A:8F:FC:EE:05:C0:BD:DF:08:C6` |
| `isrg-root-x2.crt` | https://letsencrypt.org/certs/isrg-root-x2.pem | `69:72:9B:8E:15:A8:6E:FC:17:7A:57:AF:B7:17:1D:FC:64:AD:D2:8C:2F:CA:8C:F1:50:7E:34:45:3C:CB:14:70` |
| `isrg-root-yr.crt` | https://letsencrypt.org/certs/gen-y/root-yr.pem | `E5:7B:7E:6F:15:0C:41:91:02:E8:D5:C0:55:72:9F:F9:67:B9:D1:A8:29:BF:00:CE:C8:9C:A6:04:EB:F4:A8:6F` |
| `isrg-root-ye.crt` | https://letsencrypt.org/certs/gen-y/root-ye.pem | `E1:4F:FC:AD:5B:00:25:73:10:06:CA:A4:3A:12:1A:22:D8:E9:70:0F:4F:B9:CF:85:2F:02:A7:08:AA:5D:56:66` |

They are public trust anchors, not secret material. `tests/steps/backend/certificate-pins.steps.ts`
derives each root's SPKI SHA-256 pin from them at test time, **independently** of
the constants in `apps/worker/routes/config.ts`: comparing the served
`/api/config/pins` list against hashes derived from these certificates catches a
wrong pin, whereas comparing it against a constant added by the same commit would
be circular and pass on a wrong pin. The step file also pins each certificate's own
SHA-256 fingerprint (the values above), so a corrupted or swapped fixture fails
loudly instead of silently redefining "correct".

The extension is `.crt` on purpose. A `*.pem` rule in a contributor's local
`.git/info/exclude` hides `.pem` fixtures from `git add` without any warning.

These are byte-identical to `apps/android/app/src/test/resources/certs/isrg-root-*.pem`.

Verify after any refresh:

```bash
for r in x1 x2 yr ye; do
  openssl x509 -in isrg-root-$r.crt -noout -fingerprint -sha256
  openssl x509 -in isrg-root-$r.crt -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64
done
```
