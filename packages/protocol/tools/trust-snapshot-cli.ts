#!/usr/bin/env bun
/**
 * Trust snapshot CLI (#3069).
 *
 *   bun run trust:snapshot             rewrite packages/protocol/trust.snapshot.json from the tree
 *   bun run trust:check                fail if the committed snapshot is not what the tree extracts to
 *   bun run trust:diff <base> [head]   what changed between two git revisions (head defaults to the working tree)
 *   bun run trust:release-check        refuse an artifact whose snapshot differs from the last release's
 *                                      unless a recorded sign-off names its digest
 *   bun run trust:signoff <digest>     record YOUR sign-off for a digest (a human act; never run by an agent)
 *
 * `release-check` options: `--against <git-ref>` (default: the latest `v*` tag whose commit is not HEAD).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  SIGNOFF_LEDGER_PATH, SNAPSHOT_PATH, TRUST_SIGNOFF_APPROVERS, TrustExtractionError, diffSnapshots, extractTrustSnapshot, fsReader,
  gitReader, readSignoffs, releaseVerdict, serializeSnapshot, snapshotDigest, type TrustSnapshot,
} from './trust-snapshot'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')

const git = (...args: string[]): string => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim()

/** The newest `v*` tag reachable from HEAD whose commit is not HEAD itself — the previous release. */
export function previousReleaseTag(): string | undefined {
  const head = git('rev-parse', 'HEAD')
  const tags = git('tag', '--merged', 'HEAD', '--list', 'v[0-9]*', '--sort=-v:refname').split('\n').filter((t) => t !== '')
  return tags.find((t) => git('rev-parse', `${t}^{commit}`) !== head)
}

function loadSigned(): ReturnType<typeof readSignoffs> {
  const path = join(ROOT, SIGNOFF_LEDGER_PATH)
  return existsSync(path) ? readSignoffs(JSON.parse(readFileSync(path, 'utf8'))) : readSignoffs({ signoffs: [] })
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv
  const tree = extractTrustSnapshot(fsReader(ROOT))
  switch (cmd) {
    case 'snapshot': {
      writeFileSync(join(ROOT, SNAPSHOT_PATH), serializeSnapshot(tree))
      console.log(`wrote ${SNAPSHOT_PATH} (digest ${snapshotDigest(tree)})`)
      return 0
    }
    case 'check': {
      const path = join(ROOT, SNAPSHOT_PATH)
      const committed = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as TrustSnapshot) : undefined
      if (committed === undefined) {
        console.error(`${SNAPSHOT_PATH} does not exist — run: bun run trust:snapshot`)
        return 1
      }
      const diff = diffSnapshots(committed, tree)
      if (diff.length === 0 && readFileSync(path, 'utf8') === serializeSnapshot(tree)) {
        console.log(`trust snapshot is current (digest ${snapshotDigest(tree)})`)
        return 0
      }
      console.error(`${SNAPSHOT_PATH} is stale: the tree's trust configuration differs from the committed snapshot.`)
      for (const l of diff) console.error(`  ${l}`)
      console.error('Review the change above — it is what a release sign-off will be asked about — then run: bun run trust:snapshot')
      return 1
    }
    case 'diff': {
      const [base, head] = rest
      if (base === undefined) {
        console.error('usage: trust:diff <base-rev> [head-rev]')
        return 2
      }
      const a = extractTrustSnapshot(gitReader(ROOT, base))
      const b = head === undefined ? tree : extractTrustSnapshot(gitReader(ROOT, head))
      const diff = diffSnapshots(a, b)
      console.log(diff.length === 0 ? 'trust snapshot unchanged' : diff.join('\n'))
      return 0
    }
    case 'release-check': {
      const i = rest.indexOf('--against')
      const against = i >= 0 ? rest[i + 1] : previousReleaseTag()
      const baseline = against === undefined ? undefined : extractTrustSnapshot(gitReader(ROOT, against))
      const verdict = releaseVerdict({ baseline, candidate: tree, signoffs: loadSigned() })
      console.log(`trust release check against ${against ?? '(no previous release)'}: ${verdict.ok ? 'OK' : 'REFUSED'} — ${verdict.reason}`)
      if (verdict.changed) for (const l of verdict.diff) console.log(`  ${l}`)
      return verdict.ok ? 0 : 1
    }
    case 'signoff': {
      const digest = rest[0]
      if (digest === undefined || digest !== snapshotDigest(tree)) {
        console.error(`refusing: the digest must name THIS tree's snapshot (${snapshotDigest(tree)}); review it with trust:diff first`)
        return 1
      }
      const signedBy = process.env['TRUST_SIGNOFF_AS'] ?? process.env['GH_USER'] ?? ''
      if (!TRUST_SIGNOFF_APPROVERS.includes(signedBy)) {
        console.error(`refusing: set TRUST_SIGNOFF_AS to an approver (${TRUST_SIGNOFF_APPROVERS.join(', ')}); signing is a human act`)
        return 1
      }
      const ledger = { signoffs: [...loadSigned(), { digest, signedBy, signedAt: new Date().toISOString() }] }
      writeFileSync(join(ROOT, SIGNOFF_LEDGER_PATH), `${JSON.stringify(ledger, null, 2)}\n`)
      console.log(`recorded sign-off for ${digest} by ${signedBy} in ${SIGNOFF_LEDGER_PATH}`)
      return 0
    }
    default:
      console.error('usage: trust-snapshot-cli <snapshot|check|diff|release-check|signoff>')
      return 2
  }
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (e) {
    if (e instanceof TrustExtractionError) {
      console.error(`could not read the trust configuration: ${e.message}`)
      process.exit(1)
    }
    throw e
  }
}
