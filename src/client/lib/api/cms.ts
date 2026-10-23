import { request, hp } from './client'
import type { CreateEntityTypeBody, TemplateSummary } from '@protocol/schemas/entity-schema'
import type { EntityTypeDefinition, EntityFieldDefinition, EnumOption, EntityCategory } from '@shared/types'

export type { EntityTypeDefinition, EntityFieldDefinition, EnumOption, EntityCategory }
export type { CreateEntityTypeBody }
export type { TemplateSummary }

// --- Case Management (CMS) ---

export async function getCaseManagementEnabled() {
  return request<{ enabled: boolean }>(hp('/settings/cms/case-management'))
}

export async function setCaseManagementEnabled(enabled: boolean) {
  return request<{ enabled: boolean }>(hp('/settings/cms/case-management'), {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })
}

export async function listEntityTypes() {
  return request<{ entityTypes: EntityTypeDefinition[] }>(hp('/settings/cms/entity-types'))
}

export async function createEntityType(body: CreateEntityTypeBody) {
  return request<EntityTypeDefinition>(hp('/settings/cms/entity-types'), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function updateEntityType(id: string, body: Partial<CreateEntityTypeBody> & { isArchived?: boolean }) {
  return request<EntityTypeDefinition>(hp(`/settings/cms/entity-types/${id}`), {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function customizeEntityType(
  id: string,
  body: import('@protocol/schemas/entity-schema').EntityTemplateCustomizeBody,
) {
  return request<EntityTypeDefinition>(hp(`/settings/cms/entity-types/${id}/customize`), {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function deleteEntityType(id: string) {
  return request<{ ok: boolean }>(hp(`/settings/cms/entity-types/${id}`), {
    method: 'DELETE',
  })
}

export async function listTemplates() {
  return request<{ templates: TemplateSummary[]; appliedTemplateIds?: string[] }>(hp('/settings/cms/templates'))
}

export async function applyTemplate(templateId: string) {
  return request<{ applied: boolean; entityTypes: number }>(hp('/settings/cms/templates/apply'), {
    method: 'POST',
    body: JSON.stringify({ templateId }),
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function getTemplateDetails(templateId: string) {
  return request<{
    id: string
    name: string
    description: string
    suggestedRoles?: Array<{ name: string; slug: string; description: string; permissions: string[] }>
  }>(hp(`/settings/cms/templates/${templateId}`))
}

export async function createRolesFromTemplate(roles: Array<{ name: string; slug: string; description: string; permissions: string[] }>) {
  return request<{ created: Array<{ id: string; name: string }>; count: number }>(hp('/settings/cms/roles/from-template'), {
    method: 'POST',
    body: JSON.stringify({ roles }),
  })
}

// =========================================================================
// Entity Templates (EP06-A1)
// =========================================================================
//
// NOTE: these two functions duplicate listTemplates()/applyTemplate() above
// against the same `/settings/cms/templates*` endpoints with slightly
// different response shapes. Preserved as-is from the original api.ts —
// this split is a mechanical move, not a behavior change or cleanup.

export async function listEntityTemplates(): Promise<{ templates: TemplateSummary[]; appliedTemplateIds: string[] }> {
  return request('/settings/cms/templates')
}

export async function applyEntityTemplate(templateId: string): Promise<{ applied: boolean; entityTypeId: string }> {
  return request('/settings/cms/templates/apply', {
    method: 'POST',
    body: JSON.stringify({ templateId }),
  })
}
