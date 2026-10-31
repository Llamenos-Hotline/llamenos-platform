/**
 * The drizzle snapshot of the schema this tree DECLARES
 * (apps/worker/db/schema/*.ts), as drizzle-kit would serialise it. Shared by
 * the generator (`scripts/db-generate.ts`) and the drift check
 * (`scripts/check-migration-drift.ts`), so the two can never disagree about
 * what the declared schema is.
 */
import { generateDrizzleJson } from 'drizzle-kit/api'
import { join } from 'node:path'
import { Glob } from 'bun'

export const SCHEMA_GLOB = 'apps/worker/db/schema/*.ts'

export async function declaredSchemaSnapshot(root = process.cwd()): Promise<Record<string, unknown>> {
  const modules: Record<string, unknown> = {}
  for await (const path of new Glob(SCHEMA_GLOB).scan(root)) {
    Object.assign(modules, await import(join(root, path)))
  }
  return generateDrizzleJson(modules) as unknown as Record<string, unknown>
}
