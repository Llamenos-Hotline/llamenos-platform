import { useTranslation } from 'react-i18next'
import { useState, useCallback } from 'react'
import {
  createRawContact,
  type DirectoryContactType,
  type IdentifierType,
  type DirectoryContact,
  type DirectoryContactSummary,
} from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useToast } from '@/lib/toast'
import { encryptMessage } from '@/lib/platform'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Plus, Trash2, Loader2 } from 'lucide-react'

interface IdentifierRow {
  tempId: string
  type: IdentifierType
  value: string
  isPrimary: boolean
}

interface CreateContactDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (contact: DirectoryContact) => void
}

const CONTACT_TYPES: Array<{ value: DirectoryContactType; labelKey: string; defaultLabel: string }> = [
  { value: 'individual', labelKey: 'contactDirectory.typeIndividual', defaultLabel: 'Individual' },
  { value: 'organization', labelKey: 'contactDirectory.typeOrganization', defaultLabel: 'Organization' },
  { value: 'legal_resource', labelKey: 'contactDirectory.typeLegalResource', defaultLabel: 'Legal Resource' },
  { value: 'service_provider', labelKey: 'contactDirectory.typeServiceProvider', defaultLabel: 'Service Provider' },
]

const IDENTIFIER_TYPES: Array<{ value: IdentifierType; label: string }> = [
  { value: 'phone', label: 'Phone' },
  { value: 'email', label: 'Email' },
  { value: 'signal', label: 'Signal' },
]

