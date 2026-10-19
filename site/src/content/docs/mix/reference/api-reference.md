---
title: Referencia API
description: Referencia completa endpoints REST API nuu servidor Llámenos.
---

Yaa documento describe cada endpoint REST API expuesto por servidor Llámenos. Todos endpoints tienen prefijo `/api`. Solicitudes ni respuestas usan JSON a menos ke se indique lo contrario. Todas marcas tiempo son cadenas ISO 8601.

API es misma ya sea ke backend corra nuu **Cloudflare Workers** (nuu Durable Objects) o **autoalojado** (Node.js + PostgreSQL). Seis Durable Objects — Identity, Settings, Records, ShiftManager, CallRouter, ni Conversation — mapean a dominios API lógicos descritos debajo.

## Autenticación

Llámenos soporta dos mecanismos autenticación. Todos endpoints autenticados requieren uno.

### Autenticación firma Schnorr (primaria)

Cada solicitud autenticada lleva token auto-firmado BIP-340 Schnorr vinculado a método HTTP ni ruta.

**Formato encabezado:**

```
Authorization: Bearer {"pubkey":"<64_hex>","timestamp":<ms>,"token":"<128_hex>"}
```

**Construcción token:**

1. Construya mensaje: `llamenos:auth:<pubkey>:<timestamp_ms>:<METHOD>:<path>`
2. Hash nuu SHA-256
3. Firme hash nuu BIP-340 Schnorr usando clave secreta secp256k1
4. Codifique como JSON inline nuu campos `pubkey`, `timestamp`, ni `token` (firma hex)

**Reglas validación:**

- Frescura token: `|now() - timestamp| <= 300,000 ms` (ventana 5 minutos)
- Firma se verifica contra hash mensaje reconstruido
- Clave pública se busca nuu almacén identidad nuu resolver registro usuario

### Autenticación token sesión (WebAuthn)

Después ceremonia autenticación WebAuthn, servidor emite token sesión aleatorio 256 bits válido nuu 8 horas.

```
Authorization: Session <token_hex>
```

Servidor verifica auth `Session` primero. Si encabezado empieza nuu `Session `, no se intenta auth Schnorr, ni viceversa.

---

## Endpoints públicos

Estos endpoints no requieren autenticación.

### Verificación salud

```
GET /api/health
```

**Respuesta:**

```json
{ "status": "ok" }
```

### Configuración

```
GET /api/config
```

Devuelve configuración hub pública, canales habilitados, ni identidad servidor.

**Respuesta:**

```json
{
  "hotlineName": "Hotline",
  "hotlineNumber": "+1234567890",
  "channels": {
    "voice": true, "sms": false, "whatsapp": false,
    "signal": false, "rcs": false, "reports": true
  },
  "setupCompleted": true,
  "needsBootstrap": false,
  "hubs": [{ "id": "...", "name": "...", "slug": "..." }],
  "defaultHubId": "...",
  "serverWebSocketPubkey": "hex_64",
  "WebSocketRelayUrl": "wss://..."
}
```

### Verificación construcción

```
GET /api/config/verify
```

Devuelve metadatos construcción nuu verificación construcción reproducible.

**Respuesta:**

```json
{
  "version": "1.0.0",
  "commit": "abc1234",
  "buildTime": "2024-01-01T00:00:00Z",
  "verificationUrl": "https://github.com/...",
  "trustAnchor": "GitHub Release checksums + SLSA provenance"
}
```

### Audio IVR

```
GET /api/ivr-audio/:promptType/:language
```

Devuelve archivos audio obtenidos por proveedores telefonía durante llamadas.

- `promptType`: `[a-z_-]+`
- `language`: `[a-z]{2,5}(-[A-Z]{2})?`
- **Respuesta:** binario `audio/wav`

### Preferencias mensajería

Endpoints públicos validados token nuu gestión preferencias suscriptor.

```
GET  /api/messaging/preferences?token=<hmac_token>
PATCH /api/messaging/preferences?token=<hmac_token>
```

**Cuerpo PATCH:**

```json
{ "status": "active", "language": "es" }
```

---

## Endpoints autenticación

### Inicio sesión

```
POST /api/auth/login
```

**Cuerpo:**

```json
{ "pubkey": "hex64", "timestamp": 1709318400000, "token": "hex128" }
```

**Respuesta:**

```json
{ "ok": true, "roles": ["role-super-admin"] }
```

