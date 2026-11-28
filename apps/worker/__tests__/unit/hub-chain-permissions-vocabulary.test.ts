/**
 * The hub authority chain's permission vocabulary (#2963) as the hosts state
 * it: `packages/protocol/hub-chain-permissions.json` is the vocabulary the
 * crate evaluates (its own constants are pinned to the same file by
 * `hub_chain::tests::vocabulary_matches_protocol_json`), and the server's
 * reader purposes must agree with it, or the server's reader sets and the
 * chain's purpose groups name different members.
 */
import { describe, expect, it } from 'vitest'
import vocabulary from '../../../../packages/protocol/hub-chain-permissions.json'
import { READER_PURPOSE_PERMISSIONS } from '@shared/permissions'

const sorted = (xs: readonly string[]) => [...xs].sort()

describe('hub-chain permission vocabulary', () => {
  it('the reader purposes match READER_PURPOSE_PERMISSIONS, purpose for purpose', () => {
    expect(Object.keys(vocabulary.readerPurposes).sort()).toEqual(Object.keys(READER_PURPOSE_PERMISSIONS).sort())
    for (const [purpose, perms] of Object.entries(READER_PURPOSE_PERMISSIONS)) {
      expect(sorted(vocabulary.readerPurposes[purpose as keyof typeof vocabulary.readerPurposes]), purpose).toEqual(sorted(perms))
    }
  })

  it('role management is a permission of the catalog', async () => {
    const { PERMISSION_CATALOG } = await import('@shared/permissions')
    expect(Object.keys(PERMISSION_CATALOG)).toContain(vocabulary.roleManagement)
  })
})
