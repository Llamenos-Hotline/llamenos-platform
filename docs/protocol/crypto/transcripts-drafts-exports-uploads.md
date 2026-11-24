# Llamenos Protocol: Cryptographic operations: legacy notes, transcripts, drafts, exports, uploads

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 2.13 Legacy V1 Note Decryption

V1 notes (pre-forward-secrecy) are encrypted with a key derived from the user's secret key via HKDF. No new V1 notes are created; this exists only for backward compatibility.

```
decryptNote(packed_hex, secret_key[32]):

  1. Derive key:
     salt = UTF-8("llamenos:hkdf-salt:v1")
     key = HKDF(SHA-256, secret_key, salt, UTF-8("llamenos:notes"), 32)

  2. Decrypt:
     data = hex_to_bytes(packed_hex)
     nonce = data[0..24]
     ciphertext = data[24..]
     cipher = XChaCha20-Poly1305(key, nonce)
     plaintext = cipher.decrypt(ciphertext)
     return parse_as_NotePayload(UTF-8_decode(plaintext))
```

### 2.14 Transcription Decryption

> **Legacy Model:** This section describes the original ECIES-based transcription encryption (secp256k1 ECDH + XChaCha20-Poly1305). Retained for decrypting existing transcriptions. New implementations should use HPKE (Section 2.2).

Server-encrypted transcriptions use ECIES with a per-transcription ephemeral key. The server wraps the ciphertext for the answering volunteer's pubkey.

```
decryptTranscription(packed_hex, ephemeral_pubkey_hex, secret_key[32]):

  1. ephemeral_pub = hex_to_bytes(ephemeral_pubkey_hex)
     // Already compressed (33 bytes / 66 hex chars)

  2. shared = secp256k1.getSharedSecret(secret_key, ephemeral_pub)
     shared_x = shared[1..33]

  3. label = UTF-8("llamenos:transcription")
     key_input = label || shared_x
     symmetric_key = SHA-256(key_input)

  4. data = hex_to_bytes(packed_hex)
     nonce = data[0..24]
     ciphertext = data[24..]
     cipher = XChaCha20-Poly1305(symmetric_key, nonce)
     plaintext = cipher.decrypt(ciphertext)

  5. Return UTF-8_decode(plaintext)
```

### 2.15 Draft Encryption

Local draft auto-save uses HKDF-derived keys with `HKDF_CONTEXT_DRAFTS` domain separation:

```
encryptDraft(plaintext_string, secret_key[32]):
  salt = UTF-8("llamenos:hkdf-salt:v1")
  key = HKDF(SHA-256, secret_key, salt, UTF-8("llamenos:drafts"), 32)
  nonce = random(12)
  cipher = AES-256-GCM(key, nonce)
  ciphertext = cipher.encrypt(UTF-8(plaintext_string))
  return hex(nonce || ciphertext)
```

### 2.16 Export Encryption

JSON export blobs are encrypted with an HKDF-derived key:

```
encryptExport(json_string, secret_key[32]):
  salt = UTF-8("llamenos:hkdf-salt:v1")
  key = HKDF(SHA-256, secret_key, salt, UTF-8("llamenos:export"), 32)
  nonce = random(12)
  cipher = AES-256-GCM(key, nonce)
  ciphertext = cipher.encrypt(UTF-8(json_string))
  return nonce || ciphertext   // raw bytes, not hex
```

### 2.17 Encrypted File Uploads

Files are encrypted client-side before upload. The encryption follows the envelope pattern:

1. Generate random 32-byte file key.
2. Encrypt file content with AES-256-GCM (chunked).
3. Encrypt file metadata (original name, MIME type, size, dimensions, duration, plaintext SHA-256 checksum) using `LABEL_FILE_METADATA`.
4. Wrap file key for each recipient using `LABEL_FILE_KEY`.
5. Upload encrypted chunks, envelopes, and metadata to server.

```typescript
interface EncryptedFileMetadata {
  originalName: string
  mimeType: string
  size: number
  dimensions?: { width: number; height: number }
  duration?: number
  checksum: string   // SHA-256 of plaintext for integrity verification
}

interface RecipientEnvelope {
  pubkey: string   // recipient X25519 pubkey (hex)
  enc: string      // HPKE encapsulated key (hex, 64 chars)
  ct: string       // HPKE AEAD ciphertext — wraps the file key (LABEL_FILE_KEY)
}
```

