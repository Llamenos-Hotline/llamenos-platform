import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { useToast } from '@/lib/toast'
import {
  createCaseFromReport,
  convertReportToEntity,
  listEntityTypes,
  type EntityTypeDefinition,
  type CreateRecordBody,
} from '@/lib/api'
import { encryptMessage } from '@/lib/platform'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SchemaForm, type SchemaFieldValues } from './schema-form'
import { Lock, Loader2, Plus, ArrowRight } from 'lucide-react'

interface TriageCaseCreationPanelProps {
  reportId: string
  onCaseCreated: (recordId: string) => void
}

/**
 * Inline panel for creating a case record from a triage report.
 * Mirrors the logic of CreateRecordDialog but rendered inline (no sheet/dialog).
 */
export function TriageCaseCreationPanel({ reportId, onCaseCreated }: TriageCaseCreationPanelProps) {
  const { t } = useTranslation()
  const { hasDeviceKey, publicKey, adminDecryptionPubkey } = useAuth()
  const { toast } = useToast()

  const [entityTypes, setEntityTypes] = useState<EntityTypeDefinition[]>([])
  const [selectedTypeId, setSelectedTypeId] = useState<string>('')
  const [title, setTitle] = useState('')
  const [fieldValues, setFieldValues] = useState<SchemaFieldValues>({})
  const [submitting, setSubmitting] = useState(false)
  const [converting, setConverting] = useState(false)
  const [loadingTypes, setLoadingTypes] = useState(true)

  const selectedType = entityTypes.find(et => et.id === selectedTypeId)

  useEffect(() => {
    setLoadingTypes(true)
    listEntityTypes()
      .then(({ entityTypes: types }) => {
        const active = types.filter(et => !et.isArchived)
        setEntityTypes(active)
        if (active.length === 1) {
          setSelectedTypeId(active[0].id)
        }
      })
      .catch(() => {
        toast(t('cases.loadTypesError', { defaultValue: 'Failed to load entity types' }), 'error')
      })
      .finally(() => setLoadingTypes(false))
  }, [t, toast])

  useEffect(() => {
    setFieldValues({})
  }, [selectedTypeId])

  const handleSubmit = useCallback(async () => {
    if (!selectedType || !title.trim() || !hasDeviceKey || !publicKey) return

    setSubmitting(true)
    try {
      const readerPubkeys = [publicKey]
      if (adminDecryptionPubkey && adminDecryptionPubkey !== publicKey) {
        readerPubkeys.push(adminDecryptionPubkey)
      }

      const summary = JSON.stringify({
        title: title.trim(),
        description: '',
        status: selectedType.statuses.find(s => s.value === selectedType.defaultStatus)?.label ?? selectedType.defaultStatus,
      })
      const encryptedSummary = await encryptMessage(summary, readerPubkeys)

      const nonEmptyFields = Object.entries(fieldValues).filter(
        ([, v]) => v !== '' && v !== undefined && v !== false,
      )
      let encryptedFields: Awaited<ReturnType<typeof encryptMessage>> | undefined
      if (nonEmptyFields.length > 0) {
        const fieldsPayload = JSON.stringify(Object.fromEntries(nonEmptyFields))
        encryptedFields = await encryptMessage(fieldsPayload, readerPubkeys)
      }

      const body: CreateRecordBody = {
        entityTypeId: selectedType.id,
        statusHash: selectedType.defaultStatus,
        severityHash: selectedType.defaultSeverity,
        encryptedSummary: encryptedSummary.encryptedContent,
        summaryEnvelopes: encryptedSummary.readerEnvelopes,
        ...(encryptedFields && {
          encryptedFields: encryptedFields.encryptedContent,
          fieldEnvelopes: encryptedFields.readerEnvelopes,
        }),
        assignedTo: [publicKey],
      }

      const record = await createCaseFromReport(reportId, body)
      toast(t('triage.caseCreated', { defaultValue: 'Case created and linked to report' }), 'success')
      setTitle('')
      setFieldValues({})
      onCaseCreated(record.id)
    } catch {
      toast(t('triage.createError', { defaultValue: 'Failed to create case from report' }), 'error')
    } finally {
      setSubmitting(false)
    }
  }, [selectedType, title, fieldValues, hasDeviceKey, publicKey, adminDecryptionPubkey, reportId, toast, t, onCaseCreated])

  const handleAtomicConvert = useCallback(async () => {
    if (!selectedTypeId) return
    setConverting(true)
    try {
      const result = await convertReportToEntity({
        reportId,
        entityTypeId: selectedTypeId,
      })
      toast(t('triage.converted', { defaultValue: 'Converted to entity' }), 'success')
      onCaseCreated(result.recordId)
    } catch {
      toast(t('triage.convertError', { defaultValue: 'Failed to convert report' }), 'error')
    } finally {
      setConverting(false)
    }
  }, [selectedTypeId, reportId, toast, t, onCaseCreated])

  return (
    <div data-testid="triage-create-case-panel" className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          {t('triage.createCase', { defaultValue: 'Create Case from Report' })}
        </h3>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Lock className="h-3 w-3" />
          {t('triage.e2ee', { defaultValue: 'E2EE' })}
        </span>
      </div>

      {loadingTypes ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('common.loading')}
        </div>
      ) : entityTypes.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('cases.noEntityTypes', { defaultValue: 'No case types configured.' })}
        </p>
      ) : (
        <>
          {/* Entity type selector */}
          {entityTypes.length > 1 && (
            <div className="space-y-1.5">
              <Label className="text-xs">{t('cases.entityType', { defaultValue: 'Case Type' })}</Label>
              <Select
                value={selectedTypeId}
                onValueChange={setSelectedTypeId}
                disabled={submitting}
              >
                <SelectTrigger data-testid="triage-entity-type-select" className="w-full" size="sm">
                  <SelectValue placeholder={t('cases.selectType', { defaultValue: 'Select a case type' })} />
                </SelectTrigger>
                <SelectContent>
                  {entityTypes.map(et => (
                    <SelectItem key={et.id} value={et.id} data-testid={`triage-entity-type-option-${et.name}`}>
                      <span className="flex items-center gap-2">
                        {et.color && (
                          <span
                            className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: et.color }}
                          />
                        )}
                        {et.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Single type info */}
          {entityTypes.length === 1 && (
            <div className="flex items-center gap-2 text-sm">
              {entityTypes[0].color && (
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: entityTypes[0].color }}
                />
              )}
              <span className="font-medium">{entityTypes[0].label}</span>
            </div>
          )}

          {/* Title input */}
          {selectedType && (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor="triage-case-title">
                  {t('cases.titleLabel', { defaultValue: 'Title' })} *
                </Label>
                <Input
                  id="triage-case-title"
                  data-testid="triage-case-title-input"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder={t('triage.titlePlaceholder', { defaultValue: 'Case title...' })}
                  disabled={submitting}
                  maxLength={200}
                  className="h-8 text-sm"
                />
              </div>

              {/* Schema fields */}
              {selectedType.fields.length > 0 && (
                <div className="space-y-2">
                  <div className="h-px bg-border" />
                  <SchemaForm
                    entityType={selectedType}
                    values={fieldValues}
                    onChange={setFieldValues}
                    disabled={submitting}
                    showAccessIndicators
                  />
                </div>
              )}

              <Button
                data-testid="convert-to-entity-btn"
                size="sm"
                variant="default"
                onClick={handleAtomicConvert}
                disabled={converting || submitting || !selectedTypeId}
                className="w-full"
              >
                {converting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ArrowRight className="h-3.5 w-3.5" />
                )}
                {t('triage.convertToEntity', { defaultValue: 'Convert to Entity' })}
              </Button>
              <Button
                data-testid="triage-create-case-btn"
                size="sm"
                variant="outline"
                onClick={handleSubmit}
                disabled={submitting || converting || !title.trim() || !selectedTypeId}
                className="w-full"
              >
                {submitting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                {t('triage.createCaseBtn', { defaultValue: 'Create Case (E2EE)' })}
              </Button>
            </>
          )}
        </>
      )}
    </div>
  )
}
