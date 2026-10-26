/**
 * In-call note drafts, held in memory only.
 *
 * The active-call panel unmounts when the key locks, taking its textarea state
 * with it; the draft lives here so it survives the lock and is restored on
 * unlock, keyed by call id (a call belongs to one hub, and ids are unique).
 *
 * Deliberately NOT persisted — no localStorage, Stronghold or disk. A note
 * draft is plaintext about a caller; writing it out would turn a UX fix into a
 * data-at-rest problem. Cleared by logout and by every wipe (`wipeKey`, which
 * both panic wipe and remote device wipe go through).
 */

const drafts = new Map<string, string>()

export function getCallNoteDraft(callId: string): string {
  return drafts.get(callId) ?? ''
}

/** An empty draft is no draft: nothing is retained for a cleared textarea. */
export function setCallNoteDraft(callId: string, text: string): void {
  if (text) drafts.set(callId, text)
  else drafts.delete(callId)
}

export function clearCallNoteDrafts(): void {
  drafts.clear()
}