Rate limit: 10 intentos por IP. Devuelve `401` nuu credenciales inválidas.

### Bootstrap (primer ña'a)

```
POST /api/auth/bootstrap
```

Registra primera cuenta ña'a. Falla nuu `403` si ya existe ña'a.

**Cuerpo:** Mismo que inicio sesión.
**Respuesta:** Mismo que inicio sesión.
Rate limit: 5 intentos por IP.

### Obtener usuario actual

```
GET /api/auth/me
```

**Auth:** Requerido

**Respuesta:**

```json
{
  "pubkey": "hex64",
  "roles": ["role-super-admin"],
  "permissions": ["*"],
  "primaryRole": { "id": "role-super-admin", "name": "Super Admin", "slug": "super-admin" },
  "name": "Admin",
  "transcriptionEnabled": true,
  "spokenLanguages": ["en", "es"],
  "uiLanguage": "en",
  "profileCompleted": true,
  "onBreak": false,
  "callPreference": "phone",
  "webauthnRequired": false,
  "webauthnRegistered": true,
  "adminPubkey": "hex64",
  "adminDecryptionPubkey": "hex64"
}
```

### Cerrar sesión

```
POST /api/auth/me/logout
```

**Auth:** Requerido. Si usa auth Session, token se revoca servidor.

### Actualizar perfil

```
PATCH /api/auth/me/profile
```

**Auth:** Requerido

**Cuerpo:**

```json
{
  "name": "string",
  "phone": "+1234567890",
  "spokenLanguages": ["en", "es"],
  "uiLanguage": "en",
  "profileCompleted": true,
  "callPreference": "phone"
}
```

Todos campos son opcionales. `callPreference` acepta `"phone"`, `"browser"`, o `"both"`.

### Actualizar disponibilidad

```
PATCH /api/auth/me/availability
```

**Auth:** Requerido

**Cuerpo:**

```json
{ "onBreak": true }
```

### Actualizar preferencia transcripción

```
PATCH /api/auth/me/transcription
```

**Auth:** Requerido

**Cuerpo:**

```json
{ "enabled": false }
```

Devuelve `403` si opt-out no está permitido por ajustes ña'a.

---

## WebAuthn

### Flujo inicio sesión

```
POST /api/webauthn/login/options
```

**Auth:** Ninguna. Devuelve `publicKeyCredentialRequestOptions` nuu `challengeId`.

```
POST /api/webauthn/login/verify
```

**Auth:** Ninguna

**Cuerpo:**

```json
{ "assertion": {}, "challengeId": "uuid" }
```

**Respuesta:**

```json
{ "token": "hex64", "pubkey": "hex64" }
```

### Flujo registro

```
POST /api/webauthn/register/options
```

**Auth:** Requerido

**Cuerpo:**

```json
{ "label": "My Phone" }
```

```
POST /api/webauthn/register/verify
```

**Auth:** Requerido

**Cuerpo:**

```json
{ "attestation": {}, "label": "My Phone", "challengeId": "uuid" }
```

### Gestión credenciales

```
GET /api/webauthn/credentials
```

**Auth:** Requerido. Devuelve todas credenciales registradas.

```
DELETE /api/webauthn/credentials/:credId
```

**Auth:** Requerido. Elimina iin credencial.

---

## Invitaciones

### Público

```
GET /api/invites/validate/:code
```

Rate limit: 5 intentos por IP.

**Respuesta:**

```json
{ "valid": true, "name": "...", "expiresAt": "..." }
```

```
POST /api/invites/redeem
```

**Cuerpo:**

```json
{ "code": "...", "pubkey": "hex64", "timestamp": 1709318400000, "token": "hex128" }
```

Rate limit: 5 intentos por IP.

### Autenticado

```
GET /api/invites
```

**Permiso:** `invites:read`

```
POST /api/invites
```

**Permiso:** `invites:create`

**Cuerpo:**

```json
{ "name": "Jane Doe", "phone": "+1234567890", "roleIds": ["role-volunteer"] }
```

```
DELETE /api/invites/:code
```

**Permiso:** `invites:revoke`

---

## Voluntarios

Todos endpoints voluntarios requieren `volunteers:read` como permiso base.

```
GET /api/volunteers
```

**Permiso:** `volunteers:read`

```
POST /api/volunteers
```

**Permiso:** `volunteers:create`

**Cuerpo:**

