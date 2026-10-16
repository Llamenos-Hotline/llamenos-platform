import { useEffect, useState } from 'react'
import { getRecordEnvelopeRecipients } from './api/records'

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
