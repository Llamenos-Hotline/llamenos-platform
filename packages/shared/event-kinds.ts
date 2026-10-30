/**
 * Event kind definitions for Llamenos server-published events.
 *
 * Kind ranges:
 *   - Regular events (1000-9999): persisted in ring buffer, replayed on reconnect
 *   - Ephemeral events (20000-29999): not persisted, broadcast only
 *
 * All server-published events are signed with the server Ed25519 keypair
 * (derived from SERVER_SECRET). Clients verify signatures against the
 * server's pubkey (fetched from /api/config).
 */

// --- Regular Events (persisted) ---

/** Incoming call notification — triggers volunteer ringing */
export const KIND_CALL_RING = 1000

/** Call state update — answered, completed, etc. */
export const KIND_CALL_UPDATE = 1001

/** Voicemail received for a call */
export const KIND_CALL_VOICEMAIL = 1002

/** New conversation message (inbound from external channel) */
export const KIND_MESSAGE_NEW = 1010

/** Conversation assignment changed */
export const KIND_CONVERSATION_ASSIGNED = 1011

/** Message reaction (emoji) received or removed */
export const KIND_MESSAGE_REACTION = 1012

/** New case record created */
export const KIND_RECORD_CREATED = 1020

/** Case record updated */
export const KIND_RECORD_UPDATED = 1021

/** Case record assignment changed */
export const KIND_RECORD_ASSIGNED = 1022

/** Caller identified from contact directory during incoming call (Epic 326) */
export const KIND_CONTACT_IDENTIFIED = 1023

/** Blast delivery progress update (sent/delivered/failed counts) */
export const KIND_BLAST_PROGRESS = 1030

/** Blast status changed (sending → sent, scheduled → sending, etc.) */
export const KIND_BLAST_STATUS = 1031

/** Firehose agent extracted a structured report */
export const KIND_FIREHOSE_REPORT = 1032

// --- Ephemeral Events (not persisted, broadcast only) ---

// --- Shift Events (regular, persisted) ---

/** Volunteer clocked in to a shift */
export const KIND_SHIFT_CLOCK_IN = 1040

/** Volunteer clocked out of a shift */
export const KIND_SHIFT_CLOCK_OUT = 1041

/** Shift override created (cancel or substitute) */
export const KIND_SHIFT_OVERRIDE_CREATED = 1042

/** Shift join/leave request received */
export const KIND_SHIFT_REQUEST_RECEIVED = 1043

/** Shift join/leave request reviewed (approved or denied) */
export const KIND_SHIFT_REQUEST_REVIEWED = 1044

// --- Incident Events (regular, persisted) ---

/**
 * A hub incident opened, updated or closed (B-INCIDENTS, #2341). The content
 * is `{ incidentId, state }` and NOTHING else — see hubIncidentRelayEventSchema:
 * the relay fans out to every hub member, so category and counts are only
 * available from the permission-filtered `GET /hubs/:hubId/incidents`.
 */
export const KIND_HUB_INCIDENT = 1050

// --- Ephemeral Events (not persisted, broadcast only) ---

/** Volunteer presence update — online counts, availability */
export const KIND_PRESENCE_UPDATE = 20000

/** Typing indicator from external messaging channel */
export const KIND_TYPING_INDICATOR = 20001

