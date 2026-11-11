import { useEffect, useState } from 'react'
import { getRecordEnvelopeRecipients } from './api/records'
import { adminHpkeRecipient } from './admin-recipient'

/**
 * THE contract for who a case record is sealed to. Every desktop create/update
 * path that writes a record tier (#1682) goes through {@link resolveRecordReaders};
 * no component assembles a reader list itself.
 *
 * Which tier each payload belongs to is decided by the call site's purpose, not
 * by the site:
 *
 * | payload                              | tier      | because                                  |
 * |--------------------------------------|-----------|------------------------------------------|
 * | record summary (title, status, ...)  | `summary` | every member who may see the case exists |
 * | custom field values                  | `fields`  | assignees + admins + `editRoles` holders |
 * | timeline comments, evidence          | `fields`  | the people who work the case             |
 * | contact PII                          | `pii`     | admins + `contacts:view-pii` holders     |
 *
 * The tiers themselves are computed by the server (`apps/worker/lib/envelope-recipients.ts`)
 * from permissions and `editRoles` slugs — nothing here branches on a role name.
 */
export type RecordTier = 'summary' | 'fields' | 'pii'

/** The reader list of each tier: X25519 device keys, plus the author and an admin. */
export type RecordReaders = Readonly<Record<RecordTier, string[]>>

/**
 * Raised when there is no admin who could read what is about to be written.
 *
 * It is the same refusal `note-sheet.tsx` makes (#1468, #1824): an envelope set
 * with no admin reader stores, acknowledges and renders to its author, and no
 * admin can ever open it. The caller keeps the user's input on screen and says
 * why; it does not substitute another key.
 */
export class NoAdminReaderError extends Error {
  constructor() {
    super('no admin decryption key is configured, so no admin could read this record')
    this.name = 'NoAdminReaderError'
  }
}

const HEX64_RE = /^[0-9a-f]{64}$/

function dedupe(keys: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const key of keys) {
    const normalised = key.toLowerCase()
    if (seen.has(normalised)) continue
    seen.add(normalised)
    out.push(key)
  }
  return out
}

/**
 * Author + the server's tier + the admin recipient, in that order.
 *
 * `serverTiers === null` is a failed lookup, and it is not an error: the lookup
 * is advice about who ELSE may read, and a crisis hotline cannot fail to record
 * a call because an HTTP request for it failed. The author keeps their own
 * envelope and the admin keeps theirs; the reader this omits is a co-assignee,
 * which a re-wrap can restore. What the fallback never does is name some other
 * key to stand in — a made-up reader is an envelope nobody can open (#1021).
 *
 * Throws {@link NoAdminReaderError} when the admin recipient is absent or is not
 * a 64-hex key. Server entries that are not 64-hex are dropped, not repaired.
 */
export function composeReaders(
  serverTiers: Readonly<Record<RecordTier, readonly string[]>> | null,
  authorPubkey: string,
  adminDecryptionPubkey: string | null | undefined,
): RecordReaders {
  const admin = adminHpkeRecipient(adminDecryptionPubkey)
  if (!admin) throw new NoAdminReaderError()
  const tier = (name: RecordTier): string[] =>
    dedupe([
      authorPubkey,
      ...(serverTiers?.[name] ?? []).filter(k => HEX64_RE.test(k.toLowerCase())),
      admin,
    ])
  return { summary: tier('summary'), fields: tier('fields'), pii: tier('pii') }
}

/** The inputs every call site has. */
interface ReaderParams {
  /** This user's account key (`useAuth().publicKey`); the sealing device is always a reader. */
  authorPubkey: string
  adminDecryptionPubkey: string | null | undefined
}

/**
 * Who may read a record that does not exist yet.
 *
 * `assignedTo` is the intended assignees' account keys (`records.assigned_to`
 * values), which the server resolves to their devices. The admin check runs
 * before the request: a hub with no admin recipient refuses the write without
 * spending a round trip.
 */
export async function resolveCreationReaders(
  params: ReaderParams & { entityTypeId: string; assignedTo: string[] },
): Promise<RecordReaders> {
  composeReaders(null, params.authorPubkey, params.adminDecryptionPubkey)
  return composeReaders(
    await lookupTiers({ entityTypeId: params.entityTypeId, assignedTo: params.assignedTo }),
    params.authorPubkey,
    params.adminDecryptionPubkey,
  )
}

/** Who may read an existing record, asked at write time (never from a cached hook value). */
export async function resolveRecordReaders(
  params: ReaderParams & { recordId: string },
): Promise<RecordReaders> {
  composeReaders(null, params.authorPubkey, params.adminDecryptionPubkey)
  return composeReaders(
    await lookupTiers({ recordId: params.recordId }),
    params.authorPubkey,
    params.adminDecryptionPubkey,
  )
}

/** `null` on any failure; see {@link composeReaders}. */
async function lookupTiers(
  query: Parameters<typeof getRecordEnvelopeRecipients>[0],
): Promise<Record<RecordTier, string[]> | null> {
  try {
    return await getRecordEnvelopeRecipients(query)
  } catch {
    return null
  }
}

/**
 * The X25519 device keys entitled to read a record's working content.
 *
 * Who may read a record is a server-side question: it depends on the entity
 * type's `accessRoles` / `editRoles`, on the record's `assignedTo`, and on each
 * member's resolved hub permissions — none of which a client can see in full.
 * `GET /api/records/:id/envelope-recipients` answers it
 * (`docs/protocol/PROTOCOL.md`, `apps/worker/lib/envelope-recipients.ts`), and
 * returns the three tiers of the 3-tier model described in
 * `docs/security/CRYPTO_ARCHITECTURE.md`.
 *
 * Before this hook existed the endpoint had no callers at all, and every client
 * invented its own list: `[own device key] + adminDecryptionPubkey`. Content
 * written that way is stored, acknowledged and renders normally to its author,
 * while the volunteers actually assigned to the case cannot open it — a silent
 * loss that only shows up when someone entitled to read goes looking.
 *
 * `fields` is the tier for a record's working content — timeline comments and
 * evidence — because it names exactly the people who work the case: its
 * assignees, the hub's admins, and the entity type's `editRoles` holders.
 * `summary` is deliberately broader (every member who may see the case exists)
 * and `pii` deliberably narrower.
 *
 * Returns `[]` until the fetch resolves, and `[]` on failure. Callers must add
 * their own device key and the admin recipient themselves and must not treat an
 * empty list as "no readers" — a shorter list costs a reader, which is
 * recoverable; sealing to a key nobody holds is not.
 */
export function useRecordFieldRecipients(recordId: string | undefined): string[] {
  const [recipients, setRecipients] = useState<string[]>([])

  useEffect(() => {
    if (!recordId) {
      setRecipients([])
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const tiers = await getRecordEnvelopeRecipients({ recordId })
        if (!cancelled) setRecipients(tiers.fields)
      } catch {
        // A failed lookup must not block filing a comment or uploading
        // evidence during a crisis call. The caller still seals to its own
        // device key and the admin recipient, so the content is readable by
        // the author and by an admin — the reader this omits is a co-assignee,
        // and a re-wrap can restore them later.
        if (!cancelled) setRecipients([])
      }
    })()
    return () => { cancelled = true }
  }, [recordId])

  return recipients
}
