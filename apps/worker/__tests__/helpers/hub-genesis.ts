/**
 * A real founder's genesis for route tests that need a schema-valid create-hub
 * or setup-complete body (#2963): the first link of the crate's hub-chain
 * vectors (packages/crypto/tests/fixtures/v2/hub-chain.json), never a
 * hand-written link.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HubChainLink } from '@protocol/schemas/hub-chain'

const vectors = JSON.parse(
  readFileSync(join(__dirname, '../../../../packages/crypto/tests/fixtures/v2/hub-chain.json'), 'utf8'),
) as { chain: HubChainLink[] }

export const VECTOR_GENESIS: HubChainLink = vectors.chain[0]

/** The `id` and `genesis` fields of a create-hub body founded by the vector's founder. */
export const VALID_HUB_FOUNDING = { id: VECTOR_GENESIS.hub, genesis: VECTOR_GENESIS }
