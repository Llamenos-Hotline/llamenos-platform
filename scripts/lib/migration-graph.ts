/**
 * The drizzle snapshots under drizzle/migrations/meta/ read as a DAG, so two
 * migrations written on two branches with no knowledge of each other can both
 * land, in either order, without either being renumbered or regenerated (#2391).
 *
 * drizzle-kit 0.31 (the current stable line) cannot do this itself. It numbers
 * files from `_journal.json`, takes the last snapshot by filename as the parent
 * of the next one, and aborts `generate` the moment two snapshots share a
 * parent ("... are pointing to a parent snapshot ... which is a collision").
 * Every migration therefore had to be regenerated after the one before it
 * landed, and PRs carrying migrations merged strictly one at a time. drizzle
 * v1 (still beta) fixes this upstream with the same three ideas used here:
 * timestamped names, `prevIds` as a list, and a commutativity check.
 *
 * Two kinds of node:
 *
 *   - LEGACY, `NNNN_snapshot.json`. Written by `drizzle-kit generate` before
 *     the cutover. Their recorded `prevId`s are not a clean chain (0032 and
 *     0043 point at ids no snapshot has), so they are read as a straight line
 *     in filename order. Their recorded `prevId` is ignored here; the claims
 *     guard (`check-migration-claims.ts`) still checks it on a numbered file a
 *     branch adds.
 *   - TIMESTAMPED, `YYYYMMDDHHMMSS_snapshot.json`. Written by
 *     `scripts/db-generate.ts`. `prevIds` names every head the author's tree
 *     had, so generating on a tree with two heads joins them again.
 *
 * Every snapshot is the FULL schema its branch declared once its migration
 * ran. The schema the tree's migrations build is therefore the 3-way merge of
 * the heads over their nearest common ancestor: each head contributes what it
 * changed since then. Two heads that changed the same thing differently do not
 * merge; that is a real conflict between two migrations, and it is reported
 * rather than resolved.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** `0042` — the numbered scheme used up to and including 0070. */
export const LEGACY_PREFIX = /^\d{4}$/
/** `20261030141523` — UTC YYYYMMDDHHMMSS, what db-generate writes. */
export const TIMESTAMP_PREFIX = /^\d{14}$/

/** drizzle-kit's id for "no parent". */
export const ORIGIN_ID = '00000000-0000-0000-0000-000000000000'

/** `0042_foo.sql`, `0042_snapshot.json` → `0042`. */
export function prefixOf(file: string): string | undefined {
  return /^(\d+)_/.exec(file)?.[1]
}

export type SnapshotJson = Record<string, unknown> & { id: string; prevId?: string; prevIds?: string[] }

export interface SnapshotNode {
  /** `0069_snapshot.json`. Files, not ids, identify nodes: a copied snapshot can repeat an id. */
  file: string
  prefix: string
  kind: 'legacy' | 'timestamped'
  id: string
  /** Parent snapshot FILES, as this graph reads them (see the file header). */
  parents: string[]
  snapshot: SnapshotJson
}

/** Keys that identify a snapshot rather than describe a schema. */
const IDENTITY_KEYS = new Set(['id', 'prevId', 'prevIds'])

export function readSnapshotFile(path: string): SnapshotJson {
  return JSON.parse(readFileSync(path, 'utf-8')) as SnapshotJson
}

export class MigrationGraph {
  /** In filename order — the order the runner applies their migrations in. */
  readonly nodes: SnapshotNode[]
  readonly byFile = new Map<string, SnapshotNode>()
  /** Structural problems: dangling parents, duplicate ids, a child sorting before its parent, a bad name. */
  readonly problems: string[] = []

  private constructor(nodes: SnapshotNode[], problems: string[]) {
    this.nodes = nodes
    this.problems.push(...problems)
    for (const n of nodes) this.byFile.set(n.file, n)
  }

  /** Read every `*_snapshot.json` in `metaDir` (a missing directory is an empty graph). */
  static load(metaDir: string): MigrationGraph {
    const files = existsSync(metaDir)
      ? readdirSync(metaDir).filter((f) => f.endsWith('_snapshot.json')).sort()
      : []
    const read = files.map((file) => ({ file, prefix: prefixOf(file) ?? '', snapshot: readSnapshotFile(join(metaDir, file)) }))
    return MigrationGraph.fromSnapshots(read)
  }

  static fromSnapshots(entries: { file: string; snapshot: SnapshotJson }[]): MigrationGraph {
    const sorted = [...entries].sort((a, b) => a.file.localeCompare(b.file))
    const problems: string[] = []
    const fileOfId = new Map<string, string>()
    for (const { file, snapshot } of sorted) {
      const seen = fileOfId.get(snapshot.id)
      if (seen) problems.push(`${file} repeats the id ${snapshot.id} of ${seen}; every snapshot needs its own`)
      else fileOfId.set(snapshot.id, file)
    }

    const nodes: SnapshotNode[] = []
    let previousLegacy: string | undefined
    for (const { file, snapshot } of sorted) {
      const prefix = prefixOf(file) ?? ''
      if (LEGACY_PREFIX.test(prefix)) {
        nodes.push({ file, prefix, kind: 'legacy', id: snapshot.id, parents: previousLegacy ? [previousLegacy] : [], snapshot })
        previousLegacy = file
        continue
      }
      if (!TIMESTAMP_PREFIX.test(prefix)) {
        problems.push(
          `${file}: snapshots are named NNNN_ (before the cutover) or YYYYMMDDHHMMSS_ (bun run db:generate); ` +
            'this is neither',
        )
      }
      const prevIds = Array.isArray(snapshot.prevIds) ? snapshot.prevIds : []
      if (prevIds.length === 0) {
        problems.push(`${file} has no prevIds. A timestamped snapshot names every head it was generated on.`)
      }
      const parents: string[] = []
      for (const id of prevIds) {
        const parent = fileOfId.get(id)
        if (!parent) {
          problems.push(`${file} names parent ${id}, which no snapshot in this tree has`)
        } else if (parent >= file) {
          problems.push(
            `${file} sorts before its own parent ${parent}. The runner applies files by name, so the child ` +
              'would run first everywhere.',
          )
        } else {
          parents.push(parent)
        }
      }
      nodes.push({ file, prefix, kind: 'timestamped', id: snapshot.id, parents, snapshot })
    }
    return new MigrationGraph(nodes, problems)
  }

