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
 *   trust-snapshot-cli compare --root <repo> <base> <head>
 *                                      for the fleet gate: reads the changed-file list (a JSON array) on
 *                                      stdin and prints, as JSON, the `TrustSnapshotChange` from the merge
 *                                      base of <base> and <head> to <head> — `null` when no changed file is
 *                                      one the extractor reads
 *
 * `release-check` options:
 *   `--candidate <git-ref>`  the tree the artifact is built from (default: the working tree) — the local
 *                            release scripts pass the release tag, so what is checked is what was built;
 *   `--against <git-ref>`    the last release (default: the latest `v*` tag reachable from the candidate
 *                            whose commit is not the candidate itself).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  SIGNOFF_LEDGER_PATH, SNAPSHOT_PATH, TRUST_SIGNOFF_APPROVERS, TrustExtractionError, compareTrustSnapshots, diffSnapshots,
  extractTrustSnapshot, fsReader, gitReader, readSignoffs, releaseVerdict, serializeSnapshot, snapshotDigest, touchesTrustInputs,
  type ReleaseVerdict, type TrustSnapshot, type TrustSnapshotChange,
} from './trust-snapshot'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')

const git = (root: string, ...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/
const semverOf = (v: string): [number, number, number] | undefined => {
  const m = SEMVER.exec(v)
  return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])]
}
const semverLess = (a: [number, number, number], b: [number, number, number]): boolean =>
  a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2]

/** The version the candidate is: its own tag name, or the `package.json` version of its tree. */
function candidateVersion(ref: string, root: string): [number, number, number] | undefined {
  const fromTag = semverOf(ref)
  if (fromTag !== undefined) return fromTag
  try {
    const pkg = JSON.parse(execFileSync('git', ['-C', root, 'show', `${ref}:package.json`], { encoding: 'utf8' })) as { version?: string }
    return semverOf(pkg.version ?? '')
  } catch {
    return undefined
  }
}

/**
 * The previous release: the newest whole `vX.Y.Z` tag reachable from `ref` whose version is STRICTLY LOWER
 * than the candidate's and whose commit is not the candidate. Tags are mutable, so the baseline is never
 * "the newest tag" — a forged high tag cannot be chosen as the baseline for a lower candidate. (Protecting
 * `v*` tags in the repository settings is still the control that stops a tag being moved.) Throws when the
 * answer cannot be trusted: a shallow clone with no tags reads as "no previous release", which would turn
 * an unchanged snapshot into a demand for a sign-off — or hide a changed one.
 */
export function previousReleaseTag(ref = 'HEAD', root = ROOT): string | undefined {
  const head = git(root, 'rev-parse', `${ref}^{commit}`)
  // Whole releases only: `v0.21.25`, not the per-platform `v0.21.25-android` tags cut beside it.
  const tags = git(root, 'tag', '--merged', ref, '--list', 'v[0-9]*', '--sort=-v:refname').split('\n').filter((t) => SEMVER.test(t))
  if (tags.length === 0 && git(root, 'rev-parse', '--is-shallow-repository') === 'true') {
    throw new TrustExtractionError(
      'this is a shallow clone with no release tags, so the previous release cannot be found — fetch with full history and tags (git fetch --unshallow --tags) and re-run',
    )
  }
  const own = candidateVersion(ref, root)
  return tags.find((t) => {
    const v = semverOf(t) as [number, number, number]
    return (own === undefined || semverLess(v, own)) && git(root, 'rev-parse', `${t}^{commit}`) !== head
  })
}

/** True for the two CI contexts that PRODUCE a release: the release PR and a release tag push. */
export function isReleaseCandidate(env: Record<string, string | undefined>): boolean {
  return env['GITHUB_HEAD_REF'] === 'release' || (env['GITHUB_REF_TYPE'] === 'tag' && /^v\d/.test(env['GITHUB_REF_NAME'] ?? ''))
}

/**
 * The release verdict for building a client artifact from `candidate` (default: the working tree):
 * its snapshot against the last release's, and the sign-offs recorded in the candidate's own tree.
 */
