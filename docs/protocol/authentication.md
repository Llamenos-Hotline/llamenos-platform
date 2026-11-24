# Llamenos Protocol: Authentication

> Part of the [Llamenos Interoperability Protocol](PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

## 1. Authentication Protocol

Llamenos supports two authentication mechanisms. Clients MUST implement signature auth (Schnorr or Ed25519). Session token auth is optional and requires WebAuthn support.

### 1.1 Schnorr Signature Authentication (Legacy)

Every authenticated API request carries a self-signed token proving possession of a private key. The token is bound to the specific HTTP method and path to prevent cross-endpoint replay attacks.

> **Phase 6 Note:** Clients with per-device Ed25519 keys (Section 2.11) use Ed25519 signatures instead of Schnorr. The token construction is identical (same message format and binding), but the signature algorithm differs. The server tries Schnorr verification first, then falls back to Ed25519. New client implementations SHOULD use Ed25519 with the `LABEL_DEVICE_AUTH` prefix (see Section 1.1.1).

#### Token Construction

```
Step 1: Build the message string
  message = "llamenos:auth:" + pubkey_hex + ":" + timestamp_ms + ":" + HTTP_METHOD + ":" + path

  Where:
    pubkey_hex  = 64 hex chars (x-only secp256k1 public key)
    timestamp_ms = Unix epoch in milliseconds (integer)
    HTTP_METHOD  = uppercase string ("GET", "POST", "PATCH", "PUT", "DELETE")
    path         = URL pathname starting with "/" (e.g., "/api/auth/me")

Step 2: Hash the message
  message_hash = SHA-256(UTF-8(message))
  // Result: 32 bytes

Step 3: Sign with BIP-340 Schnorr
  signature = schnorr.sign(message_hash, secret_key)
  // Result: 64 bytes

Step 4: Encode as JSON
  token_json = JSON.stringify({
    "pubkey": pubkey_hex,        // 64-char hex string
    "timestamp": timestamp_ms,   // integer (milliseconds)
    "token": hex(signature)      // 128-char hex string
  })
```

#### HTTP Header Format

```
Authorization: Bearer {"pubkey":"<64_hex>","timestamp":<ms>,"token":"<128_hex>"}
```

The JSON is inlined directly after `Bearer ` (single space). No base64 encoding.

#### Example

```
Authorization: Bearer {"pubkey":"a1b2c3d4e5f6...","timestamp":1709318400000,"token":"deadbeef..."}
```

#### Validation Rules (Server-Side)

1. Parse `Authorization` header, strip `Bearer ` prefix, `JSON.parse()` the remainder.
2. Verify `pubkey`, `timestamp`, and `token` fields are all present and non-empty.
3. Check token freshness: `|now() - timestamp| <= 300,000 ms` (5-minute window, both directions).
4. Reconstruct the message: `"llamenos:auth:" + pubkey + ":" + timestamp + ":" + method + ":" + path`.
5. Compute `SHA-256(UTF-8(message))`.
6. Verify the Schnorr signature: `schnorr.verify(hex_to_bytes(token), message_hash, hex_to_bytes(pubkey))`.
7. Look up the pubkey in the identity store to resolve the user record.

#### 1.1.1 Ed25519 Device Authentication (Phase 6)

For clients using per-device Ed25519 keys (Section 2.11), the auth token uses a different message prefix and Ed25519 signatures:

```
Step 1: Build the message string
  message = "llamenos:device-auth:v1:" + timestamp_ms + ":" + HTTP_METHOD + ":" + path

  Where:
    timestamp_ms = Unix epoch in milliseconds (integer)
    HTTP_METHOD  = uppercase string ("GET", "POST", "PATCH", "PUT", "DELETE")
    path         = URL pathname starting with "/" (e.g., "/api/auth/me")

Step 2: Hash the message
  message_hash = SHA-256(UTF-8(message))

Step 3: Sign with Ed25519
  signature = ed25519.sign(message_hash, device_signing_key)
  // Result: 64 bytes

Step 4: Encode as JSON (same format as Schnorr)
  token_json = JSON.stringify({
    "pubkey": ed25519_pubkey_hex,   // 64-char hex string (32-byte Ed25519 public key)
    "timestamp": timestamp_ms,
    "token": hex(signature)         // 128-char hex string
  })
```

The server validates Ed25519 tokens the same way as Schnorr tokens, resolving the Ed25519 pubkey to a user via the device registry or sigchain.

### 1.2 Session Token Authentication (WebAuthn)

After a successful WebAuthn authentication ceremony, the server issues a random 256-bit session token with an 8-hour expiry. Clients send it on subsequent requests:

```
Authorization: Session <token_hex>
```

Where `token_hex` is a 64-character hex string (32 random bytes).

#### Validation Rules

1. Parse `Authorization` header, strip `Session ` prefix, trim whitespace.
2. Look up the token in the sessions store.
3. Verify the session has not expired (`expiresAt > now()`).
4. Resolve the associated pubkey to the user record.

### 1.3 Authentication Priority

The server checks Session auth first. If the `Authorization` header starts with `Session `, Schnorr auth is not attempted. If the header starts with `Bearer `, Session auth is not attempted.

---

