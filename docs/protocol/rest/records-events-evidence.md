# Llamenos Protocol: REST API: records, events and evidence

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 4.31 Records

Case/entity record management (replaces legacy event system).

Hub-only: records exist only inside a hub. There is no unscoped `/api/records`; the router answers `404` to any request outside `/hubs/:hubId` (#2461). The paths below are written unscoped for brevity and are served under `/api/hubs/:hubId/...`. A record is created in the path hub, its envelope recipients are that hub's members (plus super-admins), and every change to it is audited in that hub's chain.

```
GET    /api/records
Permission: cases:read-own | cases:read-assigned | cases:read-all
Query: ?page=&limit=&entityTypeId=&parentRecordId=&assignedTo=&crossHub=&blindIndexToken=&blindIndexField=
Response: { "records": Record[], "total": number }

GET    /api/records/by-number/:number
Permission: cases:read-* (access-checked)
Response: Record

GET    /api/records/envelope-recipients
Permission: cases:read-*
Query: ?entityTypeId=&assignedTo=
Response: EnvelopeRecipientsResponse

GET    /api/records/by-contact/:contactId
Permission: cases:read-*
Response: { "records": Record[] }

GET    /api/records/interactions/by-source/:sourceId
Permission: cases:read-*
Response: { "linkedRecordId": string | null, "linkedRecordNumber": string | null }

POST   /api/records/convert-from-report
Permission: reports:triage
Body: { "reportId": string, "entityTypeId": string }
Response: { "recordId": string, "caseNumber"?: string, "autoAssigned": boolean, "assignedTo": string[] } (201)

GET    /api/records/:id
Permission: cases:read-* (access-checked)
Response: Record

GET    /api/records/:id/envelope-recipients
Permission: cases:read-*
Response: EnvelopeRecipientsResponse

POST   /api/records
Permission: cases:create
Body: CreateRecordBody
Response: Record (201)

PATCH  /api/records/:id
Permission: cases:update | cases:update-own
Body: UpdateRecordBody
Response: Record

DELETE /api/records/:id
Permission: cases:delete
Response: { "ok": true }

POST   /api/records/:id/contacts
Permission: cases:link
Body: { "contactId": string, "role": string }
Response: RecordContact (201)

DELETE /api/records/:id/contacts/:contactId
Permission: cases:link
Response: { "ok": true }

GET    /api/records/:id/contacts
Permission: cases:read-*
Response: { "contacts": RecordContact[] }

GET    /api/records/:id/suggest-assignees
Permission: cases:assign
Response: { "suggestions": AssigneeSuggestion[] }

POST   /api/records/:id/assign
Permission: cases:assign
Body: { "pubkeys": string[] }
Response: Record

POST   /api/records/:id/unassign
Permission: cases:assign
Body: { "pubkey": string }
Response: Record

GET    /api/records/:id/interactions
Permission: cases:read-*
Query: ?page=&limit=&interactionTypeHash=&after=&before=
Response: { "interactions": CaseInteraction[], "total": number }

POST   /api/records/:id/interactions
Permission: cases:update | cases:update-own
Body: CreateInteractionBody
Response: CaseInteraction (201)

DELETE /api/records/:id/interactions/:interactionId
Permission: cases:update
Response: { "ok": true }

POST   /api/records/:id/reports
Permission: cases:link
Body: { "reportId": string }
Response: ReportCaseLink (201)

DELETE /api/records/:id/reports/:reportId
Permission: cases:link
Response: { "ok": true }

GET    /api/records/:id/reports
Permission: cases:read-*
Response: { "links": ReportCaseLink[] }

POST   /api/records/:id/notify-contacts
Permission: cases:update
Body: { "recipients": [{ "identifier": string, "channel": string, "message": string }] }
Response: { "recordId": string, "notified": number, "skipped": number, "results": NotificationResultItem[] }

POST   /api/records/merge
Permission: cases:update
Body: { "primaryId": string, "secondaryId": string }
Response: { "primaryId": string, "secondaryId": string, "mergedContacts": number }
```

Hub-scoped: `/api/hubs/:hubId/records/*`

### 4.32 Events (Deprecated)

> **Deprecation Notice:** The `/events` group is deprecated (Sunset: 2026-07-01). Successor: `/records` with `category:"event"` entity types. All responses include `Deprecation: true`, `Sunset: 2026-07-01`, and `Link: </api/hubs/:hubId/records?category=event>; rel="successor-version"` headers. Events are hub-only: there is no unscoped `/api/events` (#2461).

Events are now configurable entity types with `category:"event"`. Use the Records API (Section 4.31) with an `entityTypeId` corresponding to an event entity type — dates, locations, and all other event fields are stored as encrypted record content.

The deprecated `/api/hubs/:hubId/events` endpoints remain available through the sunset date and return the sunset response headers listed above, but no new features will be added. Implementors encountering references to `/api/events` should migrate to Section 4.31 Records.

### 4.33 Evidence

Evidence metadata and chain of custody. Mounted under `/records/:id/evidence` and `/evidence/:id`.

Hub-only: evidence items exist only inside a hub. There is no unscoped `/api/evidence`; the router answers `404` to any request outside `/hubs/:hubId` (#2461). The paths below are written unscoped for brevity and are served under `/api/hubs/:hubId/...`. Evidence is reachable only through the hub of the record it belongs to.

```
POST   /api/records/:id/evidence
Permission: evidence:upload
Body: { "fileId": string, "filename": string, "mimeType": string, "sizeBytes": number, "classification": string, "integrityHash": hex, "source": string, "sourceDescription"?: string, "encryptedDescription"?: hex, "descriptionEnvelopes"?: Envelope[], "interactionTypeHash"?: string }
Response: EvidenceMetadata (201)

GET    /api/records/:id/evidence
Permission: evidence:download | evidence:upload | evidence:manage-custody
Query: ?page=&limit=&classification=
Response: { "evidence": EvidenceMetadata[], "total": number }

GET    /api/evidence/:evidenceId
Permission: evidence:download | evidence:manage-custody
Response: EvidenceMetadata

GET    /api/evidence/:evidenceId/custody
Permission: evidence:manage-custody
Response: { "entries": CustodyEntry[] }

POST   /api/evidence/:evidenceId/access
Permission: evidence:download
Body: { "action": "view"|"download"|"share", "integrityHash"?: hex, "notes"?: string }
Response: CustodyEntry (201)

POST   /api/evidence/:evidenceId/verify
Permission: evidence:download
Body: { "currentHash": hex }
Response: { "valid": boolean, "storedHash": hex, "currentHash": hex }
```

Hub-scoped: `/api/hubs/:hubId/records/:id/evidence/*`