  /** `file` and every snapshot it descends from. */
  ancestorsOf(file: string): Set<string> {
    const out = new Set<string>()
    const stack = [file]
    while (stack.length > 0) {
      const cur = stack.pop() as string
      if (out.has(cur)) continue
      out.add(cur)
      for (const p of this.byFile.get(cur)?.parents ?? []) stack.push(p)
    }
    return out
  }

  /**
   * Neither descends from the other: the two were written without knowledge
   * of each other, so deployments can apply them in either order.
   */
  concurrent(a: string, b: string): boolean {
    return a !== b && !this.ancestorsOf(a).has(b) && !this.ancestorsOf(b).has(a)
  }

  /** The nodes of `subset` (default: all) that no other node of it descends from. */
  heads(subset?: ReadonlySet<string>): SnapshotNode[] {
    const members = this.nodes.filter((n) => subset === undefined || subset.has(n.file))
    const parentOfSomeone = new Set(members.flatMap((n) => n.parents))
    return members.filter((n) => !parentOfSomeone.has(n.file))
  }

  /**
   * The snapshot a migration file belongs to: its own, or — for a legacy
   * hand-written file, which has none — the newest legacy one before it.
   */
  nodeForMigration(sqlFile: string): SnapshotNode | undefined {
    const prefix = prefixOf(sqlFile)
    if (prefix === undefined) return undefined
    const own = this.nodes.find((n) => n.prefix === prefix)
    if (own || !LEGACY_PREFIX.test(prefix)) return own
    return this.nodes.filter((n) => n.kind === 'legacy' && n.prefix <= prefix).at(-1)
  }

  /** The snapshots a set of applied migration files has built: theirs and every ancestor. */
  builtBy(sqlFiles: Iterable<string>): Set<string> {
    const out = new Set<string>()
    for (const f of sqlFiles) {
      const n = this.nodeForMigration(f)
      if (n) for (const a of this.ancestorsOf(n.file)) out.add(a)
    }
    return out
  }

  /**
   * The schema the migrations of `subset` (default: every node) build, as a
   * drizzle snapshot body, plus every conflict that stopped the heads merging.
   */
  state(subset?: ReadonlySet<string>): { heads: SnapshotNode[]; schema: Record<string, unknown>; conflicts: string[] } {
    const heads = this.heads(subset)
    if (heads.length === 0) return { heads, schema: {}, conflicts: [] }
    if (heads.length === 1) return { heads, schema: schemaBody(heads[0].snapshot), conflicts: [] }

    // The nearest common ancestor: of the nodes every head descends from, the
    // one that sorts last. Each head's changes since then are what it adds.
    const shared = heads
      .map((h) => this.ancestorsOf(h.file))
      .reduce((acc, s) => new Set([...acc].filter((f) => s.has(f))))
    const base = this.nodes.filter((n) => shared.has(n.file)).at(-1)
    const baseBody = base ? schemaBody(base.snapshot) : {}

    const conflicts: string[] = []
    let merged: unknown = schemaBody(heads[0].snapshot)
    heads.slice(1).forEach((h, i) => {
      const earlier = heads.slice(0, i + 1).map((o) => o.file).join(', ')
      merged = merge3(baseBody, merged, schemaBody(h.snapshot), [], (path) =>
        conflicts.push(
          `${path.join('.')} was changed differently by ${h.file} and by ${earlier} since their common ` +
            `ancestor ${base?.file ?? '(an empty schema)'}`,
        ),
      )
    })
    return { heads, schema: (merged ?? {}) as Record<string, unknown>, conflicts }
  }
}

/** A snapshot without the keys that say which snapshot it is. */
export function schemaBody(snapshot: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(snapshot).filter(([k]) => !IDENTITY_KEYS.has(k)))
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
  }
  return false
}

/**
 * Three-way merge of `ours` and `theirs` over `base`. A side equal to the base
 * did not touch it; both equal is agreement; two objects are merged key by key.
 * Anything else — a leaf, or an array (an enum's values, an index's columns),
 * that both changed differently — is a conflict, and `ours` is kept so the
 * caller can keep collecting conflicts. A missing key is `undefined`, so one
 * side deleting what the other edited is a conflict too, and so is both sides
 * creating the same key differently: two `CREATE TABLE foo` with different
 * columns do not add up to one table with both, because the second CREATE is a
 * no-op on a database the first already ran on.
 */
export function merge3(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  path: string[],
  onConflict: (path: string[]) => void,
): unknown {
  if (deepEqual(ours, theirs)) return ours
  if (deepEqual(base, ours)) return theirs
  if (deepEqual(base, theirs)) return ours
  if (isPlainObject(base) && isPlainObject(ours) && isPlainObject(theirs)) {
    const out: Record<string, unknown> = {}
    for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
      const v = merge3(base[key], ours[key], theirs[key], [...path, key], onConflict)
      if (v !== undefined) out[key] = v
    }
    return out
  }
  onConflict(path)
  return ours
}
