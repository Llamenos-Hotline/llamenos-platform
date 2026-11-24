# Llamenos Interoperability Protocol Specification

**Version:** 1.2.0
**Status:** Canonical reference for all client implementations
**Audience:** Desktop (Tauri), Mobile (Native Swift/Kotlin), and any third-party client implementors

This document is the definitive wire-format specification for interoperating with the Llamenos server. Every byte layout, algorithm, and endpoint is described with sufficient precision to build a conforming client from scratch. All cryptographic constants, key derivation functions, and wire formats are derived directly from the source-of-truth implementation.

---

## Document set

This specification is split into one file per domain so that two unrelated protocol changes do not edit the same file. **Section numbers are stable identifiers.** Code, tests and documents cite the spec as `PROTOCOL.md §2.7`; the table below is how a section number is resolved to the file that holds it. Section headings keep their original numbers inside the domain files, so a section can be found by searching for `### 2.7 `.

Rules for changing it:

- A change to one domain edits that domain's file only. This index is edited only when a new file is added or a file's section range changes.
- Add a new section to the file whose domain it belongs to. Add a new file (and a row here) for a new domain.
- Do not renumber sections: the numbers are cited from outside this directory.

Every file below is part of the normative specification.

| Sections | File | Contents |
|---|---|---|
| 1 | [authentication.md](authentication.md) | Signature auth, session tokens, WebAuthn |
| 2, 2.1–2.2.1 | [crypto/labels-and-envelopes.md](crypto/labels-and-envelopes.md) | Domain-separation constants, HPKE envelopes, legacy ECIES wrapping |
| 2.3–2.4 | [crypto/notes-and-messages.md](crypto/notes-and-messages.md) | Per-note and per-message encryption |
| 2.4.1–2.4.2 | [crypto/reader-sets-and-rewrap.md](crypto/reader-sets-and-rewrap.md) | Client-mediated assignee re-wrap, hub reader sets |
| 2.5–2.6 | [crypto/call-records-and-key-storage.md](crypto/call-records-and-key-storage.md) | Call record metadata, PIN-encrypted key storage |
| 2.7–2.9 | [crypto/hub-keys-and-ws-encryption.md](crypto/hub-keys-and-ws-encryption.md) | Hub key management and rotation, WebSocket event encryption, server keypair |
| 2.10–2.12 | [crypto/hmac-and-device-keys.md](crypto/hmac-and-device-keys.md) | HMAC operations, per-device key storage, audit log hash chain |
| 2.13–2.17 | [crypto/transcripts-drafts-exports-uploads.md](crypto/transcripts-drafts-exports-uploads.md) | Legacy V1 note decryption, transcription, drafts, exports, encrypted file uploads |
| 2.18–2.19 | [crypto/case-records-and-availability.md](crypto/case-records-and-availability.md) | Case record and comment encryption, availability reasons and shift override notes |
| 3 | [websocket.md](websocket.md) | Relay event schema |
| 4 | [rest/overview.md](rest/overview.md) | Base path and conventions for every REST endpoint |
| 4.1–4.4 | [rest/public-and-authentication.md](rest/public-and-authentication.md) | Public endpoints, auth, WebAuthn, invites |
| 4.5–4.6 | [rest/users-and-shifts.md](rest/users-and-shifts.md) | Users, shifts |
| 4.7–4.8 | [rest/notes-and-calls.md](rest/notes-and-calls.md) | Notes, calls |
| 4.9–4.11 | [rest/conversations-reports-bans.md](rest/conversations-reports-bans.md) | Conversations, reports, bans |
| 4.12 | [rest/settings.md](rest/settings.md) | Hub and platform settings |
| 4.13–4.14 | [rest/files-and-blasts.md](rest/files-and-blasts.md) | File uploads, message broadcasting |
| 4.15–4.17 | [rest/hubs-setup-and-audit.md](rest/hubs-setup-and-audit.md) | Hubs, setup wizard, audit log |
| 4.18–4.23 | [rest/webrtc-provisioning-webhooks-health.md](rest/webrtc-provisioning-webhooks-health.md) | WebRTC, device provisioning, telephony and messaging webhooks, dev/test, health probes |
| 4.24–4.28 | [rest/devices-sessions-account.md](rest/devices-sessions-account.md) | Devices, sessions, security events, account, admin devices |
| 4.29–4.30 | [rest/contacts.md](rest/contacts.md) | Legacy contacts, contact directory v2 |
| 4.31–4.33 | [rest/records-events-evidence.md](rest/records-events-evidence.md) | Case records, deprecated events, evidence |
| 4.34–4.36 | [rest/system-geocoding-analytics.md](rest/system-geocoding-analytics.md) | System health, geocoding, analytics |
| 4.37–4.39 | [rest/sigchain-puk-mls.md](rest/sigchain-puk-mls.md) | Sigchain, per-user key, MLS |
| 4.40–4.42 | [rest/signal-and-firehose.md](rest/signal-and-firehose.md) | Signal admin, firehose, Signal notifications |
| 4.43–4.44 | [rest/provider-setup.md](rest/provider-setup.md) | Provider setup, provider templates |
| 4.45–4.48 | [rest/erasure-retention-platform.md](rest/erasure-retention-platform.md) | Erasure, retention, platform bans, platform settings |
| 4.49–4.52 | [rest/ring-groups-recovery-teams-tags.md](rest/ring-groups-recovery-teams-tags.md) | Ring groups, recovery group, teams, tags |
| 4.53–4.55 | [rest/entity-schema-onboarding-hub-routes.md](rest/entity-schema-onboarding-hub-routes.md) | Case-management entity schema, hub onboarding, hub-scoped routes |
| 4.24 | [rest/supplement-summary-and-contacts-v2.md](rest/supplement-summary-and-contacts-v2.md) | Second numbering block, part 1: additional-endpoints summary, contacts v2 |
| 4.25–4.32 | [rest/supplement-records-schema-identity.md](rest/supplement-records-schema-identity.md) | Second numbering block, part 2 |
| 4.33–4.39 | [rest/supplement-erasure-and-platform.md](rest/supplement-erasure-and-platform.md) | Second numbering block, part 3 |
| 5 | [push.md](push.md) | Device registration, two-tier encryption, payload format, VoIP push, hub routing |
| 6, 6.1–6.3 | [device-linking/flow.md](device-linking/flow.md) | Roles, primitives, protocol flow, interim seed-transport linking |
| 6.4–6.14 | [device-linking/formats-and-verification.md](device-linking/formats-and-verification.md) | QR and short-code formats, SAS ceremony, payloads, failure modes, test vectors, conformance matrix |
| 7 | [permissions.md](permissions.md) | Permission format, resolution, catalog, default roles, hub scoping, channel claims |
| Appendix A–C | [appendices.md](appendices.md) | Appendix A library dependencies, B type definitions, C legacy encryption |

### Numbering in §4 (REST)

§4 holds two blocks of sections. The main block is §4.1–§4.55. The three `supplement-*` files hold a second block that re-uses the numbers §4.24–§4.39 for different endpoint groups (for example §4.30 is both *Contact Directory (v2)* and *Teams*). The numbers are kept exactly as the specification was written, so a bare `§4.30` is ambiguous between the two blocks; cite the endpoint group name as well.

### Superseded document

[llamenos-protocol.md](llamenos-protocol.md) is the deprecated v1 cryptographic specification, kept as historical reference only. It is not part of this document set.
