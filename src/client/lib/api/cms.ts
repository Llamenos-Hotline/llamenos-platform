import { request, hp } from './client'
import type { CreateEntityTypeBody, TemplateSummary } from '@protocol/schemas/entity-schema'
import type { EntityTypeDefinition, EntityFieldDefinition, EnumOption, EntityCategory } from '@protocol/schemas'
import type { EnabledResponse, EntityTemplateCustomizeBody, EntityTypeListResponse, OkResponse, TemplateApplyResponse, TemplateListResponse, UpdateEntityTypeBody } from '@protocol/schemas'

export type { EntityTypeDefinition, EntityFieldDefinition, EnumOption, EntityCategory }
export type { CreateEntityTypeBody }
export type { TemplateSummary }

// --- Case Management (CMS) ---

export async function getCaseManagementEnabled() {
  return request<EnabledResponse>(hp('/settings/cms/case-management'))
}

export async function setCaseManagementEnabled(enabled: boolean) {
  return request<EnabledResponse>(hp('/settings/cms/case-management'), {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })
}

export async function listEntityTypes() {
  return request<EntityTypeListResponse>(hp('/settings/cms/entity-types'))
}

export async function createEntityType(body: CreateEntityTypeBody) {
  return request<EntityTypeDefinition>(hp('/settings/cms/entity-types'), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function updateEntityType(id: string, body: UpdateEntityTypeBody) {
  return request<EntityTypeDefinition>(hp(`/settings/cms/entity-types/${id}`), {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function customizeEntityType(
  id: string,
  body: EntityTemplateCustomizeBody,
) {
  return request<EntityTypeDefinition>(hp(`/settings/cms/entity-types/${id}/customize`), {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function deleteEntityType(id: string) {
  return request<OkResponse>(hp(`/settings/cms/entity-types/${id}`), {
    method: 'DELETE',
  })
}

export async function listTemplates() {
  return request<TemplateListResponse>(hp('/settings/cms/templates'))
}

export async function applyTemplate(templateId: string) {
  return request<TemplateApplyResponse>(hp('/settings/cms/templates/apply'), {
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

// =========================================================================
// Entity Templates (EP06-A1)
// =========================================================================
//
// NOTE: these two functions duplicate listTemplates()/applyTemplate() above
// against the same `/settings/cms/templates*` endpoints with slightly
// different response shapes. Preserved as-is from the original api.ts —
// this split is a mechanical move, not a behavior change or cleanup.

export async function listEntityTemplates(): Promise<TemplateListResponse> {
  return request('/settings/cms/templates')
}

export async function applyEntityTemplate(templateId: string): Promise<TemplateApplyResponse> {
  return request('/settings/cms/templates/apply', {
    method: 'POST',
    body: JSON.stringify({ templateId }),
  })
}
