# Llamenos Protocol: Cryptographic operations: reader sets and assignee re-wrap

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 2.4.1 Assignee Re-wrap (Client-Mediated)

A message's `message_key` is wrapped only for the readers known when it was
written (§2.4), and the server discards it. So when a conversation is claimed
(`POST /conversations/:id/claim`) or reassigned (`PATCH /conversations/:id`),
the messages already in it are sealed to the admins alone. The server holds no
secret that opens an envelope, by design, so it cannot add the new assignee.
Sealing to a wider set up front instead — every eligible volunteer, or the hub
key — would widen who can read caller content, so the protocol does not do it.

The re-wrap therefore runs on a client that can already open the messages: an
admin client whose device holds an envelope on them (in practice the holder of
the admin decryption key). Plaintext and `message_key` never reach the server on
this path. The server only ever **appends** envelopes, so no existing reader
loses access, and the ciphertext is not touched.

#### Exchange

```
Trigger (on the re-wrapping client):
  - a `conversation:assigned` event from ANY member hub (§3.2) — never gated on
    the active hub; and
  - every relay (re)connect: sweep the hub's active conversations
    (GET /conversations?status=active), so an assignment made while no admin
    client was online is closed by the first one to come online.

Loop, per conversation:
  1. gaps = GET /hubs/:hubId/conversations/:id/assignee-envelopes
       → { assignedTo,
           recipients: [{ pubkey: x25519_hex, keySetAt: iso8601, confirmed: bool }],
           messages: [{ id, createdAt: iso8601, readerEnvelopes: RecipientEnvelope[],
                        missingRecipients: x25519_hex[] }] }
     At most 200 messages, oldest first. Messages with NO envelopes are never
     listed: nobody holds a key that could re-wrap them. Neither is a message
     whose every missing key is withheld by the gate in step 3.
     If gaps.messages is empty → done.

  2. Refuse an incoherent answer: assignedTo must be set, and every
     missingRecipients key must appear in recipients and be 64 hex chars.

  3. For each listed message:
       own = readerEnvelopes.find(e => e.pubkey is this device's key)
       if none → skip (this device is not a reader; another reader must do it)
       message_key = HPKE.Open(own, info = UTF-8("llamenos:message"), aad = empty)
       for each pk in missingRecipients that mayRewrapHistoryTo(recipients[pk], message.createdAt):
         (a key withheld by the gate is skipped and logged, never an error)
         sealed = HPKE.Seal(pk, message_key, info = UTF-8("llamenos:message"), aad = empty)
         entry  = { messageId: id,
                    envelope: { pubkey: pk, enc: hex(sealed[0..32]), ct: hex(sealed[32..]) } }
     The envelope is byte-for-byte the §2.4 stored-record format; a reader
     cannot tell a re-wrapped envelope from one sealed at write time.

  4. POST /hubs/:hubId/conversations/:id/assignee-envelopes
       { envelopes: entry[] }        // 1..1000 per request
       → { added: number }
     All-or-nothing. 400 if any envelope names a key that is not a registered
     X25519 device key of the CURRENT assignee; 404 if a message is not in the
     conversation; 409 if the conversation has no assignee or a message has no
     readers. 400 also if an envelope names a key for which
     mayRewrapHistoryTo is false (see Trust). An envelope for a recipient that
     already has one on that message is skipped — first write wins, because the server cannot tell a correct
     re-wrap from a wrong one.

  5. If no entry was produced, or added == 0 (another re-wrapper got there
     first), stop. Otherwise go to 1.
```

Both routes require `conversations:read-all`; the POST also requires
`conversations:update` (adding a reader is the same class of authority as
reassigning). A conversation outside the caller's hub answers 404.

When `added > 0` the server publishes
`{"type": "conversation:envelopes-added", "conversationId", "assignedTo", "added"}`
on `KIND_CONVERSATION_ASSIGNED` to the conversation's hub, so the assignee's
open thread re-reads its messages. It carries ids and a count, never key
material.

Request/response schemas: `assigneeEnvelopeGapsResponseSchema`,
`addAssigneeEnvelopesBodySchema` and `addAssigneeEnvelopesResponseSchema` in
`packages/protocol/schemas/conversations.ts` (codegen'd to Swift and Kotlin as
`AssigneeEnvelopeGapsResponse`, `AddAssigneeEnvelopesBody`,
`AddAssigneeEnvelopesResponse`). Desktop implementation:
`src/client/lib/assignee-rewrap.ts` + `platform.ts` `rewrapMessageKey`.