```json
{ "name": "string", "phone": "string", "roleIds": ["string"], "pubkey": "string" }
```

```
PATCH /api/volunteers/:targetPubkey
```

**Permiso:** `volunteers:update`

**Cuerpo:** Campos voluntario parciales (`name`, `phone`, `roles`, `active`, etc.)

```
DELETE /api/volunteers/:targetPubkey
```

**Permiso:** `volunteers:delete`

---

## Turnos

```
GET /api/shifts/my-status
```

**Auth:** Requerido (cualquier rol). Devuelve estado turno usuario actual.

```
GET /api/shifts
```

**Permiso:** `shifts:read`

```
POST /api/shifts
```

**Permiso:** `shifts:create`

**Cuerpo:**

```json
{
  "name": "Morning Shift",
  "startTime": "09:00",
  "endTime": "17:00",
  "days": [1, 2, 3, 4, 5],
  "volunteerPubkeys": ["hex64", "hex64"]
}
```

```
PATCH /api/shifts/:id
```

**Permiso:** `shifts:update`

```
DELETE /api/shifts/:id
```

**Permiso:** `shifts:delete`

### Grupo timbrado respaldo

```
GET /api/shifts/fallback
```

**Permiso:** `shifts:manage-fallback`

```
PUT /api/shifts/fallback
```

**Permiso:** `shifts:manage-fallback`

**Cuerpo:**

```json
{ "fallbackPubkeys": ["hex64", "hex64"] }
```

Ámbito hub: Todos endpoints turnos también disponibles nuu `/api/hubs/:hubId/shifts/*`.

---

## Notas

