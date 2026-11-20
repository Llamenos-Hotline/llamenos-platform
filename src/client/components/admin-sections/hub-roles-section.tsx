import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { useAuth } from '@/lib/auth'
import { RolesSection as RolesSectionInner } from '@/components/admin-settings/roles-section'
import {
  listTemplates,
  getTemplateDetails,
  listHubRoles,
  createHubRole,
  type TemplateSummary,
} from '@/lib/api'
import { getActiveHub, NoActiveHubError } from '@/lib/api/client'
import { readableRoles, sealHubRoleField } from '@/lib/role-vocabulary'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { LayoutTemplate, Loader2, Check } from 'lucide-react'

interface SuggestedRole {
  name: string
  slug: string
  description: string
  permissions: string[]
}

export function HubRolesSection() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { hasPermission } = useAuth()
  const canManageRoles = hasPermission('system:manage-roles')

  const [importOpen, setImportOpen] = useState(false)
  const [templates, setTemplates] = useState<TemplateSummary[]>([])
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null)
  const [suggestedRoles, setSuggestedRoles] = useState<SuggestedRole[]>([])
  const [selectedRoleSlugs, setSelectedRoleSlugs] = useState<Set<string>>(new Set())
  const [loadingTemplates, setLoadingTemplates] = useState(false)
  const [loadingRoles, setLoadingRoles] = useState(false)
  const [importing, setImporting] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  const openImportDialog = useCallback(async () => {
    setImportOpen(true)
    setSelectedTemplate(null)
    setSuggestedRoles([])
    setSelectedRoleSlugs(new Set())
    setLoadingTemplates(true)
    try {
      const { templates: t } = await listTemplates()
      setTemplates(t.filter(tmpl => tmpl.suggestedRoleCount > 0))
    } catch {
      toast(t('common.error', { defaultValue: 'Error' }), 'error')
    } finally {
      setLoadingTemplates(false)
    }
  }, [toast, t])

  const selectTemplate = useCallback(async (templateId: string) => {
    setSelectedTemplate(templateId)
    setLoadingRoles(true)
    try {
      const detail = await getTemplateDetails(templateId)
      const roles = detail.suggestedRoles ?? []
      setSuggestedRoles(roles)
      setSelectedRoleSlugs(new Set(roles.map(r => r.slug)))
    } catch {
      toast(t('common.error', { defaultValue: 'Error' }), 'error')
    } finally {
      setLoadingRoles(false)
    }
  }, [toast, t])

  const toggleRole = useCallback((slug: string) => {
    setSelectedRoleSlugs(prev => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }, [])

  /**
   * A template's suggested roles are public constants, but which of them THIS
   * hub adopted is not: each is sealed under the hub key here and created like
   * any other hub role, so the server never writes their names (#2780). A role
   * whose name the hub already uses is skipped — compared by the opened name,
   * because there is no plaintext slug left to compare.
   */
  const handleImport = useCallback(async () => {
    const rolesToImport = suggestedRoles.filter(r => selectedRoleSlugs.has(r.slug))
    if (rolesToImport.length === 0) return

    setImporting(true)
    try {
      // Every imported role is sealed under, and created in, the same hub.
      const hubId = getActiveHub()
      if (!hubId) throw new NoActiveHubError('/settings/roles')
      const existing = await readableRoles((await listHubRoles(hubId)).roles)
      const taken = new Set(existing.filter(r => r.readable).map(r => r.displayName.trim().toLowerCase()))
      let count = 0
      for (const role of rolesToImport) {
        const key = role.name.trim().toLowerCase()
        if (taken.has(key)) continue
        await createHubRole(hubId, {
          permissions: role.permissions,
          encryptedName: await sealHubRoleField(hubId, role.name),
          ...(role.description ? { encryptedDescription: await sealHubRoleField(hubId, role.description) } : {}),
        })
        taken.add(key)
        count++
      }
      if (count > 0) {
        toast(t('roles.importSuccess', { count, defaultValue: '{{count}} role(s) imported' }), 'success')
      } else {
        toast(t('roles.importAllExist', { defaultValue: 'All selected roles already exist' }), 'info')
      }
      setImportOpen(false)
      setRefreshKey(prev => prev + 1)
    } catch (err) {
      console.error('[roles] importing template roles failed', err)
      toast(t('common.error', { defaultValue: 'Error' }), 'error')
    } finally {
      setImporting(false)
    }
  }, [suggestedRoles, selectedRoleSlugs, toast, t])

  return (
    <>
      <RolesSectionInner
        key={refreshKey}
        expanded={true}
        onToggle={() => {}}
        statusSummary={t('roles.description', { defaultValue: 'Define roles and assign permissions to control access across your hotline.' })}
      />

      {canManageRoles && (
        <Button
          variant="outline"
          data-testid="import-template-roles-btn"
          onClick={openImportDialog}
          className="mt-3"
        >
          <LayoutTemplate className="h-4 w-4 mr-1" />
          {t('roles.importFromTemplate', { defaultValue: 'Import from template' })}
        </Button>
      )}

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('roles.importDialog.title', { defaultValue: 'Import roles from template' })}</DialogTitle>
            <DialogDescription>
              {t('roles.importDialog.description', { defaultValue: 'Select roles to import from the template. Existing roles with the same slug will be skipped.' })}
            </DialogDescription>
          </DialogHeader>

          {loadingTemplates ? (
            <div className="flex items-center gap-2 py-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm text-muted-foreground">{t('common.loading', { defaultValue: 'Loading...' })}</span>
            </div>
          ) : !selectedTemplate ? (
            <div className="space-y-2 max-h-[300px] overflow-y-auto">
              {templates.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">{t('roles.importDialog.noTemplates', { defaultValue: 'No templates available' })}</p>
              ) : (
                templates.map(tmpl => (
                  <button
                    key={tmpl.id}
                    type="button"
                    className="w-full text-left p-3 rounded-md border hover:bg-muted/50 transition-colors"
                    data-testid={`template-option-${tmpl.id}`}
                    onClick={() => selectTemplate(tmpl.id)}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{tmpl.name}</span>
                      <Badge variant="outline" className="text-xs">
                        {t('roles.suggestedRoleCount', { count: tmpl.suggestedRoleCount, defaultValue: '{{count}} roles' })}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{tmpl.description}</p>
                  </button>
                ))
              )}
            </div>
          ) : loadingRoles ? (
            <div className="flex items-center gap-2 py-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm text-muted-foreground">{t('common.loading', { defaultValue: 'Loading...' })}</span>
            </div>
          ) : (
            <div className="space-y-2 max-h-[300px] overflow-y-auto">
              {suggestedRoles.map(role => (
                <label
                  key={role.slug}
                  className="flex items-center gap-3 p-3 rounded-md border cursor-pointer hover:bg-muted/30 transition-colors"
                  data-testid={`template-role-${role.slug}`}
                >
                  <input
                    type="checkbox"
                    checked={selectedRoleSlugs.has(role.slug)}
                    onChange={() => toggleRole(role.slug)}
                    className="h-4 w-4 rounded border-input accent-primary shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{role.name}</span>
                      <Badge variant="outline" className="text-xs">
                        {role.permissions.length} {t('roles.permissionCount', { count: role.permissions.length, defaultValue: '{{count}} permissions' })}
                      </Badge>
                    </div>
                    {role.description && (
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">{role.description}</p>
                    )}
                  </div>
                </label>
              ))}
            </div>
          )}

          <DialogFooter>
            {selectedTemplate && !loadingRoles && (
              <>
                <Button variant="ghost" onClick={() => setSelectedTemplate(null)}>
                  {t('common.back', { defaultValue: 'Back' })}
                </Button>
                <Button
                  data-testid="import-roles-confirm-btn"
                  onClick={handleImport}
                  disabled={importing || selectedRoleSlugs.size === 0}
                >
                  {importing ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-1" />
                  ) : (
                    <Check className="h-4 w-4 mr-1" />
                  )}
                  {t('roles.importSelected', { count: selectedRoleSlugs.size, defaultValue: 'Import {{count}} role(s)' })}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
