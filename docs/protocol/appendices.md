# Llamenos Protocol: Appendices

> Part of the [Llamenos Interoperability Protocol](PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

## Appendix A: Library Dependencies for Implementors

Clients implementing this protocol need the following cryptographic capabilities:

| Operation | Library (JS reference) | Algorithm |
|-----------|----------------------|-----------|
| Key generation | `@noble/curves` | secp256k1, Ed25519, X25519 |
| Schnorr signatures | `@noble/curves/secp256k1` | BIP-340 |
| ECDH | `@noble/curves/secp256k1` | secp256k1 |
| SHA-256 | `@noble/hashes/sha2` | SHA-256 |
| HMAC | `@noble/hashes/hmac` | HMAC-SHA256 |
| HKDF | `@noble/hashes/hkdf` | HKDF-SHA256 |
| AEAD | `@noble/ciphers/aes` | AES-256-GCM |
| Argon2id | `argon2` (Rust) / `@noble/hashes/argon2` (JS) | Argon2id (64 MB, 3 iter, 4 lanes) |
| PBKDF2 | Web Crypto API | PBKDF2-SHA256 (legacy backup/Stronghold only) |
| Encoding | `@noble/hashes` | hex, utf8 |

**Gotchas for non-JS implementations:**
- `@noble/ciphers` and `@noble/hashes` require `.js` extension in import paths (JS-specific).
- `schnorr` is a separate named export from secp256k1 (not the default).
- WebSocket pubkeys are x-only (32 bytes) -- prepend `0x02` for ECDH compressed format.
- `secp256k1.getSharedSecret()` returns 33 bytes; extract x-coordinate with `[1..33]`.
- AES-256-GCM uses a 12-byte IV (nonce), not 24-byte.
- The GCM authentication tag is 16 bytes, appended to the ciphertext by the AEAD implementation.

## Appendix B: Type Definitions Reference

### NotePayload

```typescript
interface NotePayload {
  text: string
  fields?: Record<string, string | number | boolean>
}
```

### CustomFieldDefinition

```typescript
interface CustomFieldDefinition {
  id: string                // UUID
  name: string              // machine-readable key (e.g., "severity")
  label: string             // display label (e.g., "Severity Rating")
  type: 'text' | 'number' | 'select' | 'checkbox' | 'textarea'
  required: boolean
  options?: string[]         // for 'select' type
  validation?: {
    minLength?: number       // text/textarea
    maxLength?: number       // text/textarea
    min?: number             // number
    max?: number             // number
  }
  visibleToVolunteers: boolean
  editableByVolunteers: boolean
  context: 'call-notes' | 'reports' | 'both'
  allowFileUpload?: boolean
  acceptedFileTypes?: string[]
  order: number
  createdAt: string
}
```

### TelephonyProviderConfig

```typescript
interface TelephonyProviderConfig {
  type: 'twilio' | 'signalwire' | 'vonage' | 'plivo' | 'asterisk' | 'telnyx' | 'bandwidth' | 'freeswitch'
  phoneNumber: string        // E.164
  accountSid?: string
  authToken?: string
  signalwireSpace?: string
  apiKey?: string
  apiSecret?: string
  applicationId?: string
  privateKey?: string        // Vonage PEM
  authId?: string
  ariUrl?: string
  ariUsername?: string
  ariPassword?: string
  bridgeCallbackUrl?: string
  webrtcEnabled?: boolean
  apiKeySid?: string
  apiKeySecret?: string
  twimlAppSid?: string
}
```

### Hub

```typescript
interface Hub {
  id: string
  name: string
  slug: string
  description?: string
  status: 'active' | 'suspended' | 'archived'
  phoneNumber?: string
  createdBy: string
  createdAt: string
  updatedAt: string
}
```

### AuditLogEntry

```typescript
interface AuditLogEntry {
  id: string
  event: string
  actorPubkey: string
  details: Record<string, unknown>
  createdAt: string
  previousEntryHash?: string   // SHA-256 chain link
  entryHash?: string           // SHA-256 of this entry
}
```

---

## Appendix C: Legacy Encryption (pre-v2 ECIES)

> **Historical Reference Only.** This appendix documents the encryption primitives used before v2.0 (2026-Q1). They are retained so implementors can read data encrypted with the old scheme during migration. **DO NOT implement new encryption using these algorithms.**

### C.1 ECIES Key Wrapping (Replaced by Section 2.2 HPKE)

ECIES was the key-wrapping primitive in v1. It used secp256k1 ECDH + XChaCha20-Poly1305 instead of X25519 HPKE + AES-256-GCM.

See Section 2.2.1 for the full ECIES algorithm specification (retained in the main body for backward-compat read path).

### C.2 nsec-per-User Key Storage (Replaced by Section 2.11)

v1 stored a single secp256k1 secret key (nsec, bech32-encoded) per user, PIN-encrypted with PBKDF2-SHA256 + XChaCha20-Poly1305. See Section 2.6 (marked Legacy) for the full algorithm.

### C.3 Provisioning (secp256k1 ECDH + nsec Transfer)

v1 provisioning used secp256k1 ECDH for the ephemeral key exchange and transferred the nsec directly (XChaCha20-Poly1305 encrypted). The SAS derivation used the compressed X coordinate (`sharedX = shared[1..33]`) instead of the raw 32-byte X25519 output. See the migration note in Section 6 for context.

### C.4 XChaCha20-Poly1305 Wire Format (v1 encryptedContent)

v1 content was encrypted with XChaCha20-Poly1305:

```
Offset  Length    Content
------  ------    -------
0       24        XChaCha20-Poly1305 nonce (random, 24 bytes)
24      variable  Ciphertext + 16-byte Poly1305 authentication tag
```

The entire byte sequence was hex-encoded. v2 uses AES-256-GCM with a 12-byte IV (Section 2.3).
