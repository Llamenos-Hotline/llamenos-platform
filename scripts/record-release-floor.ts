#!/usr/bin/env bun
/**
 * Record the release being prepared as the release floor
 * (`drizzle/compat/release-floor.json`), and drop the contract exemptions its
 * migrations no longer need.
 *
 * Run by knope's `prepare-release` workflow (knope.toml), after PrepareRelease
 * has bumped package.json and before the release commit, so the release PR
 * carries its own floor: once it merges, every migration written after it is
 * judged against what that release ships. A file in the floor is out of the
 * destructive-DDL lint's scope, so its `drizzle/contract.json` entries would
 * be stale and are removed here.
 *
 * Reads only the working tree: no network and no git, so it runs the same
 * under knope, in a test's scratch repo, and on an operator's machine.
 *
 *   bun scripts/record-release-floor.ts [--root <repo>]
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { listMigrationFiles } from './lib/migration-statements'
import {
  CONTRACT_DESCRIPTION,
  FLOOR_DESCRIPTION,
  type DrizzleSnapshot,
  type MigrationContract,
  type ReleaseFloor,
  latestSnapshotFile,
  packageVersion,
  readJson,
  repoPaths,
  serialise,
} from './lib/release-floor'

export function recordReleaseFloor(root: string): { floor: ReleaseFloor; pruned: number } {
  const paths = repoPaths(root)
  const migrations = listMigrationFiles(paths.migrationsDir)
  const snapshotFile = latestSnapshotFile(paths.metaDir)
  const floor: ReleaseFloor = {
    description: FLOOR_DESCRIPTION,
    version: packageVersion(paths.packageJson),
    migrations,
    snapshotFile,
    snapshot: readJson<DrizzleSnapshot>(join(paths.metaDir, snapshotFile)),
  }
  writeFileSync(paths.floor, serialise(floor))

  const shipped = new Set(migrations)
  const contract = readJson<MigrationContract>(paths.contract)
  const kept = contract.exemptions.filter((e) => !shipped.has(e.file))
  writeFileSync(
    paths.contract,
    serialise({ description: CONTRACT_DESCRIPTION, exemptions: kept } satisfies MigrationContract),
  )
  return { floor, pruned: contract.exemptions.length - kept.length }
}

if (import.meta.main) {
  const i = process.argv.indexOf('--root')
  const root = i === -1 ? join(import.meta.dir, '..') : process.argv[i + 1]
  if (root === undefined) {
    console.error('--root needs a directory')
    process.exit(2)
  }
  const { floor, pruned } = recordReleaseFloor(root)
  console.log(
    `[release-floor] recorded ${floor.version}: ${floor.migrations.length} migrations, ` +
      `snapshot ${floor.snapshotFile}; ${pruned} shipped contract exemption(s) removed`,
  )
}
