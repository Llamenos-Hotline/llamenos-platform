import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { useToast } from '@/lib/toast'
import { createReport, getReportTypes, getCustomFields } from '@/lib/api'
import type { ReportType, CustomFieldDefinition } from '@shared/types'
import { fieldMatchesContext } from '@shared/types'
import { encryptMessage } from '@/lib/platform'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Lock, Loader2, Send, FileText } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { CustomFieldInputs, validateCustomFields } from '@/components/notes/custom-field-inputs'
import { activeHubAdminReaders } from '@/lib/admin-recipient'

interface ReportFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (reportId: string) => void
}

export function ReportForm({ open, onOpenChange, onCreated }: ReportFormProps) {
  const { t } = useTranslation()
  const { hasDeviceKey, publicKey, isAdmin } = useAuth()
  const { toast } = useToast()

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [reportTypes, setReportTypes] = useState<ReportType[]>([])
  const [selectedTypeId, setSelectedTypeId] = useState<string>('')
  const [customFields, setCustomFields] = useState<CustomFieldDefinition[]>([])
  const [fieldValues, setFieldValues] = useState<Record<string, string | number | boolean>>({})
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  const selectedType = reportTypes.find(rt => rt.id === selectedTypeId)

  // Filter global fields for report context
  const reportFields = customFields
    .filter(f => fieldMatchesContext(f, 'reports'))
    .filter(f => isAdmin || f.visibleToUsers)

  useEffect(() => {
    if (!open) return
    getReportTypes()
      .then(({ reportTypes: types }) => {
        // Filter out archived types
        const active = types.filter(rt => !rt.isArchived)
        setReportTypes(active)
        // Pre-select the default type
        const defaultType = active.find(rt => rt.isDefault) || active[0]
        if (defaultType) {
          setSelectedTypeId(defaultType.id)
        }
      })
      .catch(() => setReportTypes([]))
    getCustomFields()
      .then(r => setCustomFields(r.fields))
      .catch(() => setCustomFields([]))
  }, [open])

  // Reset field values when type changes
  useEffect(() => {
    setFieldValues({})
  }, [selectedTypeId])

  const resetForm = useCallback(() => {
    setTitle('')
    setBody('')
    setFieldValues({})
    setValidationErrors({})
    // Keep type selection for convenience
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!title.trim() || !body.trim()) {
      toast(t('reports.fillRequired', { defaultValue: 'Please fill in the required fields' }), 'error')
      return
    }

    // Validate required custom fields from report type
    if (selectedType?.fields) {
      for (const field of selectedType.fields) {
        if (field.required) {
          const val = fieldValues[field.name]
          if (val === undefined || val === '' || val === null) {
            toast(t('reports.fillRequired', { defaultValue: 'Please fill in the required fields' }), 'error')
            return
          }
        }
      }
    }

    if (!hasDeviceKey || !publicKey) {
      toast(t('reports.noKeyPair', { defaultValue: 'Encryption key not available' }), 'error')
      return
    }

    // Validate global custom fields
    const errors = validateCustomFields(reportFields, fieldValues, t, { isAdmin })
    setValidationErrors(errors)
    if (Object.keys(errors).length > 0) return

    setSubmitting(true)

    try {
      // Build reader list: reporter + admin decryption key
      const readerPubkeys = [publicKey]
      // Every admin of the hub, not one env-configured key (#1035).
      readerPubkeys.push(...await activeHubAdminReaders())

      // Encrypt body with custom field values as structured payload
      const nonEmptyFields = Object.entries(fieldValues).filter(([, v]) => v !== '' && v !== undefined)
      const payload = nonEmptyFields.length > 0
        ? JSON.stringify({ text: body.trim(), fields: Object.fromEntries(nonEmptyFields) })
        : body.trim()

      const encrypted = await encryptMessage(payload, readerPubkeys)

      const report = await createReport({
        title: title.trim(),
        category: selectedType?.name,
        reportTypeId: selectedTypeId || undefined,
        encryptedContent: encrypted.encryptedContent,
        readerEnvelopes: encrypted.readerEnvelopes,
      })

      toast(t('reports.created', { defaultValue: 'Report submitted' }), 'success')
      resetForm()
      onOpenChange(false)
      onCreated(report.id)
    } catch {
      toast(t('reports.createError', { defaultValue: 'Failed to submit report' }), 'error')
    } finally {
      setSubmitting(false)
    }
  }, [title, body, selectedTypeId, selectedType, fieldValues, reportFields, hasDeviceKey, publicKey, isAdmin, toast, t, resetForm, onOpenChange, onCreated])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{t('reports.newReport', { defaultValue: 'New Report' })}</SheetTitle>
          <SheetDescription>
            <span className="flex items-center gap-1.5">
              <Lock className="h-3 w-3" />
              {t('reports.encryptedNote', { defaultValue: 'Your report is encrypted end-to-end' })}
            </span>
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-4 px-4">
          {/* Report Type Selector */}
          {reportTypes.length > 0 && (
            <div className="space-y-2">
              <Label>{t('reports.typeLabel', { defaultValue: 'Report Type' })}</Label>
              <Select value={selectedTypeId} onValueChange={setSelectedTypeId} disabled={submitting}>
                <SelectTrigger className="w-full" data-testid="report-type-select">
                  <SelectValue placeholder={t('reports.selectType', { defaultValue: 'Select a report type' })} />
                </SelectTrigger>
                <SelectContent>
                  {reportTypes.map(rt => (
                    <SelectItem key={rt.id} value={rt.id}>
                      <span className="flex items-center gap-2">
                        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                        {rt.name}
                        {rt.isDefault && (
                          <Badge variant="secondary" className="text-[9px] ml-1">
                            {t('reportTypes.default', { defaultValue: 'Default' })}
                          </Badge>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedType?.description && (
                <p className="text-xs text-muted-foreground">{selectedType.description}</p>
              )}
            </div>
          )}

          {/* Title */}
          <div className="space-y-2">
            <Label htmlFor="report-title">
              {t('reports.titleLabel', { defaultValue: 'Title' })} *
            </Label>
            <Input
              id="report-title"
              data-testid="report-title-input"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder={t('reports.titlePlaceholder', { defaultValue: 'Brief description of the report' })}
              disabled={submitting}
              maxLength={200}
            />
          </div>

          {/* Custom fields from report type */}
          {selectedType?.fields && selectedType.fields.length > 0 && (
            <div className="space-y-3">
              {selectedType.fields
                .filter(f => f.visibleToUsers)
                .sort((a, b) => a.order - b.order)
                .map(field => (
                  <CustomFieldInput
                    key={field.id}
                    field={field}
                    value={fieldValues[field.name]}
                    onChange={val => setFieldValues(prev => ({ ...prev, [field.name]: val }))}
                    disabled={submitting}
                  />
                ))}
            </div>
          )}

          {/* Body */}
          <div className="space-y-2">
            <Label htmlFor="report-body">
              {t('reports.bodyLabel', { defaultValue: 'Details' })} *
            </Label>
            <Textarea
              id="report-body"
              data-testid="report-body-input"
              value={body}
              onChange={e => setBody(e.target.value)}
              placeholder={t('reports.bodyPlaceholder', { defaultValue: 'Describe the situation in detail...' })}
              disabled={submitting}
              rows={6}
              className="resize-y"
            />
          </div>

          {/* Global custom fields for reports */}
          <CustomFieldInputs
            fields={reportFields}
            values={fieldValues}
            onChange={setFieldValues}
            errors={validationErrors}
            disabled={submitting}
            idPrefix="report"
          />

          <div className="flex justify-end pt-2">
            <Button data-testid="report-form-submit-btn" onClick={handleSubmit} disabled={submitting || !title.trim() || !body.trim()}>
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {t('reports.submit', { defaultValue: 'Submit Report' })}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** Render a single custom field input based on its type */
function CustomFieldInput({ field, value, onChange, disabled }: {
  field: CustomFieldDefinition
  value: string | number | boolean | undefined
  onChange: (value: string | number | boolean) => void
  disabled: boolean
}) {
  const label = `${field.label}${field.required ? ' *' : ''}`

  switch (field.type) {
    case 'text':
      return (
        <div className="space-y-1">
          <Label className="text-sm">{label}</Label>
          <Input
            value={(value as string) || ''}
            onChange={e => onChange(e.target.value)}
            disabled={disabled}
            minLength={field.validation?.minLength}
            maxLength={field.validation?.maxLength}
          />
        </div>
      )
    case 'textarea':
      return (
        <div className="space-y-1">
          <Label className="text-sm">{label}</Label>
          <Textarea
            value={(value as string) || ''}
            onChange={e => onChange(e.target.value)}
            disabled={disabled}
            rows={3}
            className="resize-y"
          />
        </div>
      )
    case 'number':
      return (
        <div className="space-y-1">
          <Label className="text-sm">{label}</Label>
          <Input
            type="number"
            value={value !== undefined ? String(value) : ''}
            onChange={e => onChange(e.target.value ? Number(e.target.value) : '')}
            disabled={disabled}
            min={field.validation?.min}
            max={field.validation?.max}
          />
        </div>
      )
    case 'select':
      return (
        <div className="space-y-1">
          <Label className="text-sm">{label}</Label>
          <Select
            value={(value as string) || ''}
            onValueChange={onChange}
            disabled={disabled}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={`Select ${field.label}`} />
            </SelectTrigger>
            <SelectContent>
              {field.options?.map(opt => (
                <SelectItem key={opt} value={opt}>{opt}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )
    case 'checkbox':
      return (
        <div className="flex items-center gap-2">
          <Switch
            checked={!!value}
            onCheckedChange={onChange}
            disabled={disabled}
          />
          <Label className="text-sm">{label}</Label>
        </div>
      )
    default:
      return null
  }
}