Todos endpoints nota requieren `notes:read-own` como base. Clientes deben cifrar notas antes enviar (ver [especificación protocolo](https://github.com/rhonda-rodododo/llamenos-platform/blob/main/docs/protocol/PROTOCOL.md) nuu formato sobre ECIES).

```
GET /api/notes?callId=...&page=1&limit=50
```

**Permiso:** `notes:read-own` (solo propias) o `notes:read-all` (todas notas)

**Respuesta:**

```json
{ "notes": [], "total": 0 }
```

```
POST /api/notes
```

**Permiso:** `notes:create`

**Cuerpo:**

```json
{
  "callId": "uuid",
  "encryptedContent": "hex",
  "authorEnvelope": { "wrappedKey": "hex", "ephemeralPubkey": "hex" },
  "adminEnvelopes": [{ "pubkey": "hex64", "wrappedKey": "hex", "ephemeralPubkey": "hex" }]
}
```

```
PATCH /api/notes/:id
```

**Permiso:** `notes:update-own`

**Cuerpo:** Misma forma que POST (nuu contenido cifrado actualizado ni sobres).

Ámbito hub: `/api/hubs/:hubId/notes/*`

---

## Llamadas

```
GET /api/calls/active
```

**Permiso:** `calls:read-active` (info llamante redactada) o `calls:read-active-full`

```
GET /api/calls/today-count
```

**Permiso:** `calls:read-active`

```
GET /api/calls/presence
```

**Permiso:** `calls:read-presence`. Devuelve estado en línea/ocupado voluntarios.

```
GET /api/calls/history?page=1&limit=50&search=&dateFrom=&dateTo=
```

**Permiso:** `calls:read-history`

```
POST /api/calls/:callId/answer
```

**Permiso:** `calls:answer`. Devuelve `409` si llamada ya fue respondida.

```
POST /api/calls/:callId/hangup
```

**Permiso:** `calls:answer`. Devuelve `403` si no es su llamada.

```
POST /api/calls/:callId/spam
```

**Permiso:** `calls:answer`. Marca llamada como spam.

```
GET /api/calls/:callId/recording
```

**Permiso:** `calls:read-recording` o voluntario respondiente.

**Respuesta:** binario `audio/wav` nuu `Cache-Control: private, no-store`.

```
GET /api/calls/debug
```

**Permiso:** `calls:debug`. Devuelve estado interno llamada nuu solución problemas.

Ámbito hub: `/api/hubs/:hubId/calls/*`

---

## Conversaciones

```
GET /api/conversations?status=&channel=&page=1&limit=50
```

**Permiso:** `conversations:read-all` o `conversations:read-assigned` (propias + esperando)

**Respuesta:**

```json
{
  "conversations": [],
  "total": 0,
  "assignedCount": 0,
  "waitingCount": 0,
  "claimableChannels": ["sms", "whatsapp"]
}
```

```
GET /api/conversations/stats
```

**Auth:** Requerido

**Respuesta:**

```json
{ "total": 0, "active": 0, "waiting": 0, "closed": 0 }
```

```
GET /api/conversations/load
```

**Permiso:** `conversations:read-all`. Devuelve conteos conversación por voluntario.

```
GET /api/conversations/:id
```

**Auth:** Requerido (acceso verificado por conversación).

```
GET /api/conversations/:id/messages?page=1&limit=50
```

**Auth:** Requerido (acceso verificado). Devuelve mensajes cifrados.

```
POST /api/conversations/:id/messages
```

**Permiso:** `conversations:send` o `conversations:send-any`

**Cuerpo:**

```json
{
  "encryptedContent": "hex",
  "readerEnvelopes": [{ "pubkey": "hex64", "wrappedKey": "hex", "ephemeralPubkey": "hex" }],
  "plaintextForSending": "Hello"
}
```

Campo `plaintextForSending` se usa nuu canales externos (SMS, WhatsApp, Signal). Servidor envía mensaje vía adaptador canal ni luego descarta texto plano.

```
PATCH /api/conversations/:id
```

**Permiso:** `conversations:update` o voluntario asignado

**Cuerpo:**

```json
{ "status": "closed", "assignedTo": "hex64" }
```

```
POST /api/conversations/:id/claim
```

**Permiso:** `conversations:claim` + específico canal (ej., `conversations:claim-sms`)

Ámbito hub: `/api/hubs/:hubId/conversations/*`

---

## Reportes

Reportes son tipo especial conversación nuu `metadata.type = "report"`.

```
GET /api/reports?status=&category=&page=1&limit=50
```

**Permiso:** `reports:read-all`, `reports:read-assigned`, o `reports:read-own`

```
POST /api/reports
```

**Permiso:** `reports:create`

**Cuerpo:**

```json
{
  "title": "Report title",
  "category": "safety",
  "encryptedContent": "hex",
  "readerEnvelopes": [{ "pubkey": "hex64", "wrappedKey": "hex", "ephemeralPubkey": "hex" }]
}
```

```
GET /api/reports/:id
```

**Permiso:** `reports:read-all`, `reports:read-assigned`, o reporte propio

```
GET /api/reports/:id/messages?page=1&limit=100
```

**Auth:** Requerido (acceso verificado)

```
POST /api/reports/:id/messages
```

**Permiso:** `reports:send-message`, `reports:send-message-own`, o asignado

**Cuerpo:**

```json
{
  "encryptedContent": "hex",
  "readerEnvelopes": [],
  "attachmentIds": ["uuid"]
}
```

```
POST /api/reports/:id/assign
```

**Permiso:** `reports:assign`

**Cuerpo:**

```json
{ "assignedTo": "hex64" }
```

```
PATCH /api/reports/:id
```

**Permiso:** `reports:update`

```
GET /api/reports/categories
```

**Auth:** Requerido

```
GET /api/reports/:id/files
```

**Auth:** Requerido (acceso verificado)

Ámbito hub: `/api/hubs/:hubId/reports/*`

---

## Bloqueos

```
POST /api/bans
```

**Permiso:** `bans:report`

**Cuerpo:**

```json
{ "phone": "+1234567890", "reason": "Spam caller" }
```

```
GET /api/bans
```

**Permiso:** `bans:read`

```
POST /api/bans/bulk
```

**Permiso:** `bans:bulk-create`

**Cuerpo:**

```json
{ "phones": ["+1234567890", "+0987654321"], "reason": "Imported ban list" }
```

```
DELETE /api/bans/:phone
```

**Permiso:** `bans:delete`

Parámetro `:phone` es E.164 codificado URL (ej., `%2B12125551234`).

Ámbito hub: `/api/hubs/:hubId/bans/*`

---

## Configuración

### Proveedor telefonía

```
GET /api/settings/telephony-provider
```

**Permiso:** `settings:manage-telephony`

```
PATCH /api/settings/telephony-provider
```

**Permiso:** `settings:manage-telephony`

**Cuerpo:** `TelephonyProviderConfig` (tipo proveedor + credenciales)

```
POST /api/settings/telephony-provider/test
```

**Permiso:** `settings:manage-telephony`

Prueba credenciales proveedor sin guardar.

### Mensajería

```
GET /api/settings/messaging
```

**Permiso:** `settings:manage-messaging`

```
PATCH /api/settings/messaging
```

**Permiso:** `settings:manage-messaging`

### Mitigación spam

```
GET /api/settings/spam
```

**Permiso:** `settings:manage-spam`

```
PATCH /api/settings/spam
```

**Permiso:** `settings:manage-spam`

### Configuración llamadas

```
GET /api/settings/call
```

**Permiso:** `settings:manage`

```
PATCH /api/settings/call
```

**Permiso:** `settings:manage`

### Idiomas IVR

```
GET /api/settings/ivr-languages
```

**Permiso:** `settings:manage-ivr`

```
PATCH /api/settings/ivr-languages
```

**Permiso:** `settings:manage-ivr`

**Cuerpo:**

```json
{ "enabledLanguages": ["en", "es", "zh"] }
```

### Audio IVR

```
GET /api/settings/ivr-audio
```

**Permiso:** `settings:manage-ivr`

```
PUT /api/settings/ivr-audio/:promptType/:language
```

**Permiso:** `settings:manage-ivr`
**Content-Type:** `application/octet-stream` (bytes audio raw)

```
DELETE /api/settings/ivr-audio/:promptType/:language
```

**Permiso:** `settings:manage-ivr`

### Transcripción

```
GET /api/settings/transcription
```

**Auth:** Requerido (cualquier rol)

**Respuesta:**

```json
{ "globalEnabled": true, "allowVolunteerOptOut": false }
```

```
PATCH /api/settings/transcription
```

**Permiso:** `settings:manage-transcription`

### Campos personalizados

```
GET /api/settings/custom-fields
```

**Auth:** Requerido (devuelve campos filtrados por rol)

```
PUT /api/settings/custom-fields
```

**Permiso:** `settings:manage-fields`

**Cuerpo:**

```json
{ "fields": [{ "id": "uuid", "name": "severity", "label": "Severity Rating", "type": "select", "required": true, "options": ["low", "medium", "high"], "visibleToVolunteers": true, "editableByVolunteers": true, "context": "call-notes", "order": 0 }] }
```

### Configuración WebAuthn

```
GET /api/settings/webauthn
```

**Permiso:** `settings:manage`

```
PATCH /api/settings/webauthn
```

**Permiso:** `settings:manage`

**Cuerpo:**

```json
{ "requireForAdmins": true, "requireForVolunteers": false }
```

### Roles (PBAC)

```
GET /api/settings/roles
```

**Auth:** Requerido

```
POST /api/settings/roles
```

**Permiso:** `system:manage-roles`

**Cuerpo:**

```json
{
  "name": "Supervisor",
  "slug": "supervisor",
  "permissions": ["notes:read-all", "calls:read-history"],
  "description": "Can read all notes and call history"
}
```

```
PATCH /api/settings/roles/:id
```

**Permiso:** `system:manage-roles`

```
DELETE /api/settings/roles/:id
```

**Permiso:** `system:manage-roles`

### Catálogo permisos

```
GET /api/settings/permissions
```

**Permiso:** `system:manage-roles`

Devuelve todos permisos disponibles organizados por dominio.

### Estado configuración

```
GET /api/settings/setup
```

**Permiso:** `settings:manage`

```
PATCH /api/settings/setup
```

**Permiso:** `settings:manage`

---

## Archivos

### Flujo subida

Subida por chunks nuu archivos adjuntos cifrados.

```
POST /api/uploads/init
```

**Permiso:** `files:upload`

**Cuerpo:**

```json
{
  "totalSize": 1048576,
  "totalChunks": 4,
  "conversationId": "uuid",
  "recipientEnvelopes": [],
  "encryptedMetadata": [{ "pubkey": "hex64", "encryptedContent": "hex", "ephemeralPubkey": "hex" }]
}
```

**Respuesta:**

```json
{ "uploadId": "uuid", "totalChunks": 4 }
```

```
PUT /api/uploads/:id/chunks/:chunkIndex
```

**Permiso:** `files:upload`
**Content-Type:** `application/octet-stream` (bytes chunk cifrado raw)

**Respuesta:**

```json
{ "chunkIndex": 0, "completedChunks": 1, "totalChunks": 4 }
```

```
POST /api/uploads/:id/complete
```

**Permiso:** `files:upload`

**Respuesta:**

```json
{ "fileId": "uuid", "status": "complete" }
```

Devuelve `400` si no todos chunks han sido subidos.

```
GET /api/uploads/:id/status
```

**Permiso:** `files:upload`

### Descarga

```
GET /api/files/:id/content
```

**Permiso:** `files:download-own` (si destinatario) o `files:download-all`

**Respuesta:** `application/octet-stream` (bytes archivo cifrado)

```
GET /api/files/:id/envelopes
```

**Permiso:** `files:download-own` o `files:download-all`

Usuarios no-ña'a reciben solo su propio sobre.

```
GET /api/files/:id/metadata
```

**Permiso:** `files:download-own` o `files:download-all`

```
POST /api/files/:id/share
```

**Permiso:** `files:share`

Re-cifra clave archivo nuu nuevo destinatario.

---

## Blasts (difusión mensajes)

### Suscriptores

```
GET /api/blasts/subscribers?page=&limit=&tag=&status=
```

**Auth:** Requerido

```
DELETE /api/blasts/subscribers/:id
```

**Auth:** Requerido

```
GET /api/blasts/subscribers/stats
```

**Auth:** Requerido

```
POST /api/blasts/subscribers/import
```

**Auth:** Requerido

**Cuerpo:**

```json
{ "subscribers": [{ "phone": "+1234567890", "tags": ["alerts"] }] }
```

### Blasts

```
GET /api/blasts
```

**Auth:** Requerido

```
POST /api/blasts
```

**Auth:** Requerido

**Cuerpo:**

```json
{
  "name": "Emergency alert",
  "content": { "sms": "Alert text", "whatsapp": "Alert text" },
  "targetChannels": ["sms", "whatsapp"],
  "targetTags": ["alerts"],
  "targetLanguages": ["en", "es"]
}
```

```
GET /api/blasts/:id
```

**Auth:** Requerido

```
PATCH /api/blasts/:id
```

**Auth:** Requerido

```
DELETE /api/blasts/:id
```

**Auth:** Requerido

```
POST /api/blasts/:id/send
```

**Auth:** Requerido. Envía blast inmediatamente.

```
POST /api/blasts/:id/schedule
```

**Auth:** Requerido

**Cuerpo:**

```json
{ "scheduledAt": "2026-03-01T12:00:00Z" }
```

```
POST /api/blasts/:id/cancel
```

**Auth:** Requerido. Cancela blast programado.

### Configuración blast

```
GET /api/blasts/settings
```

**Auth:** Requerido

```
PATCH /api/blasts/settings
```

**Auth:** Requerido

Ámbito hub: `/api/hubs/:hubId/blasts/*`

---

## Hubs

Gestión hub multi-tenant.

```
GET /api/hubs
```

**Auth:** Requerido (filtrado por membresía; super ña'a ve todos)

```
POST /api/hubs
```

**Permiso:** `system:manage-hubs`

**Cuerpo:**

```json
{ "name": "NYC Hub", "slug": "nyc", "description": "New York City operations", "phoneNumber": "+1234567890" }
```

```
GET /api/hubs/:hubId
```

**Auth:** Requerido (membresía verificada)

```
PATCH /api/hubs/:hubId
```

**Permiso:** `system:manage-hubs`

### Miembros hub

```
POST /api/hubs/:hubId/members
```

**Permiso:** `volunteers:manage-roles`

**Cuerpo:**

```json
{ "pubkey": "hex64", "roleIds": ["role-volunteer"] }
```

```
DELETE /api/hubs/:hubId/members/:pubkey
```

**Permiso:** `volunteers:manage-roles`

### Gestión clave hub

```
GET /api/hubs/:hubId/key
```

**Auth:** Requerido (miembro hub). Devuelve solo sobre clave hub envuelto ECIES usuario solicitante.

```
PUT /api/hubs/:hubId/key
```

**Permiso:** `system:manage-hubs`

**Cuerpo:**

```json
{ "envelopes": [{ "pubkey": "hex64", "wrappedKey": "hex", "ephemeralPubkey": "hex" }] }
```

---

## Asistente configuración

```
GET /api/setup/state
```

**Auth:** Requerido

```
PATCH /api/setup/state
```

**Permiso:** `settings:manage`

```
POST /api/setup/complete
```

**Permiso:** `settings:manage`

**Cuerpo:**

```json
{}
```

También crea hub por defecto si ninguno existe.

### Pruebas canal

```
POST /api/setup/test/signal
```

**Permiso:** `settings:manage-messaging`

**Cuerpo:**

```json
{ "bridgeUrl": "http://signal-cli:8080", "bridgeApiKey": "secret" }
```

```
POST /api/setup/test/whatsapp
```

**Permiso:** `settings:manage-messaging`

**Cuerpo:**

```json
{ "phoneNumberId": "123456", "accessToken": "EAAx..." }
```

---

## Log auditoría

```
GET /api/audit?page=1&limit=50&actorPubkey=&eventType=&dateFrom=&dateTo=&search=
```

**Permiso:** `audit:read`

**Respuesta:**

```json
{
  "entries": [{
    "id": "uuid",
    "event": "note.created",
    "actorPubkey": "hex64",
    "details": {},
    "createdAt": "2026-01-01T00:00:00Z",
    "previousEntryHash": "hex64",
    "entryHash": "hex64"
  }],
  "total": 100
}
```

Log auditoría usa cadena hash SHA-256 (`previousEntryHash` + `entryHash`) nuu detección manipulación.

Ámbito hub: `/api/hubs/:hubId/audit/*`

---

## WebRTC

```
GET /api/telephony/webrtc-token
```

**Auth:** Requerido

Devuelve token WebRTC específico proveedor nuu respuesta llamada nuu navegador.

**Respuesta:**

```json
{ "token": "string", "provider": "twilio", "identity": "hex64" }
```

Devuelve `400` si preferencia llamada está establecida solo teléfono.

```
GET /api/telephony/webrtc-status
```

**Auth:** Requerido

**Respuesta:**

```json
{ "available": true, "provider": "twilio" }
```

---

## Aprovisionamiento dispositivo

Nuu vincular nuevos dispositivos a cuenta existente vía intercambio clave ECDH efímero.

```
POST /api/provision/rooms
```

**Auth:** Ninguna (nuevo dispositivo no tiene auth)

**Cuerpo:**

```json
{ "ephemeralPubkey": "hex66" }
```

**Respuesta:**

```json
{ "roomId": "uuid", "token": "random_string" }
```

```
GET /api/provision/rooms/:id?token=<token>
```

**Auth:** Ninguna

**Respuesta:**

```json
{
  "status": "waiting",
  "encryptedNsec": "hex",
  "primaryPubkey": "hex64",
  "ephemeralPubkey": "hex66"
}
```

Transiciones estado: `waiting` -> `ready` -> consumed. Salas expiran después ~5 minutos.

```
POST /api/provision/rooms/:id/payload
```

**Auth:** Requerido (dispositivo primario debe estar autenticado)

**Cuerpo:**

```json
{
  "token": "string",
  "encryptedNsec": "hex",
  "primaryPubkey": "hex64"
}
```

---

## Notificaciones push (móvil)

```
POST /api/devices/register
```

**Auth:** Requerido

**Cuerpo:**

```json
{
  "platform": "ios",
  "pushToken": "apns_device_token",
  "voipToken": "ios_voip_push_token",
  "wakeKeyEnvelope": { "wrappedKey": "hex", "ephemeralPubkey": "hex" }
}
```

**Respuesta:**

```json
{ "deviceId": "uuid" }
```

Notificaciones push usan esquema cifrado dos niveles: clave wake (no requiere PIN) nuu metadatos notificación, ni clave identidad (requiere PIN) nuu contenido sensible.

---

## Webhooks telefonía

Estos endpoints son llamados por proveedores telefonía, no por clientes. Cada solicitud es validada por firma webhook proveedor.

```
POST /api/telephony/incoming
POST /api/telephony/language-selected
POST /api/telephony/captcha
POST /api/telephony/volunteer-answer
POST /api/telephony/call-status
POST /api/telephony/wait-music          (también GET)
POST /api/telephony/queue-exit
POST /api/telephony/voicemail-complete
POST /api/telephony/call-recording
POST /api/telephony/voicemail-recording
```

Enrutamiento hub es vía parámetro consulta `?hub=<hubId>`.

---

## Webhooks mensajería

Llamados por proveedores mensajería. Cada adaptador valida su propia firma webhook.

```
GET  /api/messaging/whatsapp/webhook    (verificación webhook Meta)
GET  /api/messaging/rcs/webhook         (verificación webhook Google RBM)
POST /api/messaging/:channel/webhook?hub=<hubId>
```

Canales soportados: `sms`, `whatsapp`, `signal`, `rcs`.

---

## Rutas ámbito hub

Todas rutas siguientes también disponibles nuu prefijo `/api/hubs/:hubId/`, ke las ámbita a hub específico:

- `/api/hubs/:hubId/shifts/*`
- `/api/hubs/:hubId/bans/*`
- `/api/hubs/:hubId/notes/*`
- `/api/hubs/:hubId/calls/*`
- `/api/hubs/:hubId/audit/*`
- `/api/hubs/:hubId/conversations/*`
- `/api/hubs/:hubId/reports/*`
- `/api/hubs/:hubId/blasts/*`

Al usar rutas ámbito hub, middleware `hubContext` resuelve permisos específicos hub nuu usuario.

---

## Respuestas error

Todas respuestas error siguen formato:

```json
{ "error": "Mensaje error legible humano" }
```

Códigos estado HTTP comunes:

| Código | Significado |
|------|---------|
| `400` | Solicitud incorrecta (cuerpo malformado, campos faltantes, falla validación) |
| `401` | No autorizado (token auth faltante o inválido) |
| `403` | Prohibido (auth válida pero permisos insuficientes) |
| `404` | No encontrado |
| `409` | Conflicto (ej., llamada ya respondida, recurso ya existe) |
| `429` | Demasiadas solicitudes (rate limit) |
| `500` | Error interno servidor |

---

## Referencia permisos

Permisos siguen formato `dominio:accion`. Usuarios se asignan roles, ni cada rol agrupa conjunto permisos. Permisos efectivos son unión todos roles asignados.

Comodín `*` otorga todos permisos. Comodín dominio `dominio:*` otorga todas acciones nuu ese dominio.

| Dominio | Permisos |
|--------|-------------|
| **calls** | `answer`, `read-active`, `read-active-full`, `read-history`, `read-presence`, `read-recording`, `debug` |
| **notes** | `create`, `read-own`, `read-all`, `read-assigned`, `update-own` |
| **reports** | `create`, `read-own`, `read-all`, `read-assigned`, `assign`, `update`, `send-message-own`, `send-message` |
| **conversations** | `read-assigned`, `read-all`, `claim`, `claim-sms`, `claim-whatsapp`, `claim-signal`, `claim-rcs`, `claim-web`, `claim-any`, `send`, `send-any`, `update` |
| **volunteers** | `read`, `create`, `update`, `delete`, `manage-roles` |
| **shifts** | `read-own`, `read`, `create`, `update`, `delete`, `manage-fallback` |
| **bans** | `report`, `read`, `create`, `bulk-create`, `delete` |
| **invites** | `read`, `create`, `revoke` |
| **settings** | `read`, `manage`, `manage-telephony`, `manage-messaging`, `manage-spam`, `manage-ivr`, `manage-fields`, `manage-transcription` |
| **audit** | `read` |
| **blasts** | `read`, `send`, `manage`, `schedule` |
| **files** | `upload`, `download-own`, `download-all`, `share` |
| **system** | `manage-roles`, `manage-hubs`, `manage-instance` |

### Roles por defecto

| Rol | Slug | Permisos clave |
|------|------|-----------------|
| **Super Admin** | `role-super-admin` | `*` (todos permisos) |
| **Hub Admin** | `role-hub-admin` | `volunteers:*`, `shifts:*`, `settings:*`, `audit:read`, `bans:*`, `invites:*`, `notes:read-all`, `reports:*`, `conversations:*`, `calls:*`, `blasts:*`, `files:*` |
| **Reviewer** | `role-reviewer` | `notes:read-assigned`, `reports:read-assigned`, `reports:assign`, `reports:update`, `conversations:read-assigned`, `conversations:send`, `files:download-own`, `files:upload` |
| **Volunteer** | `role-volunteer` | `calls:answer`, `calls:read-active`, `notes:create`, `notes:read-own`, `notes:update-own`, `conversations:claim`, `conversations:send`, `conversations:read-assigned`, `bans:report`, `files:upload`, `files:download-own` |
| **Reporter** | `role-reporter` | `reports:create`, `reports:read-own`, `reports:send-message-own`, `files:upload`, `files:download-own` |

---

## Endpoints desarrollo / prueba

Disponibles solo nuu ambientes desarrollo.

```
POST /api/test-reset            (reset completo, requiere encabezado X-Test-Secret)
POST /api/test-reset-no-admin   (reset sin ña'a)
POST /api/test-reset-records    (reset ligero, preserva identidad/configuración)
```
