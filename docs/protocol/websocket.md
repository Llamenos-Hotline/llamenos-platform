# Llamenos Protocol: WebSocket event schema

> Part of the [Llamenos Interoperability Protocol](PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

## 3. WebSocket Event Schema

Llamenos uses a built-in WebSocket endpoint on the API server for real-time event distribution. All events are server-signed and encrypted with the hub key.

### 3.1 Event Kind Definitions

#### Regular Events (Persisted)

| Kind | Constant | Purpose |
|------|----------|---------|
| 1000 | `KIND_CALL_RING` | Incoming call notification -- triggers volunteer ringing |
| 1001 | `KIND_CALL_UPDATE` | Call state update (answered, completed, etc.) |
| 1002 | `KIND_CALL_VOICEMAIL` | Voicemail received for a call |
| 1010 | `KIND_MESSAGE_NEW` | New conversation message (inbound from external channel) |
| 1011 | `KIND_CONVERSATION_ASSIGNED` | Conversation assignment changed |
| 1020 | `KIND_SHIFT_UPDATE` | Shift schedule changed |
| 1030 | `KIND_SETTINGS_CHANGED` | Settings changed (global or hub-scoped) |
| 1050 | `KIND_HUB_INCIDENT` | A hub incident opened, updated or closed. Content is `{incidentId, state}` ONLY (see §4.39) |

#### Ephemeral Events (Not Persisted, Broadcast Only)

| Kind | Constant | Purpose |
|------|----------|---------|
| 20000 | `KIND_PRESENCE_UPDATE` | Volunteer presence update -- online counts, availability |
| 20001 | `KIND_CALL_SIGNAL` | Call answer/hangup signals -- real-time coordination |

#### Authentication Events

| Type | Constant | Purpose |
|------|----------|---------|
| `auth` | `EVENT_AUTH` | WebSocket authentication |

### 3.2 Event Format

All server-published events follow this structure:

```json
{
  "kind": 1000,
  "created_at": 1709318400,
  "tags": [
    ["d", "global"],
    ["t", "llamenos:event"]
  ],
  "content": "<encrypted_json_string>",
  "id": "<computed_event_id>",
  "pubkey": "<server_WebSocket_pubkey>",
  "sig": "<schnorr_signature>"
}
```

#### Tag Convention

All events include a generic `type` field inside the encrypted payload. This prevents the WebSocket infrastructure from distinguishing between event types (call events, message events, settings events all look the same to the server).

The `["d", "global"]` tag is used for hub-wide broadcasts. Hub-scoped events would use `["d", hub_id]`.

#### Content Encryption

The `content` field is always encrypted:
- **Hub-wide broadcasts**: Encrypted with the hub key (Section 2.8).
- **Targeted messages**: Encrypted via HPKE (Section 2.2) targeted to the recipient's X25519 pubkey.

The plaintext content is a JSON string with a `type` field identifying the event type:

```json
{"type": "call:ring", "callId": "abc123"}
{"type": "call:answered", "callId": "abc123", "answeredBy": "pubkey_hex"}
{"type": "call:end", "callId": "abc123"}
{"type": "presence:update", "onlineCount": 5}
{"type": "message:new", "conversationId": "conv123", "channelType": "sms"}
{"type": "message:status", "conversationId": "conv123", "messageId": "msg456", "status": "delivered"}
{"type": "conversation:assigned", "conversationId": "conv123", "assignedTo": "pubkey_hex"}
{"type": "conversation:envelopes-added", "conversationId": "conv123", "assignedTo": "pubkey_hex", "added": 3}
{"type": "shift:update", "shiftId": "shift123"}
{"type": "settings:changed", "section": "spam"}
{"type": "report:new", "conversationId": "conv123", "category": "harassment"}
```

### 3.3 Server Signing

Events are signed using the server's derived keypair (Section 2.9). Clients verify against the `serverWebSocketPubkey` from `GET /api/config`.

```
signServerEvent(payload, secret_key):
  // Serialize payload deterministically
  message = SHA-256(JSON.stringify(payload))
  // Sign with BIP-340 Schnorr
  signature = schnorr.sign(message, secret_key)
  return { payload, signature: hex(signature), pubkey: serverPubkey }
```

### 3.4 Client Connection

Clients connect to the WebSocket endpoint provided by `GET /api/config`:
- `wsUrl`: WebSocket URL (e.g., `wss://api.example.com/ws` or relative `/ws`)
- If `wsUrl` is null, WebSocket real-time is not configured.

Clients authenticate and then receive events for their subscribed hubs:

```json
{
  "action": "subscribe",
  "hubIds": ["hub-id-1", "hub-id-2"]
}
```

---

