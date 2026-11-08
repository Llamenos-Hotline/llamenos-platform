/**
 * Private key material, recognised by its STRUCTURE — never by a file's name.
 *
 * The write gate's secret class used to be decided by path shape alone
 * (`SECRET_PATH_PATTERNS`, config.ts), which is wrong in both directions at
 * once (#2556): a public certificate chain named `*.pem` was refused, and a
 * private key pasted into `tests/fixtures/key.ts` or saved as
 * `testdata/key.der` was not. This module is the content half: it answers
 * "does this file hold a private key?" for ANY changed file, wherever it sits
 * and whatever it is called.
 *
 * What it recognises, each by an encoding that has no innocent reading:
 *
 * - an RFC 7468 PEM block whose label ends in `PRIVATE KEY` (PKCS#8, PKCS#1
 *   `RSA`, SEC1 `EC`, `DSA`, `ENCRYPTED`, `OPENSSH`) or is a PGP
 *   `PRIVATE KEY BLOCK` — and that actually carries a key-sized body, so a
 *   sentence ABOUT the boundaries (a provider doc telling the reader to paste
 *   everything from the BEGIN line to the END line) or a placeholder fixture
 *   (a body of `fake`) is not mistaken for one;
 * - a whole-file DER private key: PKCS#8 (`OneAsymmetricKey`), encrypted
 *   PKCS#8, SEC1 `ECPrivateKey`, PKCS#1 `RSAPrivateKey` / DSA;
 * - a PuTTY `.ppk` key file and an `age` secret key.
 *
 * What it deliberately does NOT claim to recognise: raw key bytes written as
 * hex, base64 or bech32 with no surrounding structure (`nsec1…`, a JWK `d`,
 * a 64-hex Ed25519 seed). Thirty-two random bytes are indistinguishable from
 * a hash or a nonce, so any rule for them is either noise or fiction. Those
 * are `gitleaks`' job — a required status check on every PR — and this
 * module does not pretend to replace it. It is the floor the write gate
 * enforces itself, not the whole of secret scanning.
 *
 * Pure and dependency-free (no imports from the rest of the orchestrator), so
 * the PEM certificate parser in fragments.ts and the write gate in
 * write-gate.ts can both use it without an import cycle.
 */

/** A recognised piece of private key material, and where it starts. */
export interface KeyMaterialFinding {
  /** Human-readable, e.g. `a PEM "RSA PRIVATE KEY" block`. */
  kind: string
  /** 1-based line of the first byte of the finding. */
  line: number
}

/**
 * The fewest base64 characters a real private key body has. An Ed25519 or
 * X25519 PKCS#8 key — the smallest key this repo uses anywhere — is 48 DER
 * bytes, which is exactly 64 base64 characters. Every placeholder body this
 * repo tracks is far below it (`fake`, `y`, `AAAA`, a 34-character
 * `CHECKREQUIREDENVFIXTUREKEYNOTREAL` fixture, a 32-character truncated
 * header), so the threshold separates them without guessing.
 */
export const MIN_KEY_BODY_CHARS = 64

/** A contiguous base64 run long enough to be encoded data rather than a
 *  word. Prose words are shorter than this; key lines are 64 wide. Counting
 *  only runs this long is what keeps a docs paragraph that happens to follow
 *  a BEGIN boundary from adding up to a "key". */
const BASE64_RUN = /[A-Za-z0-9+/=]{16,}/g

/** How far past a BEGIN boundary a body is looked for when its END is
 *  missing — a truncated paste is still a key. Generous for a 4096-bit RSA
 *  key (~3.2 KiB of base64), bounded so one boundary cannot make the scan
 *  read a whole file as its body. */
const BODY_WINDOW = 16 * 1024

/** Any label ending in `PRIVATE KEY`, plus PGP's `PRIVATE KEY BLOCK`. */
const PEM_PRIVATE_BEGIN = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----/g

