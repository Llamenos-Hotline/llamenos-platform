/**
 * Template ↔ permission reconciliation gate (#1363).
 *
 * `POST /roles/from-template` 400s an ENTIRE role import when any permission
 * is unknown to the catalog, and a permission rename that forgets the
 * templates surfaces in front of an operator provisioning their hub (#1360:
 * `volunteers:read` → `users:read` broke 10 templates). This suite makes that
 * a CI failure instead, and prints the reverse reports (#1348's class:
 * permissions shipped in roles but guarding nothing, and phantom guards no
 * role can be granted).
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_ROLES, PERMISSION_CATALOG, isValidPermission } from '@shared/permissions'
import {
  auditTemplatePermissions,
  extractGuardCallPermissions,
  extractPermissionLiterals,
  findPhantomGuardPermissions,
  findTemplateUnreachablePermissions,
  findUnenforcedCatalogPermissions,
  type TemplateLike,
} from '@worker/lib/permission-audit'

const REPO_ROOT = join(import.meta.dirname, '../../../..')
const TEMPLATES_DIR = join(REPO_ROOT, 'packages/protocol/templates')
const SERVER_SOURCE_DIRS = [join(REPO_ROOT, 'apps/worker'), join(REPO_ROOT, 'src/server')]

function* walkSourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walkSourceFiles(full)
    else if (entry.endsWith('.ts')) yield full
  }
}

const catalog = new Set<string>(Object.keys(PERMISSION_CATALOG))

const templates: TemplateLike[] = readdirSync(TEMPLATES_DIR)
  .filter(f => f.endsWith('.json'))
  .sort()
  .map(f => JSON.parse(readFileSync(join(TEMPLATES_DIR, f), 'utf8')) as TemplateLike)

const enforced = new Set<string>()
const guardCalls = new Set<string>()
for (const dir of SERVER_SOURCE_DIRS) {
  for (const file of walkSourceFiles(dir)) {
    const source = readFileSync(file, 'utf8')
    for (const p of extractPermissionLiterals(source)) enforced.add(p)
    for (const p of extractGuardCallPermissions(source)) guardCalls.add(p)
  }
}

const issues = auditTemplatePermissions(templates, { catalog, enforced })

describe('shipped template permissions (#1363)', () => {
  it('ships templates with suggested roles (guards against an empty matrix)', () => {
    expect(templates.length).toBeGreaterThan(0)
    expect(templates.some(t => (t.suggestedRoles ?? []).length > 0)).toBe(true)
  })

  it('names only catalog permissions — a stale name here 400s an entire role import', () => {
    const unknown = issues.filter(i => i.kind === 'unknown-permission')
    expect(
      unknown.map(i => `${i.template} / ${i.role}: ${i.permission}`),
    ).toEqual([])
  })

  it('names only permissions the server code enforces', () => {
    const dead = issues.filter(i => i.kind !== 'unknown-permission')
    expect(
      dead.map(i => `[${i.kind}] ${i.template} / ${i.role}: ${i.permission}`),
    ).toEqual([])
  })

  it('catches a stale name injected into a real template (not a config copy)', () => {
    const injected = templates.map(t => ({
      ...t,
      suggestedRoles: (t.suggestedRoles ?? []).map(r => ({ ...r, permissions: [...(r.permissions ?? [])] })),
    }))
    const victim = injected.find(t => (t.suggestedRoles ?? []).length > 0)
    const victimRole = victim?.suggestedRoles?.[0]
    if (!victim || !victimRole) throw new Error('no template role to inject into')
    const historicalStaleName = 'volunteers:read'
    victimRole.permissions = [...(victimRole.permissions ?? []), historicalStaleName]

    const found = auditTemplatePermissions(injected, { catalog, enforced })
    expect(found).toContainEqual({
      kind: 'unknown-permission',
      template: victim.id,
      role: victimRole.slug ?? victimRole.name,
      permission: historicalStaleName,
    })
  })

  it('catches a catalog permission nothing enforces', () => {
    const template: TemplateLike = {
      id: 'injection',
      suggestedRoles: [{ slug: 'r', permissions: ['alpha:beta'] }],
    }
    const found = auditTemplatePermissions([template], {
      catalog: new Set(['alpha:beta']),
      enforced: new Set(),
    })
    expect(found).toContainEqual({
      kind: 'unenforced-permission',
      template: 'injection',
      role: 'r',
      permission: 'alpha:beta',
    })
  })

  it('catches a wildcard whose domain nothing enforces', () => {
    const template: TemplateLike = {
      id: 'injection',
      suggestedRoles: [{ slug: 'r', permissions: ['alpha:*'] }],
    }
    const found = auditTemplatePermissions([template], {
      catalog: new Set(['alpha:beta']),
      enforced: new Set(),
    })
    expect(found).toContainEqual({
      kind: 'unenforced-wildcard-domain',
      template: 'injection',
      role: 'r',
      permission: 'alpha:*',
    })
  })

  it('shipped DEFAULT_ROLES name only catalog permissions', () => {
    const invalid = DEFAULT_ROLES.flatMap(r =>
      r.permissions.filter(p => !isValidPermission(p)).map(p => `${r.slug}: ${p}`),
    )
    expect(invalid).toEqual([])
  })

  it('reports the reverse directions (informational — see CI log)', () => {
    const granted: string[] = []
    for (const t of templates) {
      for (const r of t.suggestedRoles ?? []) granted.push(...(r.permissions ?? []))
    }
    for (const r of DEFAULT_ROLES) granted.push(...r.permissions)

    const unenforcedCatalog = findUnenforcedCatalogPermissions(catalog, enforced)
    const phantomGuards = findPhantomGuardPermissions(guardCalls, catalog)
    const unreachable = findTemplateUnreachablePermissions(catalog, enforced, granted)

    console.info([
      '[permission-audit] catalog permissions enforced nowhere (the #1348 detector):',
      ...unenforcedCatalog.map(p => `  ${p}`),
      '[permission-audit] guard literals missing from the catalog (phantom guards — grantable only via wildcards):',
      ...phantomGuards.map(p => `  ${p}`),
      '[permission-audit] enforced permissions named by no template or default role:',
      ...unreachable.map(p => `  ${p}`),
    ].join('\n'))
  })
})
