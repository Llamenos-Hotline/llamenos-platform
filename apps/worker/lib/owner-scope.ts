/**
 * Storage mapping for a scoped row set (#2463). See packages/shared/owner-scope.ts
 * for the model and docs/architecture/named-owner-scope.md for the plan.
 *
 * NOT YET ENFORCED IN SQL. The target is a `scope` column guarded by a CHECK:
 *
 *   (scope = 'hub'      AND hub_id IS NOT NULL)
 *   OR (scope = 'platform' AND hub_id IS NULL)
 *
 * The migration-safety gate refuses that CHECK on an existing table
 * (`add-constraint-existing`), and its refusal cannot be annotated. Until the
 * operator rules on a remedy, the column does not exist and a row's scope is
 * still stored as "hub_id present or absent". These three functions are the
 * ONLY place that encoding is read or written for a converted row set. Every
 * caller passes an explicit {@link OwnerScope}. When the column lands, these
 * functions change and their callers do not.
 */
import { eq, isNull, type SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { assertNeverScope, hubScope, PLATFORM_SCOPE, type OwnerScope } from '@shared/owner-scope'

/** The row predicate for one scope, over a table's `hub_id` column. */
export function scopeWhere(hubIdColumn: AnyPgColumn, scope: OwnerScope): SQL {
  switch (scope.kind) {
    case 'hub':
      return eq(hubIdColumn, scope.hubId)
    case 'platform':
      return isNull(hubIdColumn)
    default:
      return assertNeverScope(scope)
  }
}

/** The owner columns an INSERT writes for one scope. */
export function scopeColumns(scope: OwnerScope): { hubId: string | null } {
  switch (scope.kind) {
    case 'hub':
      return { hubId: scope.hubId }
    case 'platform':
      return { hubId: null }
    default:
      return assertNeverScope(scope)
  }
}

/**
 * The scope of a stored row. It is the one place where an absent hub id is read
 * as "platform". That is legal only for a row set the plan lists as scoped. For
 * any other table an absent hub id is a bug (#2459), not a scope.
 */
export function scopeOfRow(row: { hubId: string | null }): OwnerScope {
  return row.hubId === null ? PLATFORM_SCOPE : hubScope(row.hubId)
}