export function runReleaseCheck(
  opts: { candidate?: string; against?: string; root?: string } = {},
): { against: string | undefined; verdict: ReleaseVerdict } {
  const root = opts.root ?? ROOT
  const tree = opts.candidate === undefined ? fsReader(root) : gitReader(root, opts.candidate)
  const candidate = extractTrustSnapshot(tree)
  const against = opts.against ?? previousReleaseTag(opts.candidate ?? 'HEAD', root)
  const baseline = against === undefined ? undefined : extractTrustSnapshot(gitReader(root, against))
  const ledger = tree.read(SIGNOFF_LEDGER_PATH)
  const signoffs = readSignoffs(ledger === undefined ? { signoffs: [] } : JSON.parse(ledger))
  return { against, verdict: releaseVerdict({ baseline, candidate, signoffs }) }
}

function loadSigned(): ReturnType<typeof readSignoffs> {
  const path = join(ROOT, SIGNOFF_LEDGER_PATH)
  return existsSync(path) ? readSignoffs(JSON.parse(readFileSync(path, 'utf8'))) : readSignoffs({ signoffs: [] })
}

/**
 * What the fleet gate shows about a PR's trust snapshot (`VerifyReport.trustSnapshot`, #3069): `null` when
 * no changed file is one the extractor reads, otherwise the comparison of the two revisions. Both sides are
 * read from git objects in `repo`, so the revision under judgement is data and none of its code runs. The
 * gate runs this in a child process rather than importing it: `orchestrator/src` imports nothing from
 * outside itself (the credential-boundary rail), and the child gets no credential-bearing environment.
 */
export function compareForGate(repo: string, base: string, head: string, changedFiles: readonly string[]): TrustSnapshotChange | null {
  if (!touchesTrustInputs(changedFiles)) return null
  let mergeBase: string
  try {
    mergeBase = git(repo, 'merge-base', base, head)
  } catch {
    mergeBase = ''
  }
  if (mergeBase === '') return { changed: false, changes: [], error: 'the merge base could not be resolved, so the trust snapshot could not be compared' }
  return compareTrustSnapshots(gitReader(repo, mergeBase), gitReader(repo, head))
}

function parseChangedFiles(stdin: string): string[] {
  const parsed: unknown = JSON.parse(stdin)
  if (!Array.isArray(parsed) || !parsed.every((f): f is string => typeof f === 'string')) {
    throw new Error('stdin must be a JSON array of changed file paths')
  }
  return parsed
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv
  const opt = (name: string): string | undefined => {
    const i = rest.indexOf(name)
    return i >= 0 ? rest[i + 1] : undefined
  }
  if (cmd === 'compare') {
    const root = opt('--root')
    const [base, head] = rest.filter((a, i) => a !== '--root' && rest[i - 1] !== '--root')
    if (root === undefined || base === undefined || head === undefined) {
      console.error('usage: trust-snapshot-cli compare --root <repo> <base-rev> <head-rev>  (changed files as a JSON array on stdin)')
      return 2
    }
    const changed = parseChangedFiles(readFileSync(0, 'utf8'))
    process.stdout.write(`${JSON.stringify(compareForGate(root, base, head, changed))}\n`)
    return 0
  }
  if (cmd === 'release-check') {
    const { against, verdict } = runReleaseCheck({ candidate: opt('--candidate'), against: opt('--against') })
    console.log(`trust release check against ${against ?? '(no previous release)'}: ${verdict.ok ? 'OK' : 'REFUSED'} — ${verdict.reason}`)
    if (verdict.changed) for (const l of verdict.diff) console.log(`  ${l}`)
    return verdict.ok ? 0 : 1
  }
  const tree: TrustSnapshot = extractTrustSnapshot(fsReader(ROOT))
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
    case 'signoff': {
      const digest = rest[0]
      if (digest === undefined || digest !== snapshotDigest(tree)) {
        console.error(`refusing: the digest must name THIS tree's snapshot (${snapshotDigest(tree)}); review it with trust:diff first`)
        return 1
      }
      // This writes a line; it does not authenticate anyone. What makes the line mean something is that
      // the ledger is owned in CODEOWNERS and held by the write gate: a PR that adds an entry lands only
      // with the approver's own review of that exact head. The name below is a record, not the proof.
      const signedBy = process.env['TRUST_SIGNOFF_AS'] ?? ''
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
      console.error('usage: trust-snapshot-cli <snapshot|check|diff|release-check|signoff|compare>')
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
