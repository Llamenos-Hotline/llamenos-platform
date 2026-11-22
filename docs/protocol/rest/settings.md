# Llamenos Protocol: REST API: settings

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 4.12 Settings

#### Telephony Provider

```
GET /api/settings/telephony-provider
Permission: settings:manage-telephony
Response: TelephonyProviderConfig | null

PATCH /api/settings/telephony-provider
Permission: settings:manage-telephony
Body: TelephonyProviderConfig
Response: { "ok": true }

POST /api/settings/telephony-provider/test
Permission: settings:manage-telephony
Body: { "type": "twilio"|"signalwire"|..., ...provider_credentials }
Response: { "ok": true } or { "ok": false, "error": "..." }
```

#### Recording Posture (#1505, #2297, #2309)

```
GET /api/hubs/:hubId/settings/telephony-provider/recording-posture
Permission: settings:manage-telephony
Response: RecordingPostureResponse
Error: 404 "No telephony provider is configured"

POST /api/hubs/:hubId/settings/telephony-provider/recording-posture/enforce
Permission: settings:manage-telephony, plus system:manage-instance when the hub
            has no provider of its own (it runs on the shared platform account)
Response: { actions: ProviderSettingEnforcement[], posture: RecordingPostureResponse }
Error: 403 { required: "system:manage-instance" }, 404 "No telephony provider is configured"
Audit: providerRecordingPostureEnforced (every action, with its outcome)
```

```typescript
type ProviderSettingReading =
  | { state: 'off'; evidence: string }      // read from the provider
  | { state: 'on'; evidence: string }
  | { state: 'unknown'; reason: string }    // could not be read — never reported as off

interface RecordingPostureResponse {
  provider: string
  recording: ProviderSettingReading         // recording this server did NOT request
  transcription: ProviderSettingReading     // transcription this server did NOT request
  heldAtProvider: Array<{                   // tracked until the provider confirms deletion
    callId: string
    kind: 'voicemail' | 'call' | 'call-log'
    createdAt: string
    deleteAttempts: number
    lastAttemptAt: string | null
    lastError: string | null
  }>
  retention: {                              // from provider documentation, not read from the account
    removed: Array<{ what: string; how: string }>
    retained: Array<{ what: string; reason: string }>   // never empty
    source: string
  }
}

type ProviderSettingEnforcement =
  | { setting: 'recording' | 'transcription'; target: string; outcome: 'disabled'; evidence: string }
  | { setting: 'recording' | 'transcription'; target: string; outcome: 'already-off'; evidence: string }
  | { setting: 'recording' | 'transcription'; target: string; outcome: 'not-settable'; reason: string }
  | { setting: 'recording' | 'transcription'; target: string; outcome: 'failed'; reason: string }
```

Enforce writes first, then re-reads the posture. The re-read, not the write, is what shows a setting as off. What each provider's API lets enforce change:

| Provider | Recording | Transcription |
|----------|-----------|---------------|
| Twilio | Elastic SIP trunk: `POST trunking.twilio.com/v1/Trunks/{Sid}/Recording` `Mode=do-not-record`. A number routed to this server needs no change. A number routed elsewhere is `not-settable`: Twilio has no number-level switch, and the server does not rewrite routing. | Every Conversational Intelligence service with `auto_transcribe`: `POST intelligence.twilio.com/v2/Services/{Sid}` `AutoTranscribe=false` (Twilio documents up to five minutes to propagate) |
| SignalWire | `already-off`: a SignalWire SIP trunk has no recording feature. Number routing is handled as for Twilio. | `not-settable`: no account-level switch is published |
| Telnyx | `PATCH /v2/phone_numbers/{id}/voice` `call_recording.inbound_call_recording_enabled=false` | `not-settable`: no account- or number-level switch is documented |
| Vonage, Plivo, Bandwidth | `not-settable`: no account-level switch; recording happens only when this server's NCCO/XML/BXML asks | `not-settable` |
| Asterisk, FreeSWITCH | `not-settable`: dialplan configuration on the PBX host | `not-settable`: modules on the PBX host |

#### Provider-held media and logs (#2297, #2309)

What each provider keeps about a call, and what of it this server removes. This is also returned live as `retention` in the posture reading. A provider's own records that this server cannot remove are listed here by name; they are never assumed to be zero.

