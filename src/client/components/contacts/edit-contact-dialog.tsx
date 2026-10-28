import { useTranslation } from 'react-i18next'
import { useState, useCallback, useEffect } from 'react'
import {
  updateDirectoryContact,
  type DirectoryContact,
  type RawContact,
  type DirectoryContactSummary,
} from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useToast } from '@/lib/toast'
import { encryptMessage } from '@/lib/platform'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2 } from 'lucide-react'

interface EditContactDialogProps {
  contact: DirectoryContact
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpdated: (contact: RawContact) => void
}

export function EditContactDialog({ contact, open, onOpenChange, onUpdated }: EditContactDialogProps) {
  const { t } = useTranslation()
  const { publicKey, adminDecryptionPubkey } = useAuth()
  const { toast } = useToast()
  const [saving, setSaving] = useState(false)
  const [displayName, setDisplayName] = useState('')

  useEffect(() => {
    if (!open) return
    setDisplayName(contact.displayName ?? '')
  }, [open, contact])

  const handleSave = useCallback(async () => {
    if (!displayName.trim()) return
    setSaving(true)
    try {
      const readerPubkeys: string[] = publicKey ? [publicKey] : []
      if (adminDecryptionPubkey && adminDecryptionPubkey !== publicKey) {
        readerPubkeys.push(adminDecryptionPubkey)
      }

      const summary: DirectoryContactSummary = {
        displayName: displayName.trim(),
        contactType: contact.contactType,
        tags: [],
      }
      const encryptedSummary = await encryptMessage(JSON.stringify(summary), readerPubkeys)

      const updated = await updateDirectoryContact(contact.id, {
        encryptedSummary: encryptedSummary.encryptedContent,
        summaryEnvelopes: encryptedSummary.readerEnvelopes,
      })
      toast(t('contactDirectory.updated', { defaultValue: 'Contact updated' }))
      onUpdated(updated)
      onOpenChange(false)
    } catch {
      toast(t('contactDirectory.editError', { defaultValue: 'Failed to update contact' }), 'error')
    } finally {
      setSaving(false)
    }
  }, [displayName, contact, publicKey, adminDecryptionPubkey, onUpdated, onOpenChange, t, toast])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('contactDirectory.editContact', { defaultValue: 'Edit Contact' })}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>{t('contactDirectory.displayName', { defaultValue: 'Display Name' })}</Label>
            <Input
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              disabled={saving}
              onKeyDown={e => e.key === 'Enter' && !saving && displayName.trim() && handleSave()}
              data-testid="edit-contact-name"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button onClick={handleSave} disabled={saving || !displayName.trim()}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('common.save', { defaultValue: 'Save' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
