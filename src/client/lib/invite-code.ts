/**
 * Invite codes are `crypto.randomUUID()` (`createInvite` in
 * apps/worker/services/identity.ts): 36 characters, lowercase hex and hyphens.
 * A volunteer receives one over Signal and pastes it in, and the round trip
 * through a message and the clipboard adds whitespace, line breaks and
 * zero-width characters — or an auto-capitalised first letter. None of those
 * can appear in a real code, so they are removed rather than reported as an
 * "invalid code".
 */

/** Whitespace (including line breaks) and the zero-width characters messengers insert. */
const NOISE = /[\s\u200B-\u200D\u2060\uFEFF]/g

const INVITE_CODE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Length of a well-formed invite code, for sizing the entry field. */
export const INVITE_CODE_LENGTH = 36

/**
 * The canonical (lowercase, noise-free) invite code in `raw`, or `null` when
 * what remains is not shaped like one — so a malformed paste is caught locally
 * and never sent to the server.
 */
export function normalizeInviteCode(raw: string): string | null {
  const code = raw.replace(NOISE, '').toLowerCase()
  return INVITE_CODE.test(code) ? code : null
}
