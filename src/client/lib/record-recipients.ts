import { useEffect, useState } from 'react'
import { getRecordEnvelopeRecipients } from './api/records'
import { getActiveHub, NoActiveHubError } from './api'
import { hubAdminReaders, NoAdminReaderError, type AdminHpkeRecipient } from './admin-recipient'

export { NoAdminReaderError }

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

/** The reader list of each tier: X25519 device keys, plus the author and every admin of the hub. */
export type RecordReaders = Readonly<Record<RecordTier, string[]>>

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
 * Author + the server's tier + every admin of the record's hub, in that order.
 *
 * `serverTiers === null` is a failed lookup, and it is not an error: the lookup
 * is advice about who ELSE may read, and a crisis hotline cannot fail to record
 * a call because an HTTP request for it failed. The author keeps their own
 * envelope and the hub's admins keep theirs; the reader this omits is a
 * co-assignee, which a re-wrap can restore. What the fallback never does is
 * name some other key to stand in — a made-up reader is an envelope nobody can
 * open (#1021).
 *
 * `adminReaders` is the hub's `admin` reader set (`hubAdminReaders()`, #1035):
 * the registered device keys of every member holding the admin minimum in the
 * hub, plus its escrow key. It is never the instance-wide
 * `adminDecryptionPubkey` — that is one env-configured key, absent on a
 * wizard-bootstrapped deployment, and never a reader of hub content.
 *
 * Throws {@link NoAdminReaderError} when `adminReaders` is empty: a record no
 * admin can open cannot be repaired afterwards. Server entries that are not
 * 64-hex are dropped, not repaired.
 */
export function composeReaders(
  serverTiers: Readonly<Record<RecordTier, readonly string[]>> | null,
  authorPubkey: string,
  adminReaders: readonly AdminHpkeRecipient[],
  hubId: string,
): RecordReaders {
  if (adminReaders.length === 0) throw new NoAdminReaderError(hubId)
  const tier = (name: RecordTier): string[] =>
    dedupe([
      authorPubkey,
      ...(serverTiers?.[name] ?? []).map(k => k.toLowerCase()).filter(k => HEX64_RE.test(k)),
      ...adminReaders,
    ])
  return { summary: tier('summary'), fields: tier('fields'), pii: tier('pii') }
}

/** The inputs every call site has. */
interface ReaderParams {
  /** This user's account key (`useAuth().publicKey`); the sealing device is always a reader. */
  authorPubkey: string
}

/**
 * Who may read a record that does not exist yet.
 *
 * `assignedTo` is the intended assignees' account keys (`records.assigned_to`
 * values), which the server resolves to their devices. A new record is filed in
 * the hub being browsed, so it is sealed to THAT hub's admins. They are
 * resolved first: a hub with no admin able to read refuses the write before the
 * tier lookup.
 */
export async function resolveCreationReaders(
  params: ReaderParams & { entityTypeId: string; assignedTo: string[] },
): Promise<RecordReaders> {
  const hubId = getActiveHub()
  if (!hubId) throw new NoActiveHubError('/readers')
  const admins = await hubAdminReaders(hubId)
  return composeReaders(
    await lookupTiers({ entityTypeId: params.entityTypeId, assignedTo: params.assignedTo }),
    params.authorPubkey,
    admins,
    hubId,
  )
}

/**
 * Who may read an existing record, asked at write time (never from a cached
 * hook value).
 *
 * `hubId` is the RECORD's hub (`record.hubId`), never the hub being browsed: a
 * record opened from the cross-hub list belongs to another hub, and sealing it
 * to the browsed hub's admins hands one hub's case content to another's.
 */
export async function resolveRecordReaders(
  params: ReaderParams & { recordId: string; hubId: string },
): Promise<RecordReaders> {
  const admins = await hubAdminReaders(params.hubId)
  return composeReaders(
    await lookupTiers({ recordId: params.recordId, hubId: params.hubId }),
    params.authorPubkey,
    admins,
    params.hubId,
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
 * `hubId` is the record's own hub (`record.hubId`): a record opened from the
 * cross-hub list is not in the hub being browsed.
 *
 * Returns `[]` until the fetch resolves, and `[]` on failure. Callers must add
 * their own device key and the hub's admin readers themselves and must not treat an
 * empty list as "no readers" — a shorter list costs a reader, which is
 * recoverable; sealing to a key nobody holds is not.
 */
export function useRecordFieldRecipients(recordId: string | undefined, hubId?: string): string[] {
  const [recipients, setRecipients] = useState<string[]>([])

  useEffect(() => {
    if (!recordId) {
      setRecipients([])
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const tiers = await getRecordEnvelopeRecipients({ recordId, hubId })
        if (!cancelled) setRecipients(tiers.fields)
      } catch {
        // A failed lookup must not block filing a comment or uploading
        // evidence during a crisis call. The caller still seals to its own
        // device key and the hub's admin readers, so the content is readable by
        // the author and by an admin — the reader this omits is a co-assignee,
        // and a re-wrap can restore them later.
        if (!cancelled) setRecipients([])
      }
    })()
    return () => { cancelled = true }
  }, [recordId, hubId])

  return recipients
}
