# Llamenos Protocol: REST API: notes and calls

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 4.7 Notes

All note endpoints require `notes:read-own` baseline. Clients must encrypt notes before sending (Section 2.3).

```
GET /api/hubs/:hubId/notes?callId=...&page=1&limit=50
Permission: notes:read-own (own only) or notes:read-all (all notes)
Response: { "notes": EncryptedNote[], "total": number }

POST /api/hubs/:hubId/notes
Permission: notes:create
Body: {
  "callId"?: string,            // an active call or a call record in the hub; no calls:read-history needed
  "conversationId"?: string,    // one of callId / conversationId is required
  "encryptedContent": hex,
  "authorEnvelope"?: { "enc": hex64, "ct": hex },         // KeyEnvelope (HPKE; no pubkey field)
  "adminEnvelopes"?: { "pubkey": hex64, "enc": hex64, "ct": hex }[]  // RecipientEnvelope[]
}
Response: 201 { "note": EncryptedNote }   // NoteStoredResponse — wrapped, never the bare note

PATCH /api/hubs/:hubId/notes/:id
Permission: notes:update-own
Body: {
  "encryptedContent": hex,
  "authorEnvelope"?: { "enc": hex64, "ct": hex },         // KeyEnvelope (HPKE; no pubkey field)
  "adminEnvelopes"?: { "pubkey": hex64, "enc": hex64, "ct": hex }[]  // RecipientEnvelope[]
}
Response: { "note": EncryptedNote }       // NoteStoredResponse
```

