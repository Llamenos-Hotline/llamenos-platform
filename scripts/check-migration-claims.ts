#!/usr/bin/env bun
/**
 * check-migration-claims.ts — fail a branch, at PR time, whose migration
 * cannot land as named, and print the command that fixes it (#2391).
 *
 * The failures this exists for were all discovered too late: a numbered
 * migration whose number main already had, or another open PR had also picked,
 * or whose snapshot's `prevId` still named the snapshot it was first generated
 * on. Each passed every local check and failed `migration-drift` inside the
 * merge group, where under ALLGREEN it took the whole batch down with it.
 *
 * New migrations are timestamped (`bun run db:generate`,
 * scripts/lib/migration-graph.ts) and cannot collide; numbered ones are only
 * still accepted from the PRs that were in flight at the cutover. What is
 * checked, against --base (default origin/main):
 *
 *   numbered `NNNN_*.sql`
 *     - NNNN is not on the base, and is the next free number there;
 *     - no timestamped migration is on the base (NNNN would sort before it);
 *     - its snapshot's `prevId` is the id of the base's newest snapshot.
 *       Hand-editing `prevId` to match is NOT the fix: a snapshot generated
 *       before main moved also lacks everything main added since, and fails
 *       drift in the merge group. The fix is always to regenerate.
 *   timestamped `YYYYMMDDHHMMSS_*.sql`
 *     - it ships its snapshot, whose `prevIds` all exist in this tree.
 *       They need NOT be the base's current heads: a branch generated before
 *       another migration landed is concurrent with it, which is fine.
 *   `meta/_journal.json`
 *     - retired; nothing may add it back.
 *   --against-open-prs (CI on pull_request; the pre-push hook)
 *     - no OLDER open PR adds a migration with the same prefix. Oldest PR
 *       keeps the claim, so two claimants never block each other. One
 *       `gh pr list` call, made only when this branch adds a migration.
 *
 * Usage:
 *   bun run migration:claims [--base <rev>] [--against-open-prs] [--pr <n>] [--root <repo>]
 *
 * Exit: 0 clean, 1 a claim that cannot land, 2 the check itself could not run.
 */
import { join } from 'node:path'
import {
  LEGACY_PREFIX,
  MigrationGraph,
  TIMESTAMP_PREFIX,
  prefixOf,
  type SnapshotJson,
} from './lib/migration-graph'

const MIGRATIONS = 'drizzle/migrations'
const JOURNAL = `${MIGRATIONS}/meta/_journal.json`

export interface OpenPr {
  number: number
  createdAt: string
  headRefName: string
  files: { path: string }[]
}

export interface ClaimsInput {
  base: string
  /** Every `drizzle/migrations/*.sql` and `meta/*_snapshot.json` on the base. */
  baseFiles: string[]
  /** The base's snapshots, by file name. */
  baseSnapshots: Map<string, SnapshotJson>
  /** Migration-tree paths this branch adds, relative to drizzle/migrations. */
  added: string[]
  /** This tree's snapshots, by file name. */
  treeSnapshots: Map<string, SnapshotJson>
  /** Whether this branch adds or edits `meta/_journal.json`. */
  journalTouched: boolean
  /** Open PRs other than this one, when --against-open-prs; undefined otherwise. */
  openPrs?: OpenPr[]
  /** This branch's PR creation time, if it has a PR. */
  selfCreatedAt?: string
}

const sqlName = (p: string) => /^[^/]+\.sql$/.test(p)
const snapName = (p: string) => /^meta\/[^/]+_snapshot\.json$/.test(p)
const nameOf = (sql: string) => sql.replace(/^\d+_/, '').replace(/\.sql$/, '')