| Provider | Deleted by this server | Retained at the provider |
|----------|------------------------|--------------------------|
| Twilio | Voicemail and call recordings (`DELETE /Recordings/{Sid}`). Call records of the caller's call and of every volunteer ring leg (`DELETE /Calls/{Sid}`), once the call has ended; Twilio refuses while it is in progress. | SMS/WhatsApp message records and bodies (not deleted by this server; Twilio says bodies persist up to 30 days in backups after a `DELETE`). Recordings and transcriptions this server did not request (reported, not deleted). Usage and billing records. Debugger and error logs of webhook requests. |
| SignalWire | Voicemail and call recordings; call records of the caller's call and every ring leg (compatibility API `DELETE /Calls/{Sid}`). | SMS message records and bodies (not deleted by this server). Recordings and transcriptions this server did not request. Usage, billing and log records outside the compatibility API. |
| Telnyx | Voicemail and call recordings (`DELETE /v2/recordings/{id}`). | Call detail records of every leg: no deletion API was found. Messaging detail records with text: redaction exists only for allowlisted organisations, is applied at read time, and is not configured by this server. Recording transcriptions this server did not request. Usage and billing records. |
| Vonage | Voicemail and call recordings (Media API `DELETE /v3/media/{id}`). | Voice CDRs, with both numbers, for 13 months: the Redact API strips numbers, but only after Vonage provisions access and the CDR reaches long-term storage, and this server does not call it. Server logs (about 15 days; Messages API about 10), which the Redact API cannot reach. Conversation API call legs. SMS/Messages records. |
| Plivo | Voicemail and call recordings (`DELETE /Recording/{id}/`). | Call detail records: no deletion API was found. SMS content: redacted only when sent with `log=false` or received under `log_incoming_messages=false`, neither of which this server sets. Transcriptions this server did not request: no API lists them. |
| Bandwidth | Voicemail and call recordings (`DELETE /calls/{callId}/recordings/{id}`). | Call detail records and call events: no deletion API was found. MMS media for up to 48 hours (Bandwidth states it keeps no message text). |
| Asterisk, FreeSWITCH | Voicemail and call recordings on the PBX host (sip-bridge `DELETE /recordings/:name`). | CDRs and logs on the operator's own PBX host, under its CDR configuration (PBX retention policy: #1320). CDRs at the upstream SIP trunk carrier. |

Call-log deletion uses the same `provider_recordings` ledger as recordings, with kind `call-log`. The caller's call is tracked from `POST /api/telephony/incoming`, banned calls included. Each volunteer ring leg is tracked as it is dialled. The sweep deletes them once the call is no longer in `active_calls`. A refusal stays in `heldAtProvider` with the provider's error and is audited as `providerCallLogDeleteFailed`. Only adapters whose provider documents a deletion (`TelephonyAdapter.deleteCallLog`) track call logs at all.

#### Messaging

```
GET /api/settings/messaging
Permission: settings:manage-messaging
Response: MessagingConfig

PATCH /api/settings/messaging
Permission: settings:manage-messaging
Body: partial MessagingConfig
Response: { "ok": true }
```

#### Spam Mitigation

```
GET /api/settings/spam
Permission: settings:manage-spam
Response: SpamSettings

PATCH /api/settings/spam
Permission: settings:manage-spam
Body: partial SpamSettings (a field left out is left unchanged — no defaults are applied)
Response: SpamSettings
```

`SpamSettings.overLimitAction` (`"reject" | "message" | "voicemail"`, default
`"message"`) is what a caller over `maxCallsPerMinute` gets: refused unanswered,
the `rateLimited` prompt played unrecorded before the call ends, or voicemail.
A caller who fails or times out of the voice CAPTCHA (two attempts; `*` replays
the digits) is offered voicemail. Every one of these raises a `spam` hub incident
(counts only) for the hub's `settings:manage-spam` holders.

#### Call Settings

```
GET /api/settings/call
Permission: settings:manage
Response: CallSettings

PATCH /api/settings/call
Permission: settings:manage
Body: partial CallSettings
Response: { "ok": true }

GET /api/hubs/:hubId/settings/call-history-access
Permission: settings:manage-calls
Response: { "volunteerAccessDays": number }   // CallHistoryAccessSettings; 7 when never set

PATCH /api/hubs/:hubId/settings/call-history-access
Permission: settings:manage-calls
Body: { "volunteerAccessDays"?: integer 1..365 }   // forPatch: an omitted key changes nothing
Response: { "volunteerAccessDays": number }
// Hub-only: there is no platform value. The volunteer call-history ACCESS window (#1342) — how
// far back a holder of only calls:read-own-history is served their own calls. It is not data
// retention and never deletes. A change is audited (`callHistoryAccessUpdated`) with
// oldVolunteerAccessDays and newVolunteerAccessDays.
```

#### IVR Languages

```
GET /api/settings/ivr-languages
Permission: settings:manage-ivr
Response: { "enabledLanguages": string[] }

PATCH /api/settings/ivr-languages
Permission: settings:manage-ivr
Body: { "enabledLanguages": string[] }
Response: { "ok": true }
```

#### IVR Audio

Recordings are per hub (`ivr_audio` is keyed `(hub_id, prompt_type, language)`). A call
in hub H plays H's recording, else the platform default, else generated speech.
Under `/api/hubs/:hubId/settings/ivr-audio` each verb reaches only that hub's recordings.
On the global mount (`/api/settings/ivr-audio`) they manage the platform defaults and
additionally require `system:manage-instance`; `?hubId=` is ignored there.