const PUTTY_HEADER = /PuTTY-User-Key-File-\d+:/
const PUTTY_PRIVATE_LINES = /^Private-Lines:\s*\d+/m

/** age's bech32 secret key: the HRP, the separator, then 58 data+checksum
 *  characters from the bech32 alphabet (uppercased, as age writes it). */
const AGE_SECRET_KEY = /AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}/

/** Byte-faithful text view: one char per byte, so an ASCII marker inside a
 *  binary file is still found and nothing is lost to UTF-8 replacement. */
export function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1')
}

function lineOf(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 0x0a) line += 1
  return line
}

/** Base64 characters in long runs between `start` and `end`. */
function keyBodyChars(text: string, start: number, end: number): number {
  let chars = 0
  for (const run of text.slice(start, end).matchAll(BASE64_RUN)) chars += run[0].length
  return chars
}

/**
 * The first private key this content holds, or `undefined`.
 *
 * Takes BYTES, not a string: the DER check needs them exactly as stored, and
 * the text checks read a latin1 view of the same bytes so a marker inside a
 * binary file is still seen.
 */
export function findPrivateKeyMaterial(bytes: Uint8Array): KeyMaterialFinding | undefined {
  const der = derPrivateKeyKind(bytes)
  if (der !== undefined) return { kind: `a DER-encoded ${der}`, line: 1 }

  const text = latin1(bytes)
  for (const m of text.matchAll(PEM_PRIVATE_BEGIN)) {
    const label = m[1] ?? 'PRIVATE KEY'
    const start = (m.index ?? 0) + m[0].length
    // The body runs to this block's own END — or, for a truncated paste, to
    // the next boundary of any kind, or the window. Never past another BEGIN:
    // that would credit a neighbouring certificate's body to this "key".
    const endAt = text.indexOf(`-----END ${label}-----`, start)
    const nextBegin = text.indexOf('-----BEGIN ', start)
    let end = Math.min(text.length, start + BODY_WINDOW)
    if (endAt >= 0) end = Math.min(end, endAt)
    if (nextBegin >= 0) end = Math.min(end, nextBegin)
    if (keyBodyChars(text, start, end) >= MIN_KEY_BODY_CHARS) {
      return { kind: `a PEM "${label}" block`, line: lineOf(text, m.index ?? 0) }
    }
  }

  const putty = PUTTY_HEADER.exec(text)
  if (putty !== null && PUTTY_PRIVATE_LINES.test(text)) {
    return { kind: 'a PuTTY private key file', line: lineOf(text, putty.index) }
  }

  const age = AGE_SECRET_KEY.exec(text)
  if (age !== null) return { kind: 'an age secret key', line: lineOf(text, age.index) }

  return undefined
}

// ---------------------------------------------------------------------------
// DER — just enough ASN.1 to tell a private key from a certificate.
// ---------------------------------------------------------------------------

interface Tlv {
  tag: number
  /** First byte of the value. */
  start: number
  /** One past the value's last byte. */
  end: number
}

const TAG_INTEGER = 0x02
const TAG_OCTET_STRING = 0x04
const TAG_OID = 0x06
const TAG_SEQUENCE = 0x30

/** One definite-length TLV at `offset`, or `undefined` if what is there is
 *  not one. High-tag-number and indefinite-length forms are refused: DER
 *  forbids the second, and no key structure needs the first. */
function readTlv(b: Uint8Array, offset: number, limit: number): Tlv | undefined {
  if (offset + 2 > limit) return undefined
  const tag = b[offset] as number
  if ((tag & 0x1f) === 0x1f) return undefined
  const first = b[offset + 1] as number
  let p = offset + 2
  let len: number
  if (first < 0x80) {
    len = first
  } else {
    const n = first & 0x7f
    if (n === 0 || n > 4 || p + n > limit) return undefined
    len = 0
    for (let i = 0; i < n; i += 1) len = len * 256 + (b[p + i] as number)
    p += n
  }
  if (p + len > limit) return undefined
  return { tag, start: p, end: p + len }
}