function regenerate(sql: string, snapshot: string | undefined): string {
  return [
    '    Fix: regenerate it as a timestamped migration, which nothing can collide with:',
    `      git show HEAD:${MIGRATIONS}/${sql} > /tmp/${sql}   # keep any hand edits`,
    `      git fetch -q origin && git rebase origin/main   # a conflict under ${MIGRATIONS}/meta/: git rm the file, git rebase --continue`,
    `      git rm -q ${MIGRATIONS}/${sql}${snapshot ? ` ${MIGRATIONS}/${snapshot}` : ''}`,
    `      bun run db:generate --name ${nameOf(sql)}       # add --custom for a hand-written one`,
    `    then re-apply anything from /tmp/${sql} that the generator did not write.`,
  ].join('\n')
}

/** Every reason this branch's migrations cannot land as named. */
export function judgeClaims(input: ClaimsInput): string[] {
  const out: string[] = []
  const addedSql = input.added.filter(sqlName).sort()
  const addedSnaps = new Set(input.added.filter(snapName))

  if (input.journalTouched) {
    out.push(
      `${JOURNAL} is retired: nothing reads it, and appending to it made every pair of migration PRs ` +
        `conflict.\n    Fix: git rm -q ${JOURNAL}`,
    )
  }

  const baseSql = input.baseFiles.filter(sqlName)
  const baseNumbers = baseSql.map((f) => prefixOf(f) ?? '').filter((p) => LEGACY_PREFIX.test(p)).sort()
  const baseTimestamped = baseSql.filter((f) => TIMESTAMP_PREFIX.test(prefixOf(f) ?? '')).sort()
  const baseLegacySnaps = [...input.baseSnapshots.keys()].filter((f) => LEGACY_PREFIX.test(prefixOf(f) ?? '')).sort()
  const newestBaseSnap = baseLegacySnaps.at(-1)
  const newestBaseId = newestBaseSnap ? input.baseSnapshots.get(newestBaseSnap)?.id : undefined
  const baseGraph = MigrationGraph.fromSnapshots([...input.baseSnapshots].map(([file, snapshot]) => ({ file, snapshot })))
  const baseHeads = baseGraph.heads().map((h) => `${h.file} (${h.id})`)
  const treeIds = new Set([...input.treeSnapshots.values()].map((s) => s.id))

  // Numbered additions must continue the base's numbering, one after another.
  let expectedNumber = String(Number(baseNumbers.at(-1) ?? '-1') + 1).padStart(4, '0')
  let expectedPrevId = newestBaseId
  let expectedPrevFrom = newestBaseSnap
  for (const sql of addedSql) {
    const prefix = prefixOf(sql) ?? ''
    const snapshot = `meta/${prefix}_snapshot.json`
    const ownSnap = addedSnaps.has(snapshot) ? snapshot : undefined

    if (LEGACY_PREFIX.test(prefix)) {
      const taken = baseSql.filter((f) => prefixOf(f) === prefix)
      if (taken.length > 0) {
        out.push(`${sql}: ${prefix} is already taken on ${input.base} by ${taken.join(', ')}.\n${regenerate(sql, ownSnap)}`)
        continue
      }
      if (baseTimestamped.length > 0) {
        out.push(
          `${sql}: numbered migrations closed when ${baseTimestamped[0]} landed on ${input.base}; ${sql} ` +
            `would sort before it, so a fresh database and an upgraded one would apply them in different orders.\n` +
            regenerate(sql, ownSnap),
        )
        continue
      }
      if (prefix !== expectedNumber) {
        out.push(
          `${sql}: ${prefix} is not the next free number on ${input.base}; that is ${expectedNumber}.` +
            `${claimantOf(input, expectedNumber)}\n${regenerate(sql, ownSnap)}`,
        )
        continue
      }
      if (ownSnap) {
        const prevId = input.treeSnapshots.get(ownSnap.slice('meta/'.length))?.prevId
        if (expectedPrevId !== undefined && prevId !== expectedPrevId) {
          out.push(
            `${MIGRATIONS}/${ownSnap}: prevId is ${prevId}, but ${input.base}'s newest snapshot ` +
              `${expectedPrevFrom} has id ${expectedPrevId}. The snapshot was generated before ${input.base} ` +
              'moved, so it also lacks what landed since — editing prevId by hand passes locally and fails ' +
              `migration-drift in the merge group.\n${regenerate(sql, ownSnap)}`,
          )
          continue
        }
        expectedPrevId = input.treeSnapshots.get(ownSnap.slice('meta/'.length))?.id
        expectedPrevFrom = ownSnap.slice('meta/'.length)
      }
      expectedNumber = String(Number(prefix) + 1).padStart(4, '0')
      continue
    }

    if (TIMESTAMP_PREFIX.test(prefix)) {
      if (!ownSnap) {
        out.push(
          `${sql} ships no ${snapshot}. Every timestamped migration records the schema it leaves behind.\n` +
            `    Fix: git rm -q ${MIGRATIONS}/${sql} && bun run db:generate --name ${nameOf(sql)} [--custom]`,
        )
        continue
      }
      const snap = input.treeSnapshots.get(snapshot.slice('meta/'.length))
      const prevIds = snap?.prevIds ?? []
      const missing = prevIds.filter((id) => !treeIds.has(id))
      if (prevIds.length === 0 || missing.length > 0) {
        out.push(
          `${MIGRATIONS}/${snapshot}: prevIds ${prevIds.length === 0 ? 'is empty' : `names ${missing.join(', ')}, which no snapshot in this tree has`}. ` +
            `${input.base}'s heads are ${baseHeads.join(', ') || '(none)'}.\n${regenerate(sql, snapshot)}`,
        )
      }
      continue
    }

    out.push(
      `${sql}: migrations are named YYYYMMDDHHMMSS_<name>.sql by bun run db:generate.\n${regenerate(sql, ownSnap)}`,
    )
  }

  for (const snap of addedSnaps) {
    const prefix = prefixOf(snap.slice('meta/'.length)) ?? ''
    if (!addedSql.some((f) => prefixOf(f) === prefix) && TIMESTAMP_PREFIX.test(prefix)) {
      out.push(`${MIGRATIONS}/${snap} has no migration beside it.\n    Fix: git rm -q ${MIGRATIONS}/${snap}`)
    }
  }

  // Another open PR already claims this prefix. The older PR keeps it.
  for (const sql of addedSql) {
    const prefix = prefixOf(sql) ?? ''
    for (const pr of olderClaimants(input, prefix)) {
      const theirs = pr.files.map((f) => f.path).filter((p) => prefixOf(p.slice(MIGRATIONS.length + 1)) === prefix && p.endsWith('.sql'))
      out.push(
        `${sql}: open PR #${pr.number} (opened ${pr.createdAt}, before this one) already claims ${prefix} with ` +
          `${theirs.join(', ')}. Whichever lands second fails.\n${regenerate(sql, addedSnaps.has(`meta/${prefix}_snapshot.json`) ? `meta/${prefix}_snapshot.json` : undefined)}`,
      )
    }
  }
  return out
}

