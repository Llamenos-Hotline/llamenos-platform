/**
 * #2963 gate: no host code constructs a hub-chain label, signing message or
 * canonical hash. Every canonicalisation, hash and signature of a hub-chain
 * link, bundle permission set or recovery approval is packages/crypto's
 * (`hub_chain`); hosts reach it only through `hub_chain::call` and the two
 * state-held signers.
 *
 * The check: the three labels — by constant name or by string — appear in no
 * host source tree. The crate, the generated label constants and the
 * test-side signer (tests/mocks/hub-chain-mock.ts, pinned byte-for-byte to the
 * crate by integration-bun/hub-chain-vectors.test.ts) are the only places
 * allowed to name them.
 *
 * Reads files inside the test body only: `fleet/verify` runs this suite in an
 * export with no `.git`, so nothing here shells out to git.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '../../../..')

const HOST_TREES = [
  'apps/worker',
  'src/client',
  'apps/desktop/src',
  'apps/ios/Sources',
  'apps/android/app/src/main/java/org/llamenos/hotline',
  'packages/shared',
]

const NEEDLES = [
  'LABEL_HUB_CHAIN_SIG',
  'LABEL_HUB_BUNDLE_PERMS',
  'LABEL_RECOVERY_APPROVAL',
  'llamenos:hub-chain-sig',
  'llamenos:hub-bundle-perms',
  'llamenos:recovery-approval',
]

/** Generated label constants are codegen output from crypto-labels.json, not host logic. */
const ALLOWED = new Set(['packages/shared/crypto-labels.ts'])

function* sourceFiles(dir: string): Generator<string> {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'target' || name === 'build' || name === '__tests__') continue
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) yield* sourceFiles(path)
    else if (/\.(ts|tsx|rs|swift|kt)$/.test(name)) yield path
  }
}

describe('no host code builds a hub-chain label, message or canonical hash (#2963)', () => {
  it('the hub-chain labels appear in no host source tree', () => {
    const hits: string[] = []
    let scanned = 0
    for (const tree of HOST_TREES) {
      for (const file of sourceFiles(join(ROOT, tree))) {
        const rel = relative(ROOT, file)
        if (ALLOWED.has(rel)) continue
        scanned += 1
        const text = readFileSync(file, 'utf8')
        for (const needle of NEEDLES) if (text.includes(needle)) hits.push(`${rel}: ${needle}`)
      }
    }
    // A scan that read nothing proves nothing.
    expect(scanned).toBeGreaterThan(500)
    expect(hits).toEqual([])
  })
})
