/**
 * Which role a new hub member receives when nobody named one.
 *
 * The hub's template decides, not the code: `defaultMemberRole` on the
 * template manifest (#1446). Before this existed, `redeemInvite` fell back to
 * a hardcoded `role-volunteer`, which is the wrong answer for every template
 * that does not ship that role and silently granted call-answering permission
 * on a crisis line.
 *
 * A template that names no default grants no role. The joiner is still a
 * member of the hub — visible to the operator, assignable — just without
 * permissions until the operator grants some. That is the safe direction.
 */
import type { CaseManagementTemplate } from '../../../packages/protocol/template-types'
import { loadBundledTemplates } from './template-loader'

/** The subset of a role row this resolution needs. */
export interface RoleIdentity {
  id: string
  slug: string
}

/**
 * Resolve the template-designated default member role to a role id.
 *
 * Pure, so the decision is testable without a database: the caller supplies
 * the applied template ids, the template catalog, and the hub's roles.
 *
 * `defaultMemberRole` may name a role by id (`role-volunteer`) or by slug
 * (`volunteer`), because a template's `suggestedRoles` carry slugs and
 * `POST /roles/from-template` mints ids for them. A name that matches no
 * existing role resolves to nothing rather than to a dangling id: a hubRoles
 * entry naming a role that does not exist would grant no permissions anyway,
 * and would be indistinguishable from a typo on inspection.
 */
export function resolveTemplateDefaultMemberRoles(
  appliedTemplateIds: readonly string[],
  templates: readonly CaseManagementTemplate[],
  roles: readonly RoleIdentity[],
): string[] {
  const applied = new Set(appliedTemplateIds)
  for (const template of templates) {
    if (!applied.has(template.id)) continue
    const named = template.defaultMemberRole
    if (!named) continue
    const match = roles.find(r => r.id === named || r.slug === named)
    if (match) return [match.id]
  }
  return []
}

/**
 * What this resolution needs from SettingsService.
 *
 * `appliedTemplates` is stored as untyped JSONB, so it arrives as `unknown[]`
 * and is narrowed here rather than asserted.
 */
export interface DefaultMemberRoleDeps {
  getAppliedTemplates(): Promise<{ appliedTemplates?: unknown[] }>
  getRoles(): Promise<{ roles: readonly RoleIdentity[] }>
}

function appliedTemplateId(record: unknown): string | null {
  if (typeof record !== 'object' || record === null) return null
  const { templateId } = record as { templateId?: unknown }
  return typeof templateId === 'string' ? templateId : null
}

/**
 * Fetch the pieces and resolve. Returns `[]` when no template is applied, when
 * no applied template names a default, or when the named role is absent.
 *
 * Applied templates are recorded server-wide rather than per hub
 * (`AppliedTemplateRecord` carries no `hubId`), so on a multi-hub server this
 * answers from the server's applied templates and not the specific hub's.
 * Narrowing it is part of #1446.
 */
export async function resolveHubDefaultMemberRoles(
  deps: DefaultMemberRoleDeps,
  _hubId: string,
): Promise<string[]> {
  const [{ appliedTemplates = [] }, { roles }] = await Promise.all([
    deps.getAppliedTemplates(),
    deps.getRoles(),
  ])
  const appliedIds = appliedTemplates
    .map(appliedTemplateId)
    .filter((id): id is string => id !== null)
  if (appliedIds.length === 0) return []
  const templates = await loadBundledTemplates()
  return resolveTemplateDefaultMemberRoles(appliedIds, templates, roles)
}