export function CreateContactDialog({ open, onOpenChange, onCreated }: CreateContactDialogProps) {
  const { t } = useTranslation()
  const { hasDeviceKey, publicKey, adminDecryptionPubkey } = useAuth()
  const { toast } = useToast()
  const [saving, setSaving] = useState(false)

  const [displayName, setDisplayName] = useState('')
  const [contactType, setContactType] = useState<DirectoryContactType>('individual')
  const [identifiers, setIdentifiers] = useState<IdentifierRow[]>([
    { tempId: crypto.randomUUID(), type: 'phone', value: '', isPrimary: true },
  ])

  const resetForm = useCallback(() => {
    setDisplayName('')
    setContactType('individual')
    setIdentifiers([{ tempId: crypto.randomUUID(), type: 'phone', value: '', isPrimary: true }])
  }, [])

  const handleClose = useCallback((isOpen: boolean) => {
    if (!isOpen) resetForm()
    onOpenChange(isOpen)
  }, [onOpenChange, resetForm])

  const addIdentifier = useCallback(() => {
    setIdentifiers(prev => [
      ...prev,
      { tempId: crypto.randomUUID(), type: 'phone', value: '', isPrimary: false },
    ])
  }, [])

  const removeIdentifier = useCallback((tempId: string) => {
    setIdentifiers(prev => {
      const next = prev.filter(i => i.tempId !== tempId)
      if (next.length > 0 && !next.some(i => i.isPrimary)) {
        next[0].isPrimary = true
      }
      return next
    })
  }, [])

  const updateIdentifier = useCallback((tempId: string, field: keyof IdentifierRow, value: string | boolean) => {
    setIdentifiers(prev => prev.map(i => {
      if (i.tempId !== tempId) {
        if (field === 'isPrimary' && value === true) {
          return { ...i, isPrimary: false }
        }
        return i
      }
      return { ...i, [field]: value }
    }))
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!displayName.trim()) return
    if (!hasDeviceKey || !publicKey) {
      toast(t('contactDirectory.noKeyPair', { defaultValue: 'Encryption key not available' }), 'error')
      return
    }

    setSaving(true)
    try {
      // Build reader pubkeys for E2EE envelopes
      const readerPubkeys = [publicKey]
      if (adminDecryptionPubkey && adminDecryptionPubkey !== publicKey) {
        readerPubkeys.push(adminDecryptionPubkey)
      }

      // Encrypt contact summary (displayName + contactType + tags)
      const summary: DirectoryContactSummary = {
        displayName: displayName.trim(),
        contactType,
        tags: [],
      }
      const encryptedSummary = await encryptMessage(JSON.stringify(summary), readerPubkeys)

      const validIdentifiers = identifiers.filter(i => i.value.trim())

      const raw = await createRawContact({
        hubId: '',
        encryptedSummary: encryptedSummary.encryptedContent,
        summaryEnvelopes: encryptedSummary.readerEnvelopes,
        contactTypeHash: contactType,
        tagHashes: [],
        blindIndexes: {},
      })

      toast(t('contactDirectory.created', { defaultValue: 'Contact created' }))

      // Return a decrypted DirectoryContact for immediate UI display
      const newContact: DirectoryContact = {
        id: raw.id,
        displayName: displayName.trim(),
        contactType,
        tags: [],
        caseCount: 0,
        lastInteractionAt: null,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        canDecrypt: true,
        identifiers: validIdentifiers.map((ident, i) => ({
          id: `${raw.id}-ident-${i}`,
          type: ident.type,
          value: ident.value.trim(),
          isPrimary: ident.isPrimary,
        })),
      }

      onCreated(newContact)
      handleClose(false)
    } catch {
      toast(t('contactDirectory.createError', { defaultValue: 'Failed to create contact' }), 'error')
    } finally {
      setSaving(false)
    }
  }, [displayName, contactType, identifiers, hasDeviceKey, publicKey, adminDecryptionPubkey, toast, t, onCreated, handleClose])

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent data-testid="create-contact-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('contactDirectory.newContact', { defaultValue: 'New Contact' })}</DialogTitle>
          <DialogDescription>
            {t('contactDirectory.newContactDescription', { defaultValue: 'Add a new contact to the directory.' })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Display Name */}
          <div className="space-y-2">
            <Label htmlFor="contact-name">{t('contactDirectory.displayName', { defaultValue: 'Display Name' })}</Label>
            <Input
              id="contact-name"
              data-testid="contact-name-input"
              placeholder={t('contactDirectory.displayNamePlaceholder', { defaultValue: 'Enter name...' })}
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              autoFocus
            />
          </div>

          {/* Contact Type */}
          <div className="space-y-2">
            <Label>{t('contactDirectory.contactType', { defaultValue: 'Contact Type' })}</Label>
            <Select value={contactType} onValueChange={v => setContactType(v as DirectoryContactType)}>
              <SelectTrigger data-testid="contact-type-select" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTACT_TYPES.map(ct => (
                  <SelectItem key={ct.value} value={ct.value}>
                    {t(ct.labelKey, { defaultValue: ct.defaultLabel })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Identifiers */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t('contactDirectory.identifiers', { defaultValue: 'Identifiers' })}</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="add-identifier-btn"
                onClick={addIdentifier}
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                {t('contactDirectory.addIdentifier', { defaultValue: 'Add' })}
              </Button>
            </div>

            <div className="space-y-2">
              {identifiers.map(ident => (
                <div key={ident.tempId} data-testid="identifier-row" className="flex items-center gap-2">
                  <Select
                    value={ident.type}
                    onValueChange={v => updateIdentifier(ident.tempId, 'type', v)}
                  >
                    <SelectTrigger data-testid="identifier-type-select" size="sm" className="w-24 shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {IDENTIFIER_TYPES.map(it => (
                        <SelectItem key={it.value} value={it.value}>{it.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Input
                    data-testid="identifier-value-input"
                    placeholder={ident.type === 'email' ? 'email@example.com' : ident.type === 'phone' ? '+1...' : 'signal...'}
                    value={ident.value}
                    onChange={e => updateIdentifier(ident.tempId, 'value', e.target.value)}
                    className="flex-1"
                  />

                  <div className="flex items-center gap-1.5 shrink-0">
                    <Checkbox
                      data-testid="identifier-primary-checkbox"
                      checked={ident.isPrimary}
                      onCheckedChange={checked => updateIdentifier(ident.tempId, 'isPrimary', checked === true)}
                    />
                    <span className="text-xs text-muted-foreground">
                      {t('contactDirectory.primary', { defaultValue: 'Primary' })}
                    </span>
                  </div>

                  {identifiers.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      data-testid="remove-identifier-btn"
                      onClick={() => removeIdentifier(ident.tempId)}
                      aria-label={t('common.remove', { defaultValue: 'Remove' })}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleClose(false)} disabled={saving}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            data-testid="create-contact-submit"
            onClick={handleSubmit}
            disabled={!displayName.trim() || saving}
          >
            {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            {t('contactDirectory.create', { defaultValue: 'Create Contact' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
