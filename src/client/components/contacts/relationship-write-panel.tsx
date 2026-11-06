import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import {
  createContactRelationship, deleteContactRelationship,
  type ContactRelationship,
} from '@/lib/api'
import { encryptMessage } from '@/lib/platform'
import { RELATIONSHIP_TYPES } from '@protocol/schemas/contact-relationships'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Trash2, Plus, Loader2 } from 'lucide-react'
import { useToast } from '@/lib/toast'
import { hubAdminReaders } from '@/lib/admin-recipient'

interface RelationshipWritePanelProps {
  contactId: string
  relationships: ContactRelationship[]
  onRelationshipsChange: (rels: ContactRelationship[]) => void
  canWrite: boolean
}

export function RelationshipWritePanel({
  contactId, relationships, onRelationshipsChange, canWrite,
}: RelationshipWritePanelProps) {
  const { t } = useTranslation()
    const { toast } = useToast()
  const [adding, setAdding] = useState(false)
  const [targetContactId, setTargetContactId] = useState('')
  const [relType, setRelType] = useState<string>(RELATIONSHIP_TYPES[0])
  const [saving, setSaving] = useState(false)

  async function handleAdd() {
    if (!targetContactId || !relType) return
    setSaving(true)
    try {
      const readerPubkeys: string[] = await hubAdminReaders()
      const encrypted = await encryptMessage('', readerPubkeys)
      const rel = await createContactRelationship(contactId, {
        contactIdB: targetContactId,
        relationshipType: relType,
        direction: 'bidirectional',
        encryptedNotes: encrypted.encryptedContent,
        notesEnvelopes: encrypted.readerEnvelopes,
      })
      onRelationshipsChange([...relationships, rel])
      setAdding(false)
      setTargetContactId('')
    } catch {
      toast(t('contactDirectory.relationshipCreateError', { defaultValue: 'Failed to add relationship' }), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(relId: string) {
    try {
      await deleteContactRelationship(contactId, relId)
      onRelationshipsChange(relationships.filter(r => r.id !== relId))
    } catch {
      toast(t('contactDirectory.relationshipDeleteError', { defaultValue: 'Failed to remove relationship' }), 'error')
    }
  }

  return (
    <div className="space-y-3" data-testid="relationship-write-panel">
      {relationships.map(rel => (
        <div key={rel.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
          <div className="min-w-0 flex-1">
            <p className="font-medium truncate">{rel.targetDisplayName ?? rel.targetContactId ?? '—'}</p>
            <p className="text-xs text-muted-foreground capitalize">{rel.relationshipType.replace(/_/g, ' ')}</p>
          </div>
          {canWrite && (
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => handleDelete(rel.id)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      ))}
      {canWrite && !adding && (
        <Button variant="outline" size="sm" className="gap-1" onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" />
          {t('contactDirectory.addRelationship', { defaultValue: 'Add Relationship' })}
        </Button>
      )}
      {adding && (
        <div className="space-y-2 rounded-md border p-3">
          <Input
            placeholder={t('contactDirectory.contactIdPlaceholder', { defaultValue: 'Contact ID' })}
            value={targetContactId}
            onChange={e => setTargetContactId(e.target.value)}
            disabled={saving}
          />
          <Select value={relType} onValueChange={setRelType}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {RELATIONSHIP_TYPES.map(rt => (
                <SelectItem key={rt} value={rt}>{rt.replace(/_/g, ' ')}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleAdd} disabled={saving || !targetContactId}>
              {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {t('common.save', { defaultValue: 'Save' })}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)} disabled={saving}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
