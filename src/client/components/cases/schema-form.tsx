import { createContext, useContext, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ChevronDown, Lock, Shield, Users } from 'lucide-react'
import { HelpTooltip } from '@/components/ui/help-tooltip'
import { cn } from '@/lib/utils'
import type { EntityTypeDefinition, EntityFieldDefinition } from '@/lib/api'
import { LocationField, type LocationFieldValue } from '@/components/ui/location-field'
import { EntityFileField } from './entity-file-field'
import type { FileFieldValue } from '@protocol/schemas/entity-schema'

export type SchemaFieldValues = Record<string, string | number | boolean | string[]>

interface SchemaFormProps {
  /** The entity type whose fields drive rendering */
  entityType: EntityTypeDefinition
  /** Current form values keyed by field.name */
  values: SchemaFieldValues
  /** Called when a field value changes */
  onChange: (values: SchemaFieldValues) => void
  /** Whether the form is read-only (detail view) */
  readOnly?: boolean
  /** Whether to show access tier indicators next to fields */
  showAccessIndicators?: boolean
  /** Whether the form is disabled (during submit) */
  disabled?: boolean
  /** Which sections start collapsed (by section name) */
  collapsedSections?: Set<string>
  /** Filter to only show fields at these access levels */
  visibleAccessLevels?: Set<string>
  /**
   * The hub the record being edited belongs to (`record.hubId`): a file attached
   * to a field is sealed to that hub's admins and stored in it. Omit it only for
   * a form that creates a new record in the hub being browsed.
   */
  hubId?: string
}

/**
 * The hub of the record being edited, for the fields that store something in it
 * (files). `undefined` for a form that creates a new record in the hub being
 * browsed.
 */
const SchemaFormHubContext = createContext<string | undefined>(undefined)

/**
 * Dynamic form renderer for entity type schemas.
 *
 * Groups fields by `field.section` into collapsible sections.
 * Handles conditional visibility via `field.showWhen` rules.
 * Shows access tier badges next to restricted fields.
 */
export function SchemaForm({
  entityType,
  values,
  onChange,
  readOnly = false,
  showAccessIndicators = false,
  disabled = false,
  collapsedSections,
  visibleAccessLevels,
  hubId,
}: SchemaFormProps) {
  // Group fields by section
  const sections = useMemo(() => {
    const sorted = [...entityType.fields].sort((a, b) => a.order - b.order)
    const groups = new Map<string, EntityFieldDefinition[]>()

    for (const field of sorted) {
      // Skip fields that are filtered by access level
      if (visibleAccessLevels && !visibleAccessLevels.has(field.accessLevel)) {
        continue
      }
      const section = field.section || ''
      const existing = groups.get(section) || []
      existing.push(field)
      groups.set(section, existing)
    }

    return groups
  }, [entityType.fields, visibleAccessLevels])

  const handleFieldChange = (fieldName: string, value: string | number | boolean | string[]) => {
    onChange({ ...values, [fieldName]: value })
  }

  return (
    <SchemaFormHubContext.Provider value={hubId}>
    <div data-testid="schema-form" className="space-y-4">
      {Array.from(sections.entries()).map(([sectionName, fields]) => (
        <SchemaSection
          key={sectionName}
          sectionName={sectionName}
          fields={fields}
          values={values}
          onFieldChange={handleFieldChange}
          readOnly={readOnly}
          showAccessIndicators={showAccessIndicators}
          disabled={disabled}
          defaultCollapsed={collapsedSections?.has(sectionName)}
        />
      ))}
    </div>
    </SchemaFormHubContext.Provider>
  )
}

