/**
 * Permission audit (#1363) — reconciles three sets that were previously
 * answerable to nobody:
 *
 *  1. The catalog (`PERMISSION_CATALOG` in `@shared/permissions`) — the names
 *     `isValidPermission` accepts. `POST /roles/from-template` rejects an
 *     entire import with a 400 when a template names anything outside this
 *     set, so a rename that forgets the templates breaks hub setup (#1360 was
 *     the last instance: `volunteers:read` → `users:read`).
 *  2. The enforced set — permission-shaped string literals appearing in
 *     server source. A catalog entry whose literal never appears in a guard
 *     grants a capability nothing checks (#1348: `shifts:read-own` shipped in
 *     roles while guarding no route).
 *  3. The guard-call set — literals passed to guard functions. A literal
 *     there that is NOT in the catalog is a phantom guard: it can only ever
 *     be satisfied by a `*`/domain-wildcard grant, since no role editor or
 *     template import can name it.
 *
 * All functions are pure so the audit is unit-testable in isolation —
 * including the "inject a stale name" proof that the check reads the real
 * templates rather than a config copy.
 */

import { permissionGranted } from '@shared/permissions'

export interface TemplateRoleLike {
  name?: string
  slug?: string
  permissions?: string[]
}

export interface TemplateLike {
  id?: string
  suggestedRoles?: TemplateRoleLike[]
}

export type PermissionIssueKind =
  | 'unknown-permission'
  | 'unenforced-permission'
  | 'unenforced-wildcard-domain'

export interface PermissionIssue {
  kind: PermissionIssueKind
  template: string
  role: string
  permission: string
}

const PERMISSION_LITERAL_RE = /['"`]([a-z][a-z0-9]*:(?:\*|[a-z][a-z0-9]*(?:-[a-z0-9]*)*))['"`]/g

// Guard functions whose arguments ARE enforced permissions. Matching the call
// (rather than any literal in the file) keeps non-permission literals like
// `node:crypto` or audit action names out of the phantom report.
const GUARD_CALL_RE = /\b(?:requirePermission|requireAnyPermission|checkPermission|permissionGranted|hasPermission|hasHubPermission)\s*\(([^)]*)\)/gs

/**
 * Every permission-shaped string literal in a source text — the "enforced
 * universe". Deliberately over-collects relative to guard call sites because
 * entity-router `permissionOverrides` config blocks carry guard literals
 * outside any guard call. Safe because the audit only ever asks "does this
 * CATALOG permission appear?", and catalog names never collide with
 * non-permission literals like `node:crypto`.
 */
export function extractPermissionLiterals(source: string): Set<string> {
  const found = new Set<string>()
  for (const match of source.matchAll(PERMISSION_LITERAL_RE)) {
    found.add(match[1])
  }
  return found
}

/** Literals passed to guard functions — the precise set for the phantom-guard report. */
export function extractGuardCallPermissions(source: string): Set<string> {
  const found = new Set<string>()
  for (const call of source.matchAll(GUARD_CALL_RE)) {
    for (const literal of call[1].matchAll(PERMISSION_LITERAL_RE)) {
      found.add(literal[1])
    }
  }
  return found
}

/**
 * Audit every permission named by every suggested role of every template.
 * The catalog-validity rule below mirrors `isValidPermission`
 * (`@shared/permissions`) — `*`, `domain:*` over a non-empty catalog domain,
 * or an exact catalog entry — evaluated against the passed catalog so the
 * audit stays pure. A green audit against the real catalog provably means
 * `POST /roles/from-template` cannot 400 on a shipped template.
 */
export function auditTemplatePermissions(
  templates: TemplateLike[],
  opts: { catalog: ReadonlySet<string>; enforced: ReadonlySet<string> },
): PermissionIssue[] {
  const issues: PermissionIssue[] = []
  for (const template of templates) {
    const templateId = template.id ?? '(unknown template)'
    for (const role of template.suggestedRoles ?? []) {
      for (const permission of role.permissions ?? []) {
        const base = { template: templateId, role: role.slug ?? role.name ?? '(unnamed role)', permission }
        if (permission === '*') continue
        if (permission.endsWith(':*')) {
          const domain = permission.slice(0, -2)
          if (![...opts.catalog].some(p => p.startsWith(`${domain}:`))) {
            issues.push({ kind: 'unknown-permission', ...base })
            continue
          }
          const domainEnforced = [...opts.catalog].some(
            p => p.startsWith(`${domain}:`) && opts.enforced.has(p),
          )
          if (!domainEnforced) issues.push({ kind: 'unenforced-wildcard-domain', ...base })
          continue
        }
        if (!opts.catalog.has(permission)) {
          issues.push({ kind: 'unknown-permission', ...base })
          continue
        }
        if (!opts.enforced.has(permission)) {
          issues.push({ kind: 'unenforced-permission', ...base })
        }
      }
    }
  }
  return issues
}

/**
 * Catalog permissions whose literal never appears in server source — the
 * #1348 detector ("shipped in a role, guards nothing"). Report-only: catalog
 * entries may legitimately land before the routes that enforce them.
 */
export function findUnenforcedCatalogPermissions(
  catalog: ReadonlySet<string>,
  enforced: ReadonlySet<string>,
): string[] {
  return [...catalog].filter(p => !enforced.has(p)).sort()
}

/**
 * Guard-call literals that are not catalog permissions — phantom guards,
 * satisfiable only by a `*` or `domain:*` grant. Report-only: entries like
 * the `recovery:*` family are deliberate global-only grants.
 */
export function findPhantomGuardPermissions(
  guardCalls: ReadonlySet<string>,
  catalog: ReadonlySet<string>,
): string[] {
  return [...guardCalls]
    .filter(p => p !== '*' && !p.endsWith(':*') && !catalog.has(p))
    .sort()
}

/**
 * Catalog permissions that ARE enforced but named by no template role and no
 * default role — capabilities only reachable via hand-built custom roles (or
 * super-admin). The reverse direction of #1363's acceptance criteria.
 */
export function findTemplateUnreachablePermissions(
  catalog: ReadonlySet<string>,
  enforced: ReadonlySet<string>,
  granted: readonly string[],
): string[] {
  return [...catalog]
    .filter(p => enforced.has(p) && !permissionGranted([...granted], p))
    .sort()
}
