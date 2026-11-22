/**
 * The admin HPKE recipient keys of a hub, as a type a volunteer's own key
 * cannot impersonate.
 *
 * `apps/worker/lib/hpke-recipient.ts` carries the full explanation; the short
 * version is that an Ed25519 signing key and an X25519 encryption key are both
 * 32 bytes carried as 64 hex characters, and DHKEM(X25519) — the KEM half of
 * the HPKE suite used everywhere here — accepts *any* 32 bytes as a recipient.
 * So substituting one key for another does not throw, does not warn, and does
 * not fail: it writes an envelope that is either unopenable by anyone, or
 * opened by the wrong person.
 *
 * This client had the second shape of that bug (#1468). Five note call sites
 * read:
 *
 *     const adminPub = adminDecryptionPubkey || authorPub
 *
 * When the server supplies no admin decryption key — a hub bootstrapped from
 * the desktop, where no `ADMIN_DECRYPTION_PUBKEY` exists yet — the note was
 * wrapped twice to the author's own key. It saved, it showed as saved, it
 * appeared normally in the author's own history, and **no admin could read it
 * at all**. The product requirement is that admins can read every note; for a
 * crisis hotline the loss surfaces during an escalation or an audit, long
 * after the call.
 *
 * `||` type-checked because both sides are `string`. The brand below is the
 * same remedy #1466 applied on the server: the only way to obtain an
 * `AdminHpkeRecipient` is `adminHpkeRecipient()`, so a bare string — the
 * author's key included — can no longer reach `encryptNote`'s admin
 * parameter. Callers must handle `undefined` by refusing to write, not by
 * substituting.
 *
 * WHO the admins are is the hub's answer, not the deployment's (#1035): the
 * hub's `admin` reader set (`GET /api/hubs/:hubId/readers?purpose=admin`) —
 * the registered device keys of every member holding the admin minimum in that
 * hub, plus its escrow key. `hubAdminReaders()` is the one way hub content is
 * addressed to its admins. The instance-wide `adminDecryptionPubkey` that
 * `/auth/me` still publishes is a single env-configured key: one admin at
 * most, none on a wizard-bootstrapped deployment, and never a reader of hub
 * content (D1). Hub content must not be sealed to it.
 */
import { getActiveHub, getHubReaders, NoActiveHubError } from './api'

declare const adminHpkeRecipientBrand: unique symbol

/** A 64-hex X25519 key belonging to an admin, valid as an HPKE recipient. */
export type AdminHpkeRecipient = string & { readonly [adminHpkeRecipientBrand]: 'x25519-admin' }

const HEX64_RE = /^[0-9a-f]{64}$/

/**
 * Accept the server-supplied admin decryption pubkey as an HPKE recipient, or
 * return `undefined` when the deployment has none.
 *
 * Validation is of the encoding only. No 32-byte string can be recognised as
 * "the X25519 one" by inspection — that is exactly the problem this type
 * exists to solve, and it is solved by controlling where the value comes from.
 */
export function adminHpkeRecipient(hex: string | null | undefined): AdminHpkeRecipient | undefined {
  const trimmed = hex?.trim().toLowerCase()
  if (!trimmed || !HEX64_RE.test(trimmed)) return undefined
  return trimmed as AdminHpkeRecipient
}

/**
 * A hub has nobody who could read what is about to be written: no member
 * holding the admin minimum there has a registered device, and the hub has no
 * escrow key. The server refuses such a write (503); refusing it here keeps the
 * text in the editor and says why.
 */
export class NoAdminReaderError extends Error {
  constructor(readonly hubId: string) {
    super(`Hub ${hubId} has no admin able to read new content`)
    this.name = 'NoAdminReaderError'
  }
}

/**
 * Every admin of `hubId` as an HPKE recipient: the hub's `admin` reader set.
 *
 * Seal hub content to ALL of them, so every admin — the second one included —
 * can read it.
 *
 * `hubId` is required, and it must be the hub of the ROW being written
 * (`record.hubId`, `call.hubId`, `conversation.hubId`) — never the hub being
 * browsed. The active hub controls browsing context only; a record opened from
 * the cross-hub list belongs to another hub, and sealing its content to the
 * browsed hub's admins hands one hub's case content to another hub's admins.
 * That is the defect this signature exists to make unwritable: there is no
 * default to fall back on, so every caller states where its hub came from.
 * For a row that does not exist yet, whose hub is the one the write will land
 * in, use `activeHubAdminReaders()`.
 *
 * Throws `NoAdminReaderError` for an empty set rather than returning `[]`: a
 * record no admin can open cannot be repaired afterwards, and `NoActiveHubError`
 * for a null hub.
 */
export async function hubAdminReaders(hubId: string | null): Promise<AdminHpkeRecipient[]> {
  // A row with no hub (an instance with no hub scope) has no reader set to ask.
  if (!hubId) throw new NoActiveHubError('/readers')
  const { recipients } = await getHubReaders(hubId, 'admin')
  const readers: AdminHpkeRecipient[] = []
  for (const key of recipients) {
    const recipient = adminHpkeRecipient(key)
    if (recipient && !readers.includes(recipient)) readers.push(recipient)
  }
  if (readers.length === 0) throw new NoAdminReaderError(hubId)
  return readers
}

/**
 * The admins of the hub a NEW row is being created in — the hub being browsed,
 * because every create is filed through `activeHubPath` and so lands there.
 *
 * Only for a row that has no hub yet, and for pages that list the active hub's
 * rows alone. Anything that edits, replies to, or attaches to an existing row
 * must call `hubAdminReaders(row.hubId)` instead.
 */
export async function activeHubAdminReaders(): Promise<AdminHpkeRecipient[]> {
  const hub = getActiveHub()
  if (!hub) throw new NoActiveHubError('/readers')
  return hubAdminReaders(hub)
}
