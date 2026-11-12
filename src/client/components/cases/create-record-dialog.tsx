import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { useToast } from '@/lib/toast'
import {
  createRecord,
  listEntityTypes,
  type EntityTypeDefinition,
  type CreateRecordBody,
} from '@/lib/api'
import { sealCase } from '@/lib/platform'
import { NoAdminReaderError, resolveCreationReaders } from '@/lib/record-recipients'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Lock, Loader2, Plus } from 'lucide-react'
import { SchemaForm, type SchemaFieldValues } from './schema-form'

interface CreateRecordDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (recordId: string) => void
  /** Pre-select an entity type */
  defaultEntityTypeId?: string
}

/**
 * Sheet/dialog for creating a new case record.
 * 1. Select entity type (if hub has multiple)
 * 2. Fill in title + description
 * 3. SchemaForm renders entity type fields
 * 4. Submit encrypts and creates the record
 */
export function CreateRecordDialog({
  open,
  onOpenChange,
  onCreated,
  defaultEntityTypeId,
}: CreateRecordDialogProps) {
  const { t } = useTranslation()
  const { hasDeviceKey, publicKey, adminDecryptionPubkey } = useAuth()
  const { toast } = useToast()

  const [entityTypes, setEntityTypes] = useState<EntityTypeDefinition[]>([])
  const [selectedTypeId, setSelectedTypeId] = useState<string>('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [fieldValues, setFieldValues] = useState<SchemaFieldValues>({})
  const [submitting, setSubmitting] = useState(false)
  const [loadingTypes, setLoadingTypes] = useState(false)

  const selectedType = entityTypes.find(et => et.id === selectedTypeId)

  // Load entity types when dialog opens
  useEffect(() => {
    if (!open) return
    setLoadingTypes(true)
    listEntityTypes()
      .then(({ entityTypes: types }) => {
        const active = types.filter(et => !et.isArchived)
        setEntityTypes(active)
        // Pre-select
        if (defaultEntityTypeId) {
          setSelectedTypeId(defaultEntityTypeId)
        } else if (active.length === 1) {
          setSelectedTypeId(active[0].id)
        }
      })
      .catch(() => {
        toast(t('cases.loadTypesError', { defaultValue: 'Failed to load entity types' }), 'error')
      })
      .finally(() => setLoadingTypes(false))
  }, [open, defaultEntityTypeId, t, toast])

  // Reset form values when type changes
  useEffect(() => {
    setFieldValues({})
  }, [selectedTypeId])

  const resetForm = useCallback(() => {
    setTitle('')
    setDescription('')
    setFieldValues({})
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!selectedType) {
      toast(t('cases.selectTypeFirst', { defaultValue: 'Please select an entity type' }), 'error')
      return
    }
    if (!title.trim()) {
      toast(t('cases.titleRequired', { defaultValue: 'Title is required' }), 'error')
      return
    }

    // Note: Schema-defined required fields are validated in the detail panel
    // during editing, not during initial creation. The create dialog requires
    // only a title to allow fast case creation in urgent situations.

    if (!hasDeviceKey || !publicKey) {
      toast(t('cases.noKeyPair', { defaultValue: 'Encryption key not available' }), 'error')
      return
    }

    setSubmitting(true)

    try {
      // The creator is the record's first assignee. Each payload is sealed to
      // its own tier (see record-recipients.ts), so the volunteers and
      // editRoles holders the server names can open what they work on.
      const assignedTo = [publicKey]
      const readers = await resolveCreationReaders({
        entityTypeId: selectedType.id,
        assignedTo,
        authorPubkey: publicKey,
        adminDecryptionPubkey,
      })

      // Encrypt summary (title + description + status + severity)
      const summary = JSON.stringify({
        title: title.trim(),
        description: description.trim(),
        status: selectedType.statuses.find(s => s.value === selectedType.defaultStatus)?.label ?? selectedType.defaultStatus,
        severity: selectedType.defaultSeverity
          ? selectedType.severities?.find(s => s.value === selectedType.defaultSeverity)?.label ?? selectedType.defaultSeverity
          : undefined,
      })
      const encryptedSummary = await sealCase('summary', summary, readers.summary)

      // Encrypt field values if any are set
      const nonEmptyFields = Object.entries(fieldValues).filter(
        ([, v]) => v !== '' && v !== undefined && v !== false,
      )
      let encryptedFields: Awaited<ReturnType<typeof sealCase>> | undefined
      if (nonEmptyFields.length > 0) {
        const fieldsPayload = JSON.stringify(Object.fromEntries(nonEmptyFields))
        encryptedFields = await sealCase('fields', fieldsPayload, readers.fields)
      }

      // Build the blind index status hash (use the default status value as a simple hash for now)
      // In production, this would use HMAC with the hub key for blind indexing
      const statusHash = selectedType.defaultStatus

      const body: CreateRecordBody = {
        entityTypeId: selectedType.id,
        statusHash,
        severityHash: selectedType.defaultSeverity,
        encryptedSummary: encryptedSummary.encryptedContent,
        summaryEnvelopes: encryptedSummary.readerEnvelopes,
        ...(encryptedFields && {
          encryptedFields: encryptedFields.encryptedContent,
          fieldEnvelopes: encryptedFields.readerEnvelopes,
        }),
        assignedTo,
      }

      const record = await createRecord(body)

      toast(t('cases.created', { defaultValue: 'Case created' }), 'success')
      resetForm()
      onOpenChange(false)
      // Delay onCreated to let the Sheet close animation complete before
      // triggering a list refresh (prevents overlay from blocking clicks)
      setTimeout(() => onCreated(record.id), 350)
    } catch (err) {
      toast(
        err instanceof NoAdminReaderError
          ? t('cases.noAdminRecipient')
          : t('cases.createError', { defaultValue: 'Failed to create case' }),
        'error',
      )
    } finally {
      setSubmitting(false)
    }
  }, [
    selectedType, title, description, fieldValues,
    hasDeviceKey, publicKey, adminDecryptionPubkey,
    toast, t, resetForm, onOpenChange, onCreated,
  ])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{t('cases.newCase', { defaultValue: 'New Case' })}</SheetTitle>
          <SheetDescription>
            <span className="flex items-center gap-1.5">
              <Lock className="h-3 w-3" />
              {t('cases.encryptedNote', { defaultValue: 'Case data is encrypted end-to-end' })}
            </span>
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-4 px-4">
          {/* Entity Type Selector */}
          {loadingTypes ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('common.loading')}
            </div>
          ) : entityTypes.length > 1 ? (
            <div className="space-y-2">
              <Label>{t('cases.entityType', { defaultValue: 'Case Type' })}</Label>
              <Select
                value={selectedTypeId}
                onValueChange={setSelectedTypeId}
                disabled={submitting}
              >
                <SelectTrigger data-testid="case-type-select" className="w-full">
                  <SelectValue placeholder={t('cases.selectType', { defaultValue: 'Select a case type' })} />
                </SelectTrigger>
                <SelectContent>
                  {entityTypes.map(et => (
                    <SelectItem key={et.id} value={et.id} data-testid={`case-type-option-${et.name}`}>
                      <span className="flex items-center gap-2">
                        {et.color && (
                          <span
                            className="inline-block h-3 w-3 rounded-full shrink-0"
                            style={{ backgroundColor: et.color }}
                          />
                        )}
                        {et.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedType?.description && (
                <p className="text-xs text-muted-foreground">{selectedType.description}</p>
              )}
            </div>
          ) : entityTypes.length === 1 ? (
            <div data-testid="case-type-single" className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
              {entityTypes[0].color && (
                <span
                  className="inline-block h-3 w-3 rounded-full shrink-0"
                  style={{ backgroundColor: entityTypes[0].color }}
                />
              )}
              <span className="font-medium">{entityTypes[0].label}</span>
            </div>
          ) : null}

          {/* Title */}
          {selectedType && (
            <>
              <div className="space-y-2">
                <Label htmlFor="case-title">
                  {t('cases.titleLabel', { defaultValue: 'Title' })} *
                </Label>
                <Input
                  id="case-title"
                  data-testid="case-title-input"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder={t('cases.titlePlaceholder', { defaultValue: 'Brief case description' })}
                  disabled={submitting}
                  maxLength={200}
                />
              </div>

              {/* Description */}
              <div className="space-y-2">
                <Label htmlFor="case-description">
                  {t('cases.descriptionLabel', { defaultValue: 'Description' })}
                </Label>
                <Textarea
                  id="case-description"
                  data-testid="case-description-input"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder={t('cases.descriptionPlaceholder', { defaultValue: 'Additional context...' })}
                  disabled={submitting}
                  rows={3}
                  className="resize-y"
                />
              </div>

              {/* Entity type schema fields */}
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

              <div className="flex justify-end pt-2">
                <Button
                  data-testid="case-create-submit"
                  onClick={handleSubmit}
                  disabled={submitting || !title.trim() || !selectedTypeId}
                >
                  {submitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  {t('cases.create', { defaultValue: 'Create Case' })}
                </Button>
              </div>
            </>
          )}

          {/* No entity types configured */}
          {!loadingTypes && entityTypes.length === 0 && (
            <div className="flex flex-col items-center py-8 text-center text-muted-foreground">
              <p className="text-sm">
                {t('cases.noEntityTypes', { defaultValue: 'No case types configured.' })}
              </p>
              <p className="mt-1 text-xs">
                {t('cases.noEntityTypesHint', { defaultValue: 'An admin needs to apply a template or configure entity types in Hub Settings.' })}
              </p>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