function claims(pr: OpenPr, prefix: string): boolean {
  return pr.files.some((f) => {
    if (!f.path.startsWith(`${MIGRATIONS}/`)) return false
    const rest = f.path.slice(MIGRATIONS.length + 1)
    return sqlName(rest) && prefixOf(rest) === prefix
  })
}

function olderClaimants(input: ClaimsInput, prefix: string): OpenPr[] {
  return (input.openPrs ?? []).filter(
    (pr) => claims(pr, prefix) && (input.selfCreatedAt === undefined || pr.createdAt < input.selfCreatedAt),
  )
}

function claimantOf(input: ClaimsInput, prefix: string): string {
  const pr = (input.openPrs ?? []).filter((p) => claims(p, prefix)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
  return pr ? ` Open PR #${pr.number} claims ${prefix}; this one cannot land before it.` : ''
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function git(root: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString().trim()}`)
  return r.stdout.toString()
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** The open-PR sweep. `MIGRATION_CLAIMS_GH` names the gh binary (tests substitute one). */
function openPrs(root: string, self: string | undefined): { prs: OpenPr[]; selfCreatedAt?: string } {
  const gh = process.env.MIGRATION_CLAIMS_GH ?? 'gh'
  const r = Bun.spawnSync(
    [gh, 'pr', 'list', '--state', 'open', '--limit', '300', '--json', 'number,createdAt,headRefName,files'],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' },
  )
  if (r.exitCode !== 0) throw new Error(`gh pr list failed: ${r.stderr.toString().trim()}`)
  const all = JSON.parse(r.stdout.toString()) as OpenPr[]
  const branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
  const mine = all.find((p) => (self !== undefined ? String(p.number) === self : p.headRefName === branch))
  return { prs: all.filter((p) => p !== mine), selfCreatedAt: mine?.createdAt }
}

async function main() {
  const root = arg('--root') ?? process.cwd()
  const base = arg('--base') ?? 'origin/main'

  const diff = git(root, 'diff', '--name-status', '--no-renames', base, '--', MIGRATIONS)
  const untracked = git(root, 'ls-files', '--others', '--exclude-standard', '--', MIGRATIONS)
  const changes = [
    ...diff.split('\n').filter(Boolean).map((l) => l.split('\t') as [string, string]),
    ...untracked.split('\n').filter(Boolean).map((p) => ['A', p] as [string, string]),
  ]
  const added = changes.filter(([s]) => s === 'A').map(([, p]) => p.slice(MIGRATIONS.length + 1))
  const journalTouched = changes.some(([s, p]) => p === JOURNAL && s !== 'D')

  if (!added.some((p) => sqlName(p) || snapName(p)) && !journalTouched) {
    console.log(`[migration-claims] this branch adds no migration relative to ${base}; nothing to claim`)
    return
  }

  const baseFiles = git(root, 'ls-tree', '-r', '--name-only', base, '--', `${MIGRATIONS}/`)
    .split('\n')
    .filter(Boolean)
    .map((p) => p.slice(MIGRATIONS.length + 1))
  const baseSnapshots = new Map<string, SnapshotJson>()
  for (const f of baseFiles.filter(snapName)) {
    baseSnapshots.set(f.slice('meta/'.length), JSON.parse(git(root, 'show', `${base}:${MIGRATIONS}/${f}`)) as SnapshotJson)
  }
  const treeSnapshots = new Map<string, SnapshotJson>()
  for (const n of MigrationGraph.load(join(root, MIGRATIONS, 'meta')).nodes) treeSnapshots.set(n.file, n.snapshot)

  let sweep: { prs: OpenPr[]; selfCreatedAt?: string } | undefined
  if (process.argv.includes('--against-open-prs')) sweep = openPrs(root, arg('--pr'))

  const problems = judgeClaims({
    base,
    baseFiles,
    baseSnapshots,
    added,
    treeSnapshots,
    journalTouched,
    openPrs: sweep?.prs,
    selfCreatedAt: sweep?.selfCreatedAt,
  })
  const addedSql = added.filter(sqlName)
  if (problems.length === 0) {
    console.log(
      `[migration-claims] OK: ${addedSql.join(', ') || '(no SQL)'} can land on ${base}` +
        (sweep ? ` (checked against ${sweep.prs.length} other open PR(s))` : ''),
    )
    return
  }
  console.error(`[migration-claims] ${problems.length} problem(s) with the migrations this branch adds:\n`)
  for (const p of problems) console.error(`  ✗ ${p}\n`)
  console.error('  The procedure, and why: .claude/agents/fragments/_worker-rules.md ("Migrations").')
  process.exit(1)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[migration-claims] could not run: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  })
}