Hub-only: notes exist only inside a hub. There is no unscoped `/api/notes`; the router answers `404` to any request outside `/hubs/:hubId` (#2395).

**Server-side write guards (#2112, #2113).** The server never holds a note's content key, so a malformed write cannot be repaired afterwards; it is refused at the boundary instead:

- `callId` / `conversationId` must name an existing call (live or finished) / conversation **of the hub in the path**. A record of another hub and one that does not exist are both `404` with the same message.
- `adminEnvelopes` must include at least one envelope addressed to a member of the note's hub's `admin` reader set (§2.4.2: the registered device keys of the members holding the admin minimum in that hub — the same set the hub last-admin invariant counts — and the hub's escrow key; super-admins are never readers), or, transitionally, to `ADMIN_DECRYPTION_PUBKEY`, which shipped clients still seal to and which is in no reader set. An empty or absent set, or one addressed only to other keys, is `422`. The same rule applies to `PATCH` whenever it replaces `encryptedContent` or `adminEnvelopes` (the author is checked first, so a non-author gets `403`), to note replies (`readerEnvelopes`), to client-sealed outbound messages (`readerEnvelopes`) and to reports (`readerEnvelopes`).
- A hub with **no** resolvable admin recipient at all (an empty `admin` reader set — no admin of the hub with a registered device and no hub escrow key — and no `ADMIN_DECRYPTION_PUBKEY`) is **refused** with `503` and an operator-visible error log. The hub last-admin invariant guarantees the hub has an admin, so an empty recipient set is a misconfiguration, and storing under it would create a note nobody can ever open. Server-sealed records (inbound messages, call records) are unaffected: the server cannot refuse a caller who has already spoken, so those keep the loud-but-stored contract.

### 4.8 Calls

Hub-only: calls exist only inside a hub. There is no unscoped `/api/calls`; the router answers `404` to any request outside `/hubs/:hubId` (#2461). The paths below are written unscoped for brevity and are served under `/api/hubs/:hubId/...`.

Every lookup by `:callId` is bounded to the path hub: a call of another hub reads as missing. A client acting on a call (answer, hang up, spam, ban) addresses the call's own hub, which need not be the one being browsed (multi-hub routing axiom).

```
GET /api/calls/active
Permission: calls:read-active (redacted caller info) or calls:read-active-full
Response: { "calls": CallRecord[] }

GET /api/calls/today-count
Permission: calls:read-active
Response: { "count": number }

GET /api/calls/presence
Permission: calls:read-presence
Response: { "volunteers": [...] }

GET /api/hubs/:hubId/calls/history?page=1&limit=50&search=&status=&dateFrom=&dateTo=
Permission: calls:read-history or calls:read-own-history
Response: { "calls": EncryptedCallRecord[], "total": number, "page": number, "limit": number,
            "access": { "scope": "all" }
                    | { "scope": "own", "windowDays": number, "availableSince": ISO-8601 } }
// calls:read-history: every finished call of the hub, scope "all".
// Otherwise calls:read-own-history (#1342): only the calls the caller answered whose answer time
// is at or after availableSince = server now − the hub's volunteerAccessDays, bounded in the same
// query as the hub and the filters (total and pages describe exactly that set). `access` is always
// present: a client with scope "own" says "calls older than <windowDays> days are no longer
// available to you" rather than presenting a short list as the whole history.
// The window is ACCESS CONTROL, not cryptographic expiry: the volunteer's device key is in the
// record's envelope (§2.5), so a record already fetched stays decryptable after the window
// passes. Nothing is deleted; the record stays the admin system of record.

GET /api/hubs/:hubId/calls/:callId
Permission: calls:read-active
Response: CallRecord
// A live call, or a finished one under the same bound as /history: any finished call to a holder
// of calls:read-history, only the caller's own inside the window to a holder of
// calls:read-own-history, otherwise 404 (as for an unknown id).

POST /api/calls/:callId/answer
Permission: calls:answer
Response: { "call": CallRecord }
Error: 409 "Call already answered"

POST /api/calls/:callId/hangup
Permission: calls:hangup
Response: { "call": CallRecord }
Error: 403 "Not your call", 404 "Call not found"

POST /api/calls/:callId/spam
Permission: calls:report-spam
Response: { ...spamResult }
Error: 403 "Not your call", 404 "Call not found"

GET /api/calls/:callId/recording
Permission: calls:read-recording or answering volunteer
Response: audio/wav binary
Headers: Content-Type: audio/wav, Cache-Control: private, no-store
Error: 404 "No recording available for this call" (hasRecording is false),
       404 "Recording not available" (marked, but the server holds no copy)

GET /api/calls/debug
Permission: calls:debug
Response: internal call state
```

Hub-scoped: `/api/hubs/:hubId/calls/*`

#### Call recording storage (#2309)

An opted-in call recording (`recordCalls`) never stays at the telephony provider:

1. `POST /api/telephony/call-recording` tracks the provider's copy in `provider_recordings` (kind `call`) before anything else.
2. The server fetches the audio once and stores it in its own object storage at `call-recordings/{hubId}/{callId}`, sealed with AES-256-GCM under a key HKDF-derived from `SERVER_KEK` (info = `LABEL_CALL_RECORDING_SEAL`, AAD = `label:hubId:callId`). The call is then marked `hasRecording`. A copy is never overwritten.
3. The provider's copy is deleted through `TelephonyAdapter.deleteRecording`, with the same fail-loud contract as voicemail.
4. Playback reads only the sealed copy, under the request's hub. The provider is never asked for a call recording again.

If the copy cannot be made — the provider returns no audio, or storage or `SERVER_KEK` is unavailable — the provider's copy is NOT deleted, because it is then the only copy. The failure is recorded on the ledger row (`delete_attempts`, `last_error`), audited as `providerRecordingDeleteFailed`, shown in `heldAtProvider`, and retried by the `provider-recording-sweep` worker (copy first, then delete). The retention purge and the hub shred delete the sealed copy along with the provider's copy; a copy that cannot be deleted is audited as `callRecordingCopyDeleteFailed`.

The copy is server-readable (Tier 1, at rest), not E2EE: the server already sees the audio when it fetches it, and clients play `audio/wav` from this endpoint unchanged. Sealing it to the admins' and answering volunteer's HPKE keys would need client-side decryption on every platform.

#### Provider identifiers in logs and audit rows (#2333)

A provider's identifier for a call, recording or message (`CallSid`, `RecordingSid`, `MessageSid`, the Vonage/Plivo/Telnyx/Bandwidth UUIDs) is the key to the provider's own CDR, which holds the caller's number. Logs, audit rows and ledger error text therefore never carry one; they carry a **provider ref**:

```
key = HKDF-SHA256(ikm = HMAC_SECRET, salt = "", info = UTF-8(LABEL_PROVIDER_REF_KEY), L = 32)
ref = "pr_" + hex(HMAC-SHA256(key, UTF-8(providerId)))[0..16]
```

- The structured logger writes any `callId`, `callSid`, `parentCallSid`, `legSid`, `recordingSid`, `messageSid`, `callUuid`, `callControlId`, `providerCallId` or `providerMessageId` field as `<field>Ref`, and replaces any Twilio/SignalWire SID (`[A-Z]{2}` + 32 hex) in a message or value with its ref. `AuditService.log` does the same to `details` before the hash chain commits to them.
- A request is logged by its matched route (`/api/hubs/:hubId/calls/:callId/answer`), never its URL.
- Debugging one call: take the id from the provider's console or CDR, run `bun run provider-ref <id>` where the app runs (`docker compose exec app bun scripts/provider-ref.ts <id>`), and grep the logs for the ref. Someone with only the logs, or only the provider's records, cannot make that link without `HMAC_SECRET`. Rotating `HMAC_SECRET` changes every ref.
- Kept raw, because the server needs them to act: `active_calls.call_id`, `call_records.call_id`, `call_tokens.call_sid`, `provider_recordings.call_id` / `recording_sid` (the handle is handed back to the provider to delete the recording), the call id in API paths and bodies, relay events and VoIP push payloads, and the object-storage key of a sealed recording. A call's id **is** the provider's id for it; separating the two (an internal call id, with the provider id a stored attribute) is a larger change and is not part of this one.

