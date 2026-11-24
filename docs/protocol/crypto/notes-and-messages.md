# Llamenos Protocol: Cryptographic operations: notes and messages

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 2.3 Per-Note Encryption (V2 Forward Secrecy)

Every note is encrypted with a unique random key, providing forward secrecy. Compromising an identity key does not reveal past notes.

#### Encryption

```
encryptNoteV2(payload: NotePayload, author_x25519_pubkey_hex, admin_x25519_pubkey_hexes[]):

  1. Serialize payload:
     json_string = JSON.stringify(payload)
     // NotePayload = { text: string, fields?: Record<string, string|number|boolean> }

  2. Generate per-note symmetric key:
     note_key = random(32)

  3. Encrypt content with AES-256-GCM:
     iv = random(12)
     ciphertext_with_tag = AES-256-GCM.encrypt(note_key, iv, UTF-8(json_string), aad = UTF-8("llamenos:note-key"))
     // ciphertext_with_tag: variable length + 16-byte GCM tag appended
     encrypted_content = hex(iv || ciphertext_with_tag)

  4. Wrap note_key for the author via HPKE:
     author_sealed = HPKE.Seal(
       recipientPk = hex_to_bytes(author_x25519_pubkey_hex),
       plaintext   = note_key,
       info        = UTF-8("llamenos:note-key"),
       aad         = UTF-8("llamenos:note-key:key-wrap")
     )
     author_envelope = {
       enc: hex(author_sealed[0..32]),   // 32-byte HPKE encapsulated key → 64 hex chars
       ct:  hex(author_sealed[32..])     // AEAD ciphertext
     }

  5. Wrap note_key for each admin via HPKE:
     admin_envelopes = []
     for each admin_x25519_pubkey_hex in admin_x25519_pubkey_hexes:
       sealed = HPKE.Seal(
         recipientPk = hex_to_bytes(admin_x25519_pubkey_hex),
         plaintext   = note_key,
         info        = UTF-8("llamenos:note-key"),
         aad         = UTF-8("llamenos:note-key:key-wrap")
       )
       admin_envelopes.push({
         pubkey: admin_x25519_pubkey_hex,   // 64 hex chars
         enc:    hex(sealed[0..32]),
         ct:     hex(sealed[32..])
       })

  6. Return:
     EncryptedNoteV2 {
       encryptedContent: encrypted_content,   // hex string
       authorEnvelope:   author_envelope,      // KeyEnvelope { enc, ct }
       adminEnvelopes:   admin_envelopes        // RecipientEnvelope[] { pubkey, enc, ct }
     }
```

#### Decryption

```
decryptNoteV2(encrypted_content_hex, envelope: KeyEnvelope, device_x25519_secret_key[32]):

  1. Unwrap the note key via HPKE:
     enc_bytes = hex_to_bytes(envelope.enc)   // 32 bytes
     ct_bytes  = hex_to_bytes(envelope.ct)
     note_key = HPKE.Open(
       recipientSk = device_x25519_secret_key,
       enc         = enc_bytes,
       ciphertext  = ct_bytes,
       info        = UTF-8("llamenos:note-key"),
       aad         = UTF-8("llamenos:note-key:key-wrap")
     )
     // note_key: 32 bytes

  2. Decrypt content with AES-256-GCM:
     data = hex_to_bytes(encrypted_content_hex)
     iv   = data[0..12]
     ciphertext_with_tag = data[12..]
     plaintext = AES-256-GCM.decrypt(note_key, iv, ciphertext_with_tag, aad = UTF-8("llamenos:note-key"))

  3. Parse JSON:
     json_string = UTF-8_decode(plaintext)
     payload = JSON.parse(json_string) as NotePayload
     // If JSON parse fails or doesn't have .text field:
     // Return { text: json_string }
```

#### Wire Format: `encryptedContent`

```
Offset  Length    Content
------  ------    -------
0       12        AES-256-GCM IV (random, 12 bytes)
12      variable  Ciphertext + GCM tag (UTF-8 JSON payload + 16-byte GCM authentication tag)
```

The entire byte sequence is hex-encoded for transport.

#### Wire Format: Key Envelopes

Author envelope (`authorEnvelope`):
```json
{ "enc": "<hex64 — 32-byte HPKE encapsulated key>", "ct": "<hex — AEAD ciphertext>" }
```

Admin envelope (`adminEnvelopes[i]`):
```json
{ "pubkey": "<hex64>", "enc": "<hex64>", "ct": "<hex>" }
```

### 2.4 Per-Message Encryption

Messages (SMS, WhatsApp, Signal, web reports) use the same envelope pattern as notes but with `LABEL_MESSAGE` for domain separation. A random per-message symmetric key is generated and wrapped for each authorized reader.

#### Encryption

