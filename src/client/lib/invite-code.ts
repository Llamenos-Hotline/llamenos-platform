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

/** Path of the redemption screen an invite link points at. */
const INVITE_PATH = '/onboarding'

/** The app's deep-link scheme and invite host (apps/desktop/src/deep_link.rs). */
const DEEP_LINK_SCHEME = 'llamenos'
const DEEP_LINK_INVITE_HOST = 'hub-invite'

/** An invite read out of whatever the volunteer pasted. */
export interface ParsedInvite {
  /** The canonical invite code. */
  code: string
  /** The hub the link names (its http(s) origin), when the paste was an invite link. */
  hubOrigin: string | null
}

/**
 * The invite in `raw`: a bare code, an invite link (`https://<hub>/onboarding?code=<uuid>`,
 * what the admin copies — see `buildInviteLink`), or a `llamenos://hub-invite?code=` deep
 * link. The same three shapes iOS accepts (`InviteCodeParser`,
 * apps/ios/Sources/Services/InviteEnrollmentService.swift). `null` for anything else.
 *
 * A link's hub is reported, never acted on: the code is a bearer token, and only the
 * volunteer chooses which server it is sent to.
 */
export function parseInvite(raw: string): ParsedInvite | null {
  const bare = normalizeInviteCode(raw)
  if (bare) return { code: bare, hubOrigin: null }

  let url: URL
  try {
    url = new URL(raw.replace(NOISE, ''))
  } catch {
    return null
  }
  if (url.protocol === 'https:' || url.protocol === 'http:') {
    const code = normalizeInviteCode(url.searchParams.get('code') ?? '')
    return code ? { code, hubOrigin: url.origin } : null
  }
  if (url.protocol === `${DEEP_LINK_SCHEME}:` && url.host === DEEP_LINK_INVITE_HOST && (url.pathname === '' || url.pathname === '/')) {
    const code = normalizeInviteCode(url.searchParams.get('code') ?? url.searchParams.get('token') ?? '')
    return code ? { code, hubOrigin: null } : null
  }
  return null
}

/**
 * The invite link an admin hands a volunteer: the hub's own public address, so it
 * names a server the recipient can reach. Pass `getHubOrigin()` (api-config.ts) —
 * never `window.location.origin`, which in a packaged build is the Tauri asset
 * protocol and means nothing on any other machine (#1128).
 */
export function buildInviteLink(code: string, hubOrigin: string): string {
  const url = new URL(INVITE_PATH, hubOrigin)
  url.searchParams.set('code', code)
  return url.toString()
}
