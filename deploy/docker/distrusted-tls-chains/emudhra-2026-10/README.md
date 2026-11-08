# eMudhra intermediate CA compromise — distrusted chains (#2582)

On 2026-10-20 the private keys of eight eMudhra intermediate CAs were shown to be
recoverable from the certificates themselves (CVE-2026-113470; Mozilla bug 2083449):

| Intermediate | Use |
|---|---|
| EM DV TLS CA - G3B, EM OV TLS CA - G3B, EM EV TLS CA - G3B | TLS |
| EM DV TLS CA - G3C, EM OV TLS CA - G3C, EM EV TLS CA - G3C | TLS |
| EM OV CS CA - G3B, EM OV CS CA - G3C | code signing |

Each exists twice: issued by `emSign Root TLS CA - G3` / `emSign Root CS CA - G3`
(themselves cross-signed by **emSign ECC Root CA - G3**), and cross-signed by Sectigo's
**AAA Certificate Services**. A trust store is exposed if it can build a path from a
leaf under one of them to either root.

These files are **test fixtures for a negative check, never trust material**.
`scripts/check-image-trust-store.sh` asserts that every trust store in a built image
REJECTS every chain here.

## Contents

- `chains/` — the chains served by the public test hosts at
  <https://emudhra.we-have-a-problem.com/> (`chains.zip`, sha256
  `afb9d69e8e5fc9eb0c08d5fe4baafc67edbcced2d63af2f9deb62edb6431d4a9`, fetched
  2026-11-08), leaf first. `*-aaa-*` chains run through the Sectigo cross-sign. The
  others run through `emSign Root TLS CA - G3`. `*-noct-*` leaves were never logged to
  CT. `*-rollover-*` chains reach the leaf through a self-issued key-rollover
  certificate, to catch blocks that only match the leaf's AKI.
- `control-roots/` — the two roots the chains lead to (SHA-256
  `86A1ECBA…7A36BBE6B` emSign ECC Root CA - G3, `D7A7A0FB…EA699EF4` AAA Certificate
  Services). They are used ONLY for the check's positive control: with the matching
  root added, each chain must verify. That proves a rejection comes from the store under
  test, not from a fixture that has expired or broken.

The check verifies at a fixed time (`2026-11-01T00:00:00Z`), inside every leaf's
validity window. Without that, the fixtures would expire in 2027 and every chain would
be "rejected" for the wrong reason.
