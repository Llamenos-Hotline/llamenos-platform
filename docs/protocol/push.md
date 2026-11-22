# Llamenos Protocol: Push notification protocol

> Part of the [Llamenos Interoperability Protocol](PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

## 5. Push Notification Protocol

For mobile clients (iOS/Android), push notifications deliver time-sensitive events (incoming calls, new messages) when the app is backgrounded.

### 5.1 Device Registration

```
POST /api/devices/register
Auth: Required
Body: {
  "platform": "ios" | "android",
  "pushToken": string,              // APNs device token or FCM registration token
  "wakeKeyPublic": hex,             // 33-byte compressed secp256k1 pubkey (66 hex chars)
  "ed25519Pubkey"?: hex,            // Phase 6: 32-byte Ed25519 signing pubkey (64 hex chars)
  "x25519Pubkey"?: hex              // Phase 6: 32-byte X25519 encryption pubkey (64 hex chars)
}
Response: 204 No Content (empty body)
```

### 5.2 Two-Tier Encryption

Push notifications use a two-tier encryption scheme to balance security with usability:

**Tier 1 -- Wake Key (No PIN Required)** (`LABEL_PUSH_WAKE`)
- A symmetric "wake key" is generated per-device at registration time.
- It is HPKE-wrapped for the device's X25519 pubkey and stored server-side.
- Push payloads are encrypted with this wake key.
- The app can decrypt the push payload without requiring PIN entry.
- Contains only: notification type, conversation/call ID, and display-safe metadata.

**Tier 2 -- Full Decryption (PIN Required)** (`LABEL_PUSH_FULL`)
- Message content, caller details, and other sensitive data remain encrypted with the device's identity key.
- The app must prompt for PIN unlock to decrypt the full content.
- This mirrors the behavior of the desktop app's locked/unlocked states.

### 5.3 Push Payload Format

```json
{
  "encrypted": "<hex_nonce24_ciphertext>",
  "deviceId": "<uuid>"
}
```

Decrypted content (Tier 1):

```json
{
  "type": "call:ring" | "message:new" | "conversation:assigned" | "report:new",
  "id": "resource_id",
  "preview": "Safe display text (no PII)",
  "timestamp": 1709318400
}
```

### 5.4 VoIP Push (iOS)

For incoming call notifications on iOS, a VoIP push is sent via APNs with a 30-second deadline. The app MUST:

1. Report a new incoming call to CallKit within 30 seconds.
2. Decrypt the wake-key-encrypted payload to get the call ID.
3. Display the CallKit incoming call UI.
4. If the user answers, prompt for PIN to unlock the identity key.
5. Use the identity key to authenticate and answer the call via REST API.

**The push names the call by an opaque reference, never by the call's id (#2374).** The VoIP push body is `{ "type": "incoming_call", "call-id": <ref>, "hub-id": <hub> }` on both APNs and ntfy, and nothing else — no caller digits. A call's id is the telephony provider's identifier for it (the webhook's `CallSid`, or the UUID the other providers issue): a key into the provider's CDR, which holds the caller's number, and a push leaves our systems for Apple and the ntfy relay. `<ref>` is 128 random bits minted per call (`active_calls.push_ref`), unrelated to the call's id. The wire key stays `call-id` because the clients and liblinphone read that key; its value is a reference, not an id usable in the API. A client resolves it to the call by matching `pushRef` on `GET /api/hubs/:hubId/calls/active`, with `:hubId` the push's `hub-id`, and the `call:ring` relay event carries the same `pushRef` next to its `callId`. The reference is deleted with the call's live row when the call ends.

### 5.5 Hub Routing for Push Notifications

The `hubId` field in a decrypted wake payload identifies which hub the notification belongs to. Clients must dispatch the notification to the correct hub handler regardless of which hub is currently active in the UI.

**Routing rules:**
- `incoming_call`: iOS: call `linphoneService.handleVoipPush(callId:hubId:)`. Android: call `linphoneService.storePendingCallHub(callId, hubId)`. Do NOT switch the active hub context.
- All other types (`shift_reminder`, `announcement`, `call_ended`): Store `hubId` in notification extras for navigation on tap. Do NOT switch the active hub context.

**Active hub switching is permitted only when:**
1. The user explicitly taps a delivered notification (notification tap callback).
2. The app is unlocked and the user initiates answering a call (the `handleIncomingCall` app-unlocked path).

This constraint preserves the multi-hub axiom: a user browsing Hub A must not have their context silently switched to Hub B by a background notification.

---