```
GET /api/settings/ivr-audio
Permission: settings:manage-ivr
Response: { "audios": [...] }

PUT /api/settings/ivr-audio/:promptType/:language
Permission: settings:manage-ivr
Content-Type: application/octet-stream (raw audio bytes)
Response: { "ok": true }

DELETE /api/settings/ivr-audio/:promptType/:language
Permission: settings:manage-ivr
Response: { "ok": true }
```

#### Transcription

```
GET /api/settings/transcription
Auth: Required (any role)
Response: { "globalEnabled": boolean, "allowVolunteerOptOut": boolean, ... }

PATCH /api/settings/transcription
Permission: settings:manage-transcription
Body: partial transcription settings
Response: { "ok": true }
```

#### Custom Fields

```
GET /api/settings/custom-fields
Auth: Required (returns filtered by role)
Response: { "fields": CustomFieldDefinition[] }

PUT /api/settings/custom-fields
Permission: settings:manage-fields
Body: { "fields": CustomFieldDefinition[] }
Response: { "ok": true }
```

#### WebAuthn Settings

```
GET /api/settings/webauthn
Permission: settings:manage
Response: { "requireForAdmins": boolean, "requireForVolunteers": boolean }

PATCH /api/settings/webauthn
Permission: settings:manage
Body: { "requireForAdmins"?: boolean, "requireForVolunteers"?: boolean }
Response: { "ok": true }
```

#### Roles (PBAC)

A role's name and description are organisational vocabulary and are never sent
or stored in the clear (#2780). Only the seeded default roles carry a plaintext
`name`, because theirs are public constants. Every custom role has `name: null`
and `slug` equal to its `id`; a slug typed from the name would be the name again.

Two scopes:

- **Deployment-wide** (`hubId: null`): the seeded defaults and platform roles. A
  platform role's name and description exist only in per-admin HPKE `envelopes`
  (`LABEL_PLATFORM_ROLE_NAME_ENCRYPT` / `LABEL_PLATFORM_ROLE_DESC_ENCRYPT`, AAD
  `"{roleId}:name"` / `"{roleId}:description"`).
- **Hub-owned** (`hubId` set): sealed by the client under that hub's key with
  `LABEL_HUB_ROLE_ENCRYPT`, in the hub-field format `hex(nonce_12 ‖ ct ‖ tag_16)`
  with the label as AAD. Readable by exactly the hub's members. A hub role is
  listed and grantable only inside its own hub, never as a global role, and may
  not carry an instance-level permission (`*`, `system:*` other than
  `system:view-*`).

Request bodies are strict: a plaintext `name`, `slug` or `description` is a 400.

```
GET /api/settings/roles
Permission: system:view-roles
Response: { "roles": Role[] }            -- deployment-wide roles only

POST /api/settings/roles
Permission: system:manage-roles
Body: { "id"?: "role-<uuid>", "permissions": string[], "envelopes"?: RoleEnvelope[] }
Response: Role (201)

PATCH /api/settings/roles/:id            -- deployment-wide roles; 404 for a hub's
Permission: system:manage-roles
Body: { "permissions"?: string[] }
Response: Role

DELETE /api/settings/roles/:id
Permission: system:manage-roles
Response: { "ok": true }

POST /api/settings/roles/:id/envelopes   -- re-seal a platform role's name
Permission: system:manage-roles
Body: { "envelopes": RoleEnvelope[] }
Response: { "ok": true }

GET /api/hubs/:hubId/settings/roles
Permission: system:view-roles
Response: { "roles": Role[] }            -- deployment-wide roles + this hub's own

POST /api/hubs/:hubId/settings/roles
Permission: system:manage-roles (and the caller holds every permission granted)
Body: { "permissions": string[], "encryptedName": hex, "encryptedDescription"?: hex }
Response: Role (201)

PATCH /api/hubs/:hubId/settings/roles/:id
Permission: system:manage-roles
Body: { "permissions"?: string[], "encryptedName"?: hex, "encryptedDescription"?: hex | null }
Response: Role

DELETE /api/hubs/:hubId/settings/roles/:id
Permission: system:manage-roles
Response: { "ok": true }
```

A template's suggested roles (`GET /api/settings/cms/templates/:id`) are public
constants. The client seals each one it imports and creates it through
`POST /api/hubs/:hubId/settings/roles`; the server has no route that creates
roles from a template. Residual exposure: a hub role's permission set is stored
in the clear, and a template's suggested permission sets are public, so a role
imported unmodified from a template can be matched to its template entry by
its permissions alone.

#### Permissions Catalog

```
GET /api/settings/permissions
Permission: system:manage-roles
Response: {
  "permissions": { [key: string]: string },
  "byDomain": { [domain: string]: [{ "key": string, "label": string }] }
}
```

#### Setup State

```
GET /api/settings/setup
Permission: settings:manage
Response: SetupState

PATCH /api/settings/setup
Permission: settings:manage
Body: partial SetupState
Response: SetupState
```

