/**
 * The one rule for re-wrapping existing records to a recipient key (#2143,
 * #2148; PROTOCOL.md §2.4.1 "Trust").
 *
 * A record's content key is sealed to the readers known when it was written.
 * Handing it to a key that did not exist yet turns "this device can read what
 * was written for it" into "this key can read the past". So a key set AFTER the
 * record may receive it only once someone has confirmed the key (an SAS
 * verification, `device_verifications`); a key that was already registered when
 * the record was written may receive it freely — that is the normal claim path.
 *
 * The client applies this as the gate (`mayRewrapHistoryTo` in
 * `src/client/lib/assignee-rewrap.ts`); the worker applies the same function
 * again when envelopes are submitted (`ConversationsService.addAssigneeEnvelopes`).
 * That second application is defence in depth, not a boundary: `keySetAt`,
 * `confirmed` and the record's `createdAt` are all asserted by the server, so
 * against a malicious server the rule does nothing. It raises the bar for an
 * attacker who holds only a stolen user session (docs/security/THREAT_MODEL.md).
 */

/** What the gate needs to know about one recipient key. */
export interface RewrapRecipientKey {
  /** When the key took its current value (`devices.x25519_set_at`). */
  keySetAt: string | number | Date
  /** Whether a verification covers this key as it stands now. */
  confirmed: boolean
}

function toMs(value: string | number | Date): number {
  return value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value)
}

/**
 * May a record created at `recordCreatedAt` be re-wrapped to `recipient`?
 *
 * Fails closed: a timestamp that does not parse is treated as "newer than the
 * record", so only a confirmed key passes.
 */
export function mayRewrapHistoryTo(
  recipient: RewrapRecipientKey,
  recordCreatedAt: string | number | Date,
): boolean {
  if (recipient.confirmed) return true
  const keySetAt = toMs(recipient.keySetAt)
  const createdAt = toMs(recordCreatedAt)
  if (Number.isNaN(keySetAt) || Number.isNaN(createdAt)) return false
  return keySetAt <= createdAt
}
