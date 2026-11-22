# Llamenos Protocol: Cryptographic operations: case records and availability

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 2.18 Case Record and Case Comment Encryption

A case record carries two client-sealed ciphertexts — its **summary**
(`encryptedSummary` / `summaryEnvelopes`) and its custom-field values, the
**fields** (`encryptedFields` / `fieldEnvelopes`) — and every **comment** on its
timeline carries a third (`encryptedContent` / `contentEnvelopes` on an
interaction of type `comment`). All three use one construction, differing only in
the label:

| Purpose | Label | Registry `labelId` |
|---------|-------|--------------------|
| summary | `LABEL_CASE_SUMMARY` (`llamenos:case-summary`) | 30 |
| fields | `LABEL_CASE_FIELDS` (`llamenos:case-fields`) | 31 |
| comment | `LABEL_CASE_COMMENT` (`llamenos:case-comment`) | 109 |

```
content_key      = random 32 bytes, fresh per ciphertext
encryptedContent = hex(iv(12) || AES-256-GCM(content_key, plaintext, aad = UTF-8(label)) || tag(16))
envelope         = { pubkey, enc, ct }                       all hex
  pubkey = the reader's X25519 public key — the key the wrap is sealed to
  enc    = the 32-byte HPKE encapsulated key
  ct     = HPKE(info = label, aad = UTF-8(label + ":key-wrap")).Seal(content_key)   48 bytes
```

This is the **canonical** AAD convention (§2.3), on both layers. It is not the
stored-record convention of §2.4: a stored message carries no AAD only because a
conversation mixes client- and server-sealed messages with no format marker. A
case ciphertext has one writer kind, so it takes the stronger binding. A case
ciphertext MUST NOT be sealed under `LABEL_MESSAGE` or with an empty AAD on either
layer, and a reader MUST NOT fall back to either. Each purpose has its own label so
that a server cannot move a comment into a record's summary column (or swap
summary and fields) and have it open: a ciphertext opens as no purpose but its own.

**Readers.** The sealing device is always a reader. The other readers are X25519
keys chosen by the caller: the tier the server names for the payload
(`GET /api/records/envelope-recipients?entityTypeId=&assignedTo=` before the
record exists, `GET /api/records/:id/envelope-recipients` after — a `summary`
payload takes the `summary` tier, custom field values and timeline comments the
`fields` tier, contact PII the `pii` tier), plus the hub's admin decryption key.
A failed lookup falls back to the sealing device plus the admin key and never to
another key; a write with no admin key is refused (#1682). Readers are
de-duplicated; an empty reader set is refused. A device's Ed25519 account key is
never an envelope address and is never sealed to.

#### Where the decision lives

The label, both AADs, the envelope shape and the reader set's wire form are
decided **once**, in `packages/crypto/src/case_record.rs`. Every platform reaches
it through an operation that takes a *purpose* — `summary`, `fields` or
`comment` — and **no label and no AAD**:

| Platform | Seal | Open |
|----------|------|------|
| Desktop (Tauri IPC) | `seal_case_from_state` | `open_case_from_state` |
| iOS / Android (UniFFI) | `mobile_seal_case` | `mobile_open_case` |
| Server (`bun:ffi`) | `ffi_case_seal` (`caseSeal`) | `ffi_case_open` (`caseOpen`) — conformance only; the server holds no reader key |

Three platforms once disagreed here — iOS sealed `LABEL_CASE_SUMMARY` with the
canonical AAD, desktop and Android `LABEL_MESSAGE` with none, and Android sealed
comments as notes and opened them as messages (#2499). That was possible only
because each call site chose the label and AAD itself. A platform implementation
MUST NOT compose a case ciphertext from the generic HPKE / AES primitives.

#### Conformance vector

`packages/crypto/tests/fixtures/case-record-vectors.json` holds one summary, one
fields payload and one comment **as the server persisted them**:
`packages/crypto/scripts/gen-case-record-vectors.ts` seals each through
`case_record.rs`, sends it through the routes' request validators and
`CasesService` into a PostgreSQL database, and records what reads back. They are
sealed to the two fixed X25519 test keys of §2.4's vector. A conforming platform
MUST open each record through its production reader to the recorded `plaintext`;
MUST NOT open any of them as a stored message (`LABEL_MESSAGE`, empty AAD) or as
another purpose; and its writer's output MUST open under the record's declared
label and AAD. Pinned by `packages/crypto/tests/case_record_vectors.rs`,
`apps/desktop/src/crypto.rs` (`case_record_conformance_tests`),
`tests/crypto-interop.spec.ts` (the desktop test build), `CaseRecordVectorTests`
(iOS), `CaseRecordVectorTest` (Android) and
`apps/worker/__tests__/integration-bun/case-record-vectors.test.ts` (server).

Case records and comments written before #2499 by desktop or Android
(`LABEL_MESSAGE`, no AAD) and comments written by Android (sealed as notes) do not
open under this construction. Pre-production: no migration or fallback reader is
provided.

### 2.19 Availability Reasons and Shift Override Notes

Two shift rows carry a sentence a person typed: an availability block's **reason**
(`encryptedReason`, why a volunteer cannot take shifts) and a shift override's
**note** (`encryptedNote`, why a shift is cancelled or who covers it). Both are
client-sealed with the §2.18 construction, differing only in the label:

| Purpose | Label | Registry `labelId` |
|---------|-------|--------------------|
| availability reason | `LABEL_AVAILABILITY_REASON` (`llamenos:availability-reason`) | 81 |
| override note | `LABEL_SHIFT_OVERRIDE_NOTE` (`llamenos:shift-override-note`) | 84 |

On the wire each is one object, `SealedShiftField`, or `null` when there is no text:

```
SealedShiftField = { "encryptedContent": hex, "envelopes": RecipientEnvelope[] (≥ 1) }
  encryptedContent = hex(iv(12) || AES-256-GCM(content_key, plaintext, aad = UTF-8(label)) || tag(16))
  envelope.ct      = HPKE(info = label, aad = UTF-8(label + ":key-wrap")).Seal(content_key)
```

A bare string is **refused** (400). Both fields used to be `z.string()` and the only
writer (iOS) sent the typed text, so two columns named `encrypted_*` held plaintext
(#2777, #2778); the migration that introduced envelopes scrubbed every such value.
The server stores the object as two columns (`encrypted_reason` + `reason_envelopes`,
`encrypted_note` + `note_envelopes`) and returns it unchanged; a row with only one of
the two reads as `null`.

**Readers.** The sealing device is always a reader. The others are the hub's
`admin` reader set (§2.4.2) — and, for an override note, the `shift-overrides` set,
whose holders can list overrides without being admins. An availability reason is
sealed to admins only: the route that lists every block requires `shifts:manage`,
which only a `shifts:*` or `*` wildcard grants, so admins are exactly who can read
reasons today; a reason is never sealed to every hub member. A client with no
`admin` reader refuses to write. The server refuses (422) a field whose envelopes
name no admin recipient, and 503 when the hub has no admin recipient at all (§4.7
write guard, `assertAdminCanRead`). The note is never written to the audit log.

**Where the decision lives.** `packages/crypto/src/shift_record.rs`, reached through
an operation that takes a purpose (`availability-reason`, `override-note`) and no
label or AAD: `mobile_seal_shift_field` / `mobile_open_shift_field` on iOS and
Android. A reason opens as no note and a note as no reason, and neither opens as a
case ciphertext. Desktop and Android do not collect either field yet.

---