/** The TLVs directly inside a constructed value — `undefined` unless they
 *  tile it exactly, which is what makes this a parse and not a guess. */
function childrenOf(b: Uint8Array, parent: Tlv, max = 16): Tlv[] | undefined {
  const out: Tlv[] = []
  let p = parent.start
  while (p < parent.end) {
    if (out.length === max) return undefined
    const t = readTlv(b, p, parent.end)
    if (t === undefined) return undefined
    out.push(t)
    p = t.end
  }
  return out
}

function isSmallInteger(b: Uint8Array, t: Tlv | undefined, values: readonly number[]): boolean {
  return t !== undefined && t.tag === TAG_INTEGER && t.end - t.start === 1 && values.includes(b[t.start] as number)
}

/** True when `t` is a SEQUENCE whose first element is an OID — the shape of
 *  an `AlgorithmIdentifier`. */
function isAlgorithmIdentifier(b: Uint8Array, t: Tlv | undefined): boolean {
  if (t === undefined || t.tag !== TAG_SEQUENCE) return false
  const first = readTlv(b, t.start, t.end)
  return first !== undefined && first.tag === TAG_OID
}

/**
 * Which private key structure `bytes` is, in its entirety, or `undefined`.
 *
 * The outer SEQUENCE must span the whole input exactly, so a file that merely
 * starts with `0` (0x30) is not mistaken for DER. Each rule is the defining
 * field order of its structure, and none of them is the shape of a
 * certificate (`SEQUENCE { SEQUENCE tbs, AlgorithmIdentifier, BIT STRING }`)
 * or a SubjectPublicKeyInfo (`SEQUENCE { AlgorithmIdentifier, BIT STRING }`):
 *
 * - PKCS#8 `PrivateKeyInfo`/`OneAsymmetricKey` (RFC 5958): INTEGER 0|1,
 *   AlgorithmIdentifier, OCTET STRING.
 * - PKCS#8 `EncryptedPrivateKeyInfo`: exactly AlgorithmIdentifier, OCTET
 *   STRING. (A DER `DigestInfo` has the same two-field shape and is refused
 *   with it — failing closed on a file nobody commits on its own.)
 * - SEC1 `ECPrivateKey` (RFC 5915): INTEGER 1, OCTET STRING.
 * - PKCS#1 `RSAPrivateKey` / OpenSSL DSA: six or more INTEGERs, the first a
 *   version of 0 or 1.
 */
export function derPrivateKeyKind(bytes: Uint8Array): string | undefined {
  const top = readTlv(bytes, 0, bytes.length)
  if (top === undefined || top.tag !== TAG_SEQUENCE || top.end !== bytes.length) return undefined
  const kids = childrenOf(bytes, top)
  if (kids === undefined || kids.length < 2) return undefined
  const [k0, k1, k2] = kids
  if (isSmallInteger(bytes, k0, [0, 1]) && isAlgorithmIdentifier(bytes, k1) && k2?.tag === TAG_OCTET_STRING) {
    return 'PKCS#8 private key'
  }
  if (kids.length === 2 && isAlgorithmIdentifier(bytes, k0) && k1?.tag === TAG_OCTET_STRING) {
    return 'encrypted PKCS#8 private key'
  }
  if (isSmallInteger(bytes, k0, [1]) && k1?.tag === TAG_OCTET_STRING) {
    return 'SEC1 EC private key'
  }
  if (kids.length >= 6 && kids.every((k) => k.tag === TAG_INTEGER) && isSmallInteger(bytes, k0, [0, 1])) {
    return 'PKCS#1 RSA / DSA private key'
  }
  // An allowlist of key shapes: anything else — a certificate, or a
  // SubjectPublicKeyInfo, whose second field is a BIT STRING — is not a key.
  return undefined
}