#### Availability (known dependency, not a defect)

If no admin client is online, the gap stays open until one is: the assignee
sees the pre-claim messages as `[Encrypted]` until then. This is inherent to a
zero-knowledge re-wrap: the only parties able to produce the envelope are
clients that can already read the message. Messages that arrive *after* the
claim are sealed to the assignee at write time and are unaffected. Platforms
without a re-wrapper implementation (iOS and Android at the time of writing)
do not close the gap, so a hub whose admins use only those platforms gets no
re-wrap.

#### Trust

The keys sealed to come from the server's device registry (`devices.x25519_pubkey`
of the assignee). That is the same registry every message write path already
trusts to name a user's readers — the server resolves recipients for inbound
messages (§2.4 server-side encryption), and clients take the admin recipient
from server config. A malicious server could list a key of its own as the
assignee's device and receive content keys for the messages this exchange
covers. The client refuses answers that are internally inconsistent (step 2),
but it cannot yet verify a device key independently; that requires the user
sigchain (§2.11, "Device Authorization (Sigchain)") to be checked before sealing, and when
it is wired in, the re-wrapper MUST verify each recipient against the
assignee's sigchain. **That is the M2 gate; until then this is an accepted
risk** (docs/security/THREAT_MODEL.md, "Recipient Keys Are Server-Listed").

What the exchange does enforce is a narrower rule, aimed at a stolen session
rather than the server. A record is never re-wrapped to a key that was set
after it was written unless that key is confirmed:

```
mayRewrapHistoryTo(recipient, recordCreatedAt) =
    recipient.confirmed  OR  recipient.keySetAt <= recordCreatedAt
```

- `keySetAt` is `devices.x25519_set_at`: when the X25519 value last changed
  (set on insert; moved by a registration that changes the value; untouched by
  a re-registration of the same key). `registered_at` is not used — it does not
  move when a session overwrites an existing device's key.
- `confirmed` is true when a device verification (SAS) of that device exists
  from the key's owner or from an admin of the conversation's hub, recorded at
  or after `keySetAt`, against the device's current signing key.
- A key that predates the record (the ordinary claim path) is unaffected.

The client applies the rule before sealing; the server repeats it when envelopes
are POSTed. The client is the primary gate — the server's refusal is defence in
depth. Every input is server-asserted, so a server that backdates `keySetAt` or
inserts a verification defeats it; it raises the bar for a holder of a stolen
session, not for a malicious server. Any further automatic re-wrap of history
MUST use this same predicate (`mayRewrapHistoryTo`,
`packages/shared/history-rewrap-gate.ts`).

### 2.4.2 Reader Sets

Every envelope set in §2.3–§2.5 seals one content key to a list of readers.
Which keys belong on that list is defined once, here, as a function of a hub
and a **purpose**:

```
readersFor(hub, purpose) =
    { d.x25519_pubkey : d a registered device of u,
                        u an active member of hub with no erasure in flight
                          and an unrevoked signing key,
                        u's roles IN hub (users.hub_roles for hub, never the
                          global users.roles) together grant every permission
                          in READER_PURPOSE_PERMISSIONS[purpose] }
  ∪ { hub.escrow_pubkey }   if the hub has one
```

| Purpose        | Permissions held in the hub                | Operator decision |
|----------------|--------------------------------------------|-------------------|
| `admin`        | `settings:manage` + `notes:read-all` (the admin minimum) | D1 |
| `call-history` | `calls:read-history`                       | D2 |
| `shift-overrides` | `shifts:manage-overrides`              | #2778 |

**Subject readers.** Some records are additionally sealed to the one member
they are *about*. A subject reader purpose maps to permissions in
`SUBJECT_READER_PURPOSE_PERMISSIONS` (`packages/shared/permissions.ts`), and its
reader set is the subject's own registered X25519 device keys, present only
when the subject holds those permissions through their roles in the record's
hub (same candidate filter as above). It is never a set of all holders, so it
is not a value of `GET /api/hubs/:hubId/readers?purpose=`, and it is not part of
the escrow-setter requirement. It only ever ADDS to a hub-wide set; it does not
replace one.