```
encryptMessage(plaintext_string, reader_x25519_pubkey_hexes[]):

  1. Generate per-message symmetric key:
     message_key = random(32)

  2. Encrypt content with AES-256-GCM (NO AAD — stored-record format, #1393):
     iv = random(12)
     ciphertext_with_tag = AES-256-GCM.encrypt(
       key     = message_key,
       iv      = iv,
       aad     = empty,
       message = UTF-8(plaintext_string)
     )
     encrypted_content = hex(iv || ciphertext_with_tag)

  3. Wrap message_key for each reader via HPKE:
     reader_envelopes = []
     for each reader_x25519_pubkey_hex in reader_x25519_pubkey_hexes:
       sealed = HPKE.Seal(
         recipientPk = hex_to_bytes(reader_x25519_pubkey_hex),
         plaintext   = message_key,
         info        = UTF-8("llamenos:message"),
         aad         = empty
       )
       reader_envelopes.push({
         pubkey: reader_x25519_pubkey_hex,   // 64 hex chars
         enc:    hex(sealed[0..32]),
         ct:     hex(sealed[32..])
       })

  4. Return:
     EncryptedMessagePayload {
       encryptedContent: encrypted_content,
       readerEnvelopes:  reader_envelopes     // RecipientEnvelope[] { pubkey, enc, ct }
     }
```

> **Stored records carry no AAD (#1393).** Messages are sealed by two different
> writers — the server (inbound webhooks) and clients (outbound replies) — and
> the two share a conversation with no format marker, so a reader cannot tell
> which AAD to supply. The only AAD a reader can supply is therefore empty, and
> the label is bound as the HPKE `info` instead (enforced at open). This is
> implemented canonically in `apps/worker/lib/crypto.ts` (`NO_AAD`), Rust
> `open_record_for_reader`, mobile `mobile_decrypt_message`, and the desktop
> client's `encryptMessage`/`decryptMessage`. The canonical non-empty AAD pair
> from §2.3 is for notes, files, and contact identifiers only — never for
> `LABEL_MESSAGE` or `LABEL_CALL_META`. (This section previously specified
> `UTF-8(label)` / `UTF-8("{label}:key-wrap")` here; that spelling is retired
> and must be refused, not accepted.)
>
> **Mobile writers must not choose the AAD (#1927).** iOS and Android once
> sealed `LABEL_MESSAGE` with the retired canonical pair, and Android also
> opened with it. Every message the server wrote was then unreadable on
> Android, and every reply a phone wrote was unreadable everywhere. Mobile
> seals with `mobile_encrypt_message` and opens with `mobile_decrypt_message`.
> Both take the record whole, and Rust binds the AAD. Neither builds this
> envelope from `mobile_symmetric_encrypt` / `mobile_hpke_seal_key` with a
> caller-supplied `aadHex`.

#### Conformance vector

`packages/crypto/tests/fixtures/stored-record-vectors.json` holds a
`LABEL_MESSAGE` record and a `LABEL_CALL_META` record. Both were **written by the
server**: `packages/crypto/scripts/gen-stored-record-vectors.ts` runs
`encryptMessageForStorage` / `encryptCallRecordForStorage` on the real crypto
library. They are sealed to two fixed X25519 test keys, and the file lists those
keys' secrets. A conforming reader on any platform MUST:

1. open each record, through its production decrypt path, to the recorded
   `plaintext`;
2. FAIL to open it under the canonical `UTF-8(label)` /
   `UTF-8("{label}:key-wrap")` AAD.

A conforming writer's output MUST open under the same reader that opens the
fixture. The vector is regenerated, never edited by hand. Its ciphertext is
randomised per run, so a consumer opens the recorded bytes and never compares
them against a fresh seal. Rust checks it in
`ffi_v3::stored_record_vector_tests` (`cargo test --features mobile`).

#### Decryption

```
decryptMessage(encrypted_content_hex, reader_envelopes[], device_x25519_secret_key[32], reader_pubkey_hex):

  1. Find matching envelope:
     envelope = reader_envelopes.find(e => e.pubkey === reader_pubkey_hex)
     // Return null if no matching envelope

  2. Unwrap message key via HPKE:
     enc_bytes = hex_to_bytes(envelope.enc)
     ct_bytes  = hex_to_bytes(envelope.ct)
     message_key = HPKE.Open(
       recipientSk = device_x25519_secret_key,
       enc         = enc_bytes,
       ciphertext  = ct_bytes,
       info        = UTF-8("llamenos:message"),
       aad         = empty
     )

  3. Decrypt content with AES-256-GCM:
     data = hex_to_bytes(encrypted_content_hex)
     iv   = data[0..12]
     ciphertext_with_tag = data[12..]
     plaintext = AES-256-GCM.decrypt(
       key        = message_key,
       iv         = iv,
       aad        = empty,
       ciphertext = ciphertext_with_tag
     )

  4. Return UTF-8 string
```

#### Server-Side Encryption (Inbound Webhooks)

When the server receives an inbound message via a messaging webhook (SMS/WhatsApp/Signal), it encrypts the plaintext immediately using the same envelope pattern:

1. Server generates a random `message_key`.
2. Server encrypts the plaintext with AES-256-GCM with **empty AAD** (stored-record format, see the note above).
3. Server wraps `message_key` for each authorized reader (the assigned volunteer's devices + the instance key `ADMIN_DECRYPTION_PUBKEY`, which is transitional and in no hub reader set — §2.4.2; super-admins are never readers — see the admin invariant in §4.15) via HPKE with `LABEL_MESSAGE` as `info` and **empty AAD**. See `apps/worker/lib/crypto.ts` `encryptMessageForStorage()`.
4. Plaintext is discarded from memory. The server cannot read stored messages after this point.

