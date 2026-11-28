# Llamenos Protocol: REST API: provider setup and templates

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 4.43 Provider Setup

Telephony provider OAuth, configuration, and number management.

```
POST /api/provider-setup/oauth/start
Permission: telephony:manage-providers
Body: { "provider": string, "redirectUrl": string }
Response: { "authUrl": string, "stateId": string, "expiresAt": ISO8601 }

POST /api/provider-setup/oauth/callback
Auth: None (state token is proof)
Body: { "code"?: string, "state"?: string, "error"?: string }
Response: 302 Redirect or JSON { "redirectUrl": string }

GET  /api/provider-setup/oauth/callback
Auth: None
Query: ?code=&state=&error=
Response: 302 Redirect or JSON { "redirectUrl": string }

GET  /api/provider-setup/oauth/status/:state
Permission: telephony:manage-providers
Response: OAuthFlowState

POST /api/provider-setup/configure
Permission: telephony:manage-providers
Body: { "provider": string, "credentials"?: object, "phoneNumber"?: string, "hubId"?: string }
Response: { "ok": true }

POST /api/provider-setup/test
Permission: telephony:manage-providers
Body: { "provider": string, "hubId"?: string }
Response: { "connected": boolean, "latencyMs": number, "accountName"?: string, "error"?: string }

GET  /api/provider-setup/status/:provider
Permission: telephony:view-providers
Response: ProviderStatus

GET  /api/provider-setup/phone-numbers
Permission: telephony:view-numbers
Query: ?provider=&hubId=
Response: { "numbers": OwnedNumber[] }

POST /api/provider-setup/phone-numbers/search
Permission: telephony:manage-numbers
Body: NumberSearchQuery
Response: { "numbers": AvailableNumber[] }
Rate limit: 5/min

POST /api/provider-setup/phone-numbers/provision
Permission: telephony:manage-numbers
Body: NumberProvisionRequest
Response: { ...OwnedNumber, "webhookWarning"?: string }
Rate limit: 1/min

POST /api/provider-setup/configure-webhooks
Permission: telephony:manage-providers
Body: { "provider": string, "numberId": string, "enableSms"?: boolean, "hubId"?: string }
Response: { "ok": true }

POST /api/provider-setup/create-sip-trunk
Permission: telephony:manage-providers
Body: { "provider": string, "domain": string, "hubId"?: string }
Response: { "sipProvider": string, "sipUsername": string, "credentialsStored": boolean, "trunkSid"?: string, "connectionId"?: string }

// Signal Bridge Registration
POST /api/provider-setup/signal/register
Permission: messaging:manage-signal
Body: { "bridgeUrl": string, "phoneNumber": string, "method"?: "sms"|"voice", "hubId"?: string }
Response: SignalRegistration

GET  /api/provider-setup/signal/status
Permission: messaging:manage-signal
Query: ?hubId=&registrationId=
Response: SignalRegistration

POST /api/provider-setup/signal/verify
Permission: messaging:manage-signal
Body: { "registrationId": string, "code": string }
Response: SignalRegistration  // a rejected code is a 200 with status "verifying" (or "failed" on the third miss)
Rate limit: 5/min

// SignalRegistration: { id, hubId, method: "sms"|"voice",
//   status: "idle"|"pending"|"verifying"|"complete"|"failed",
//   phoneNumberMasked: string  // "****" + last 4 digits — the raw number never leaves the server
//   attempts: number, error: string|null, expiresAt: string|null, createdAt, updatedAt }
// State machine: idle -> pending -> verifying -> complete; pending -> complete (SMS auto-confirmed);
// pending|verifying -> failed (10-minute expiry, or the third wrong code). complete/failed are terminal.
// Clients poll only while "pending"; "verifying" waits on the admin's code.

DELETE /api/provider-setup/signal/unregister
Permission: messaging:manage-signal
Query: ?registrationId=
Response: { "ok": true }

GET  /api/provider-setup/signal/account
Permission: messaging:manage-signal
Query: ?registrationId=
Response: SignalAccountInfo

// A2P Registration
POST /api/provider-setup/a2p/brand
Permission: telephony:manage-a2p
Body: { "providerType"?: string, "brandInfo": object, "hubId"?: string }
Response: A2pRegistration

POST /api/provider-setup/a2p/campaign
Permission: telephony:manage-a2p
Body: { "registrationId": string, "campaignInfo": object }
Response: A2pRegistration

GET  /api/provider-setup/a2p/status
Permission: telephony:manage-a2p
Query: ?hubId=&registrationId=
Response: A2pRegistrationStatus

POST /api/provider-setup/a2p/skip
Permission: telephony:manage-a2p
Body: { "providerType"?: string, "hubId"?: string }
Response: A2pRegistrationStatus
```

Hub-scoped: `/api/hubs/:hubId/provider-setup/*`

### 4.44 Provider Templates

Reusable provider configuration templates. Super-admin only for writes.

```
GET    /api/provider-templates
Permission: telephony:view-providers
Response: { "templates": ProviderTemplate[] }

GET    /api/provider-templates/:id
Permission: telephony:view-providers
Response: { "template": ProviderTemplate }

POST   /api/provider-templates
Permission: system:manage-instance
Body: CreateProviderTemplateBody
Response: { "template": ProviderTemplate } (201)
Rate limit: 5/min

PUT    /api/provider-templates/:id
Permission: system:manage-instance
Body: UpdateProviderTemplateBody
Response: { "template": ProviderTemplate }

DELETE /api/provider-templates/:id
Permission: system:manage-instance
Response: { "ok": true }
```