| Subject purpose    | Subject                          | Permissions held in the hub | Operator decision |
|--------------------|----------------------------------|-----------------------------|-------------------|
| `call-history-own` | the volunteer who answered a call | `calls:read-own-history`   | D3 (#1342) |

Rules:

- **Permissions, never roles.** A hub's role catalogue is user-definable, so
  membership is decided by the permissions a member's roles grant, resolved
  against the live role definitions (`READER_PURPOSE_PERMISSIONS` in
  `packages/shared/permissions.ts`, evaluated by `holdsInHub` in
  `apps/worker/lib/hub-admin.ts`). No role id or name appears in the rule.
- **The `admin` set is the admin invariant.** Its holders are exactly the
  admins the hub last-admin invariant (§4.15) refuses to let reach zero, so a
  hub that keeps an admin keeps an admin reader as soon as that admin registers
  a device.
- **Super-admins are not readers** (D1: "Global super-admins are NOT readers of
  any hub's notes, records, messages or PII by default. A super-admin reads a hub
  only by being given a role in that hub, like anyone else."). The global
  `users.roles` is never consulted, so a super-admin's `*` reaches no hub.
- **The instance-wide `ADMIN_DECRYPTION_PUBKEY` is in no reader set** (D1: "the
  global `ADMIN_DECRYPTION_PUBKEY` ... [is] removed. A platform-wide decryption
  key contradicts zero knowledge."). Desktop, iOS and Android
  now all seal to the reader set; the write guard (§4.7) still *accepts* an
  envelope addressed to it, as a separately named transitional recipient, only
  until that guard is removed. It is never returned by `readersFor`.
- **The escrow key** is an optional X25519 public key whose secret the hub's
  admins hold offline (D1: "an optional per-hub escrow/recovery key controlled
  by the hub"). It reads every purpose (A7). It is set, rotated and removed
  only by a member holding, in that hub's own role assignments,
  `hubs:manage-keys` **and** every purpose's permissions — nobody may confer
  read access they do not hold (`PUT`/`DELETE /api/hubs/:hubId/escrow-key`,
  §4.15). It may not equal any registered device key, any user's Ed25519
  identity key, or `ADMIN_DECRYPTION_PUBKEY`. Rotation does not re-seal history.
- **Only X25519 keys.** Every entry is a device encryption key or the escrow
  key, never an Ed25519 `users.pubkey` (#1021, #1283).
- **Zero readers is an invariant violation, never a fallback** (A8: "a write
  with zero readers must never be possible ... refuse, alert the operator, and
  log loudly. Do NOT add a quarantine or 'store unreadable' fallback."). A
  writer that finds an empty set refuses the write; the server refuses the
  escrow removal that would empty a hub's `admin` set.
- **Readers are fixed at write time.** A reader added later (a new admin, a new
  device) does not gain earlier records; §2.4.1 describes the one re-wrap that
  exists.

Clients obtain a hub's set from `GET /api/hubs/:hubId/readers?purpose=<purpose>`
(§4.15), for the record's own hub — never the active hub, if they differ — and
seal the author's own device in addition. The purpose is a closed enum: a
client never names a permission.

What a client does with the answer is decided once, in `packages/crypto`
(`readers::resolve_admin_readers`, exported to iOS and Android as
`mobileResolveAdminReaders`; desktop applies the same rule in `hubAdminReaders`):
each entry is trimmed and lowercased, an entry that is not 64 lowercase hex
characters is dropped and never repaired, duplicates are removed (first wins,
server order kept), and an empty result is the error `NoAdminReader` — the write
is refused and the user's input kept, never sealed to the author alone and never
to a substitute key (the author's own key and `ADMIN_DECRYPTION_PUBKEY`
included). The mobile clients no longer read `adminDecryptionPubkey` from
`/api/auth/me` for any hub content: notes, note replies, reports, conversation
replies, case summaries and comments, events, contacts and entity file fields are
sealed to the full `admin` set of the hub they are written in.

Clients take this list as the server serves it. A malicious server could list a
key of its own; verifying each device key against its owner's sigchain (§2.11)
before sealing is the M2 gate, and until then this is the accepted risk recorded
in docs/security/THREAT_MODEL.md ("Recipient Keys Are Server-Listed") — the same
trust every server-resolved recipient list already carries (§2.4.1, "Trust").