function SchemaSection({
  sectionName,
  fields,
  values,
  onFieldChange,
  readOnly,
  showAccessIndicators,
  disabled,
  defaultCollapsed,
}: {
  sectionName: string
  fields: EntityFieldDefinition[]
  values: SchemaFieldValues
  onFieldChange: (name: string, value: string | number | boolean | string[]) => void
  readOnly: boolean
  showAccessIndicators: boolean
  disabled: boolean
  defaultCollapsed?: boolean
}) {
  const [isOpen, setIsOpen] = useState(!defaultCollapsed)

  // No section header for the unnamed section
  if (!sectionName) {
    return (
      <div className="space-y-3">
        {fields.map(field => (
          <SchemaFieldRenderer
            key={field.id}
            field={field}
            values={values}
            value={values[field.name]}
            onChange={(v) => onFieldChange(field.name, v)}
            readOnly={readOnly}
            showAccessIndicator={showAccessIndicators}
            disabled={disabled}
          />
        ))}
      </div>
    )
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger
        data-testid={`schema-section-${sectionName.toLowerCase().replace(/\s+/g, '-')}`}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm font-semibold text-muted-foreground hover:bg-accent/50 transition-colors"
      >
        <ChevronDown
          className={cn(
            'h-4 w-4 transition-transform',
            isOpen ? '' : '-rotate-90',
          )}
        />
        {sectionName}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 space-y-3 pl-2 border-l-2 border-border/50 ml-2">
          {fields.map(field => (
            <SchemaFieldRenderer
              key={field.id}
              field={field}
              values={values}
              value={values[field.name]}
              onChange={(v) => onFieldChange(field.name, v)}
              readOnly={readOnly}
              showAccessIndicator={showAccessIndicators}
              disabled={disabled}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Evaluates whether a field should be visible based on its showWhen rule */
function evaluateShowWhen(
  field: EntityFieldDefinition,
  values: SchemaFieldValues,
): boolean {
  if (!field.showWhen) return true
  const { field: depField, operator, value: depValue } = field.showWhen
  const currentValue = values[depField]

  switch (operator) {
    case 'equals':
      return currentValue === depValue
    case 'not_equals':
      return currentValue !== depValue
    case 'contains':
      if (typeof currentValue === 'string' && typeof depValue === 'string') {
        return currentValue.includes(depValue)
      }
      if (Array.isArray(currentValue) && typeof depValue === 'string') {
        return currentValue.includes(depValue)
      }
      return false
    case 'is_set':
      return currentValue !== undefined && currentValue !== '' && currentValue !== false
    default:
      return true
  }
}

function SchemaFieldRenderer({
  field,
  values,
  value,
  onChange,
  readOnly,
  showAccessIndicator,
  disabled,
}: {
  field: EntityFieldDefinition
  values: SchemaFieldValues
  value: string | number | boolean | string[] | undefined
  onChange: (value: string | number | boolean | string[]) => void
  readOnly: boolean
  showAccessIndicator: boolean
  disabled: boolean
}) {
  const isVisible = evaluateShowWhen(field, values)

  if (!isVisible) return null

  const label = field.label + (field.required ? ' *' : '')
  const fieldId = `field-${field.name}`
  const isEditable = !readOnly && field.editableByUsers

  return (
    <div
      data-testid={`schema-field-${field.name}`}
      className={cn(
        'transition-all',
        !isVisible && 'hidden',
      )}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <Label htmlFor={fieldId} className="text-sm">
          {label}
        </Label>
        {showAccessIndicator && field.accessLevel !== 'all' && (
          <>
            <AccessBadge level={field.accessLevel} />
            <HelpTooltip helpKey="schemaFields" side="right" />
          </>
        )}
      </div>
      {field.helpText && (
        <p className="text-xs text-muted-foreground mb-1">{field.helpText}</p>
      )}
      <FieldInput
        field={field}
        fieldId={fieldId}
        value={value}
        onChange={onChange}
        readOnly={!isEditable}
        disabled={disabled}
      />
    </div>
  )
}

function FieldInput({
  field,
  fieldId,
  value,
  onChange,
  readOnly,
  disabled,
}: {
  field: EntityFieldDefinition
  fieldId: string
  value: string | number | boolean | string[] | undefined
  onChange: (value: string | number | boolean | string[]) => void
  readOnly: boolean
  disabled: boolean
}) {
  const formHubId = useContext(SchemaFormHubContext)
  switch (field.type) {
    case 'text':
      return (
        <Input
          id={fieldId}
          data-testid={`input-${field.name}`}
          value={(value as string) ?? ''}
          onChange={e => onChange(e.target.value)}
          readOnly={readOnly}
          disabled={disabled}
          placeholder={field.placeholder}
          minLength={field.validation?.minLength}
          maxLength={field.validation?.maxLength}
          className={cn(readOnly && 'bg-muted/50')}
        />
      )

    case 'textarea':
      return (
        <Textarea
          id={fieldId}
          data-testid={`input-${field.name}`}
          value={(value as string) ?? ''}
          onChange={e => onChange(e.target.value)}
          readOnly={readOnly}
          disabled={disabled}
          placeholder={field.placeholder}
          rows={3}
          className={cn('resize-y', readOnly && 'bg-muted/50')}
        />
      )

    case 'number':
      return (
        <Input
          id={fieldId}
          data-testid={`input-${field.name}`}
          type="number"
          value={value !== undefined && value !== '' ? String(value) : ''}
          onChange={e => {
            const v = e.target.value
            onChange(v === '' ? '' : Number(v))
          }}
          readOnly={readOnly}
          disabled={disabled}
          placeholder={field.placeholder}
          min={field.validation?.min}
          max={field.validation?.max}
          className={cn(readOnly && 'bg-muted/50')}
        />
      )

    case 'select':
      if (readOnly) {
        const selected = field.options?.find(o => o.key === value)
        return (
          <Input
            id={fieldId}
            data-testid={`input-${field.name}`}
            value={selected?.label ?? (value as string) ?? ''}
            readOnly
            disabled={disabled}
            className="bg-muted/50"
          />
        )
      }
      return (
        <Select
          value={(value as string) ?? ''}
          onValueChange={onChange}
          disabled={disabled}
        >
          <SelectTrigger data-testid={`input-${field.name}`} className="w-full">
            <SelectValue placeholder={field.placeholder ?? `Select ${field.label}`} />
          </SelectTrigger>
          <SelectContent>
            {field.options?.map(opt => (
              <SelectItem key={opt.key} value={opt.key}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )

    case 'multiselect': {
      const selectedArr = Array.isArray(value) ? value : []
      if (readOnly) {
        return (
          <div className="flex flex-wrap gap-1">
            {selectedArr.length === 0 && (
              <span className="text-sm text-muted-foreground">--</span>
            )}
            {selectedArr.map(v => {
              const opt = field.options?.find(o => o.key === v)
              return (
                <Badge key={v} variant="secondary" className="text-xs">
                  {opt?.label ?? v}
                </Badge>
              )
            })}
          </div>
        )
      }
      return (
        <div data-testid={`input-${field.name}`} className="space-y-1.5 rounded-md border border-input p-2">
          {field.options?.map(opt => (
            <label key={opt.key} className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={selectedArr.includes(opt.key)}
                disabled={disabled}
                onCheckedChange={checked => {
                  if (checked) {
                    onChange([...selectedArr, opt.key])
                  } else {
                    onChange(selectedArr.filter(v => v !== opt.key))
                  }
                }}
              />
              {opt.label}
            </label>
          ))}
        </div>
      )
    }

    case 'checkbox':
      return (
        <div className="flex items-center gap-2">
          <Switch
            id={fieldId}
            data-testid={`input-${field.name}`}
            checked={!!value}
            onCheckedChange={onChange}
            disabled={readOnly || disabled}
          />
        </div>
      )

    case 'date':
      return (
        <Input
          id={fieldId}
          data-testid={`input-${field.name}`}
          type="datetime-local"
          value={(value as string) ?? ''}
          onChange={e => onChange(e.target.value)}
          readOnly={readOnly}
          disabled={disabled}
          className={cn(readOnly && 'bg-muted/50')}
        />
      )

    case 'location': {
      const locVal = value
        ? (typeof value === 'string' ? JSON.parse(value) as LocationFieldValue : null)
        : null
      if (readOnly) {
        return (
          <Input
            id={fieldId}
            data-testid={`input-${field.name}`}
            value={locVal?.address ?? ''}
            readOnly
            disabled={disabled}
            className="bg-muted/50"
          />
        )
      }
      return (
        <LocationField
          value={locVal}
          onChange={loc => onChange(loc ? JSON.stringify(loc) : '')}
          maxPrecision={field.locationOptions?.maxPrecision ?? 'exact'}
          allowAutocomplete={field.locationOptions?.allowAutocomplete ?? true}
          placeholder={field.placeholder}
          disabled={disabled}
        />
      )
    }

    case 'file': {
      const fileVal = value
        ? (typeof value === 'string' ? JSON.parse(value) as FileFieldValue : (value as unknown) as FileFieldValue)
        : null
      if (readOnly) {
        return (
          <p id={fieldId} className="text-sm text-muted-foreground" data-testid={`input-${field.name}`}>
            {fileVal ? '— file attached —' : '—'}
          </p>
        )
      }
      return (
        <EntityFileField
          hubId={formHubId}
          value={fileVal}
          onChange={(fv: FileFieldValue | null) => onChange(fv ? JSON.stringify(fv) : '')}
          disabled={disabled}
        />
      )
    }

    default:
      return (
        <Input
          id={fieldId}
          data-testid={`input-${field.name}`}
          value={(value as string) ?? ''}
          onChange={e => onChange(e.target.value)}
          readOnly={readOnly}
          disabled={disabled}
          className={cn(readOnly && 'bg-muted/50')}
        />
      )
  }
}

function AccessBadge({ level }: { level: string }) {
  const { t } = useTranslation()

  switch (level) {
    case 'assigned':
      return (
        <Badge
          variant="secondary"
          className="gap-0.5 text-[9px] px-1 py-0 text-purple-600 dark:text-purple-400 border-purple-300 dark:border-purple-700"
          title={t('cases.accessAssigned', { defaultValue: 'Visible to assigned volunteers and admins' })}
        >
          <Users className="h-2.5 w-2.5" />
          {t('cases.assigned', { defaultValue: 'Assigned' })}
        </Badge>
      )
    case 'admin':
      return (
        <Badge
          variant="secondary"
          className="gap-0.5 text-[9px] px-1 py-0 text-red-600 dark:text-red-400 border-red-300 dark:border-red-700"
          title={t('cases.accessAdmin', { defaultValue: 'Admin only' })}
        >
          <Lock className="h-2.5 w-2.5" />
          {t('cases.adminOnly', { defaultValue: 'Admin' })}
        </Badge>
      )
    case 'custom':
      return (
        <Badge
          variant="secondary"
          className="gap-0.5 text-[9px] px-1 py-0 text-orange-600 dark:text-orange-400 border-orange-300 dark:border-orange-700"
          title={t('cases.accessCustom', { defaultValue: 'Restricted to specific roles' })}
        >
          <Shield className="h-2.5 w-2.5" />
          {t('cases.restricted', { defaultValue: 'Restricted' })}
        </Badge>
      )
    default:
      return null
  }
}
