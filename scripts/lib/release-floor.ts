/**
 * The release floor: what the previous release shipped, recorded so CI can
 * judge new migrations against it without network access.
 *
 * During every upgrade the previous release (N-1) runs against the schema the
 * new one (N) migrates: Helm's RollingUpdate keeps the old pod serving while
 * the new pod migrates, and a rollback boots N-1 on N's schema. So a migration
 * is safe only if N-1 can still read and write through it.
 * `drizzle/compat/release-floor.json` says what N-1 is: its version, the
 * migration files it shipped, and the drizzle snapshot of its schema.
 *
 * Written by `scripts/record-release-floor.ts`, which knope's
 * `prepare-release` workflow runs (knope.toml), so a release PR records itself
 * as the floor for everything merged after it. Read by
 * `scripts/check-migration-safety.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SnapshotColumn {
  name: string
  type: string
  primaryKey: boolean
  notNull: boolean
  default?: unknown
  identity?: unknown
  generated?: unknown
}

export interface SnapshotTable {
  name: string
  schema: string
  columns: Record<string, SnapshotColumn>
}

export interface SnapshotEnum {
  name: string
  schema: string
  values: string[]
}

export interface SnapshotRelation {
  name: string
  schema: string
  columns?: Record<string, SnapshotColumn>
}

/** The parts of a drizzle-kit (dialect postgresql, version 7) snapshot this tooling reads. */
export interface DrizzleSnapshot {
  tables: Record<string, SnapshotTable>
  enums: Record<string, SnapshotEnum>
  views?: Record<string, SnapshotRelation>
  sequences?: Record<string, SnapshotRelation>
  schemas?: Record<string, string>
}

export interface ReleaseFloor {
  description: string
  /** The release this floor describes; equals package.json's version on main. */
  version: string
  /** Every migration file that release shipped, in application order. */
  migrations: string[]
  /** The drizzle snapshot file (under drizzle/migrations/meta/) the release ended on. */
  snapshotFile: string
  /** That snapshot's content, verbatim. */
  snapshot: DrizzleSnapshot
}

/** One verified exemption from the destructive-DDL lint. */
export interface ContractExemption {
  file: string
  statementIndex: number
  object: string
  reason: string
}

export interface MigrationContract {
  description: string
  exemptions: ContractExemption[]
}

export const FLOOR_DESCRIPTION =
  'The previous release, which runs against the schema this tree migrates. Written by ' +
  "knope's prepare-release (scripts/record-release-floor.ts); never edit by hand. " +
  'See docs/runbooks/migrations.md.'

export const CONTRACT_DESCRIPTION =
  'Destructive migration statements whose object the release floor no longer declares. ' +
  'Each entry is verified by scripts/check-migration-safety.ts, never trusted, and is ' +
  'removed once its file ships. See docs/runbooks/migrations.md.'

export function repoPaths(root: string) {
  const migrationsDir = join(root, 'drizzle', 'migrations')
  return {
    migrationsDir,
    metaDir: join(migrationsDir, 'meta'),
    floor: join(root, 'drizzle', 'compat', 'release-floor.json'),
    contract: join(root, 'drizzle', 'contract.json'),
    packageJson: join(root, 'package.json'),
  }
}

/**
 * The newest drizzle snapshot: the last `NNNN_snapshot.json` by filename,
 * the same rule `scripts/check-migration-drift.ts` uses for its baseline.
 */
export function latestSnapshotFile(metaDir: string): string {
  const snapshots = readdirSync(metaDir)
    .filter((f) => f.endsWith('_snapshot.json'))
    .sort()
  const latest = snapshots.at(-1)
  if (!latest) throw new Error(`no *_snapshot.json in ${metaDir}`)
  return latest
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T
}

export function packageVersion(packageJsonPath: string): string {
  const { version } = readJson<{ version?: unknown }>(packageJsonPath)
  if (typeof version !== 'string') throw new Error(`${packageJsonPath} has no version string`)
  return version
}

/** Stable on-disk form: two-space JSON with a trailing newline. */
export function serialise(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}
