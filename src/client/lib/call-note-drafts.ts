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
 *
 * This is the ONE store for "the note the volunteer is partway through writing" about
 * a call: the in-call textarea, and — after the call ends — the note editor opened
 * from the "Call Ended" prompt, read and write the same entry.
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

/** Drop every draft, except the one for `keepCallId` (the ended call still awaiting its note). */
export function clearCallNoteDrafts(keepCallId?: string): void {
  for (const callId of [...drafts.keys()]) {
    if (callId !== keepCallId) drafts.delete(callId)
  }
}
