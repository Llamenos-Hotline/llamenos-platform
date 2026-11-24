# Llamenos Protocol: REST API: sigchain, PUK and MLS

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 4.37 Sigchain

Per-device key authorization sigchain (Phase 6).

```
GET  /api/users/:targetPubkey/sigchain
Auth: Required (self or admin)
Response: { "links": SigchainLinkRecord[], "integrityBreak": { "seqNo": number, "reason": string } | null }
  integrityBreak is non-null when the stored chain forks or has a gap; readers MUST check it before trusting links

POST /api/users/:targetPubkey/sigchain
Auth: Required (self only)
Body: { "seqNo": number (≥ 1), "linkType": "genesis"|"device_add"|"device_remove"|"key_rotate"|"puk_epoch", "payload": object, "signature": hex128, "prevHash": hex64|null, "hash": hex64, "signerDeviceId": string, "signerPubkey": hex64, "timestamp": ISO8601 }
Response: SigchainLinkRecord (201) — includes "timestamp" (part of the hashed form)
Error: 400 on invalid link semantics (genesis only at seq 1, payload.type must match linkType,
       payload shape per §2.11, signerPubkey must be the user's identity key, genesis must name
       its signing device), non-canonical payload numbers, or entry-hash mismatch
Error: 409 on hash-chain continuity violation (seqNo / prevHash, incl. a concurrent append)
```

Canonical rules (binding — the crate verifier in `packages/crypto` is the
client-side wire contract):

- **Genesis**: the first link has `seqNo = 1` and `prevHash = null` (JSON
  null, never `""`). Subsequent links have `seqNo = previous + 1` and
  `prevHash` = the previous link's hash. (`""` is accepted as a legacy alias
  for `null` and normalized; the canonical wire form is `null`.)
- **Entry hash**: `SHA-256` of the compact UTF-8 JSON object
  `{payload, prevHash, seq, signerDeviceId, signerPubkey, timestamp}` with
  keys sorted lexicographically at every nesting level (recursive sort; the
  top-level sort order is as listed). See `compute_entry_hash` in
  `packages/crypto/src/sigchain.rs` for the full cross-platform
  canonicalization algorithm and test vectors.
- **Numbers**: all payload numbers must be plain integers ≤ 2^53. Integers
  serialize without decimal points or exponents (`"seq":1`, never `"1.0"` or
  `"1e0"`); anything else is rejected with 400 rather than hashed, because
  platforms disagree on non-integer number formatting.

### 4.38 PUK (Per-User Key)

PUK envelope distribution and retrieval (Phase 6).

```
POST /api/puk/envelopes
Auth: Required
Body: { "envelopes": [{ "deviceId": string, "generation": number (≥ 1), "envelope": HpkeEnvelope }] }
  deviceId: sigchain device ID (§2.11); must be authorised by the caller's sigchain
  envelope: { "v": 3, "labelId": number, "enc": base64url, "ct": base64url }
Response: { "distributed": number, "envelopes": PukEnvelope[] } (201)
Error: 400 if any envelope is addressed to a device the sigchain does not authorise (nothing stored)

GET  /api/puk/envelopes/:deviceId
Auth: Required (own device only)
Response: PukEnvelope
Error: 404 if no envelope found
```

### 4.39 MLS (Message Layer Security)

Hub-scoped MLS handshake message routing (Phase 6). Only available under `/api/hubs/:hubId/mls/*`.

```
POST /api/hubs/:hubId/mls/commit
Auth: Required (hub member)
Body: { "recipientDeviceIds": string[], "payload": base64url }
Response: 204 No Content

POST /api/hubs/:hubId/mls/welcome
Auth: Required (hub member)
Body: { "recipientDeviceId": string, "payload": base64url }
Response: 204 No Content

GET  /api/hubs/:hubId/mls/messages
Auth: Required (hub member)
Query: ?deviceId=<deviceId>
Response: { "messages": MlsMessage[] }
Note: Fetch-and-clear semantics

POST /api/hubs/:hubId/mls/key-packages
Auth: Required (hub member)
Query: ?deviceId=<deviceId>
Body: { "keyPackages": base64url[] }
Response: 204 No Content
```

