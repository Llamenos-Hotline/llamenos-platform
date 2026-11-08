import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { DeletionConfirmed } from '@/lib/admin-deletion'
import {
  listShiftOverrides,
  createShiftOverride,
  deleteShiftOverride,
} from '@/lib/api'
import { CalendarX, CalendarOff, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type ShiftOverride = {
  id: string
  hubId: string
  shiftId: string | null
  date: string
  type: string
  userPubkeys: string[] | null
  encryptedNote: string | null
  createdBy: string
  createdAt: string
}

export function OverridesPanel() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const now = new Date()
  const defaultFrom = now.toISOString().slice(0, 10)
  const defaultTo = new Date(now.getFullYear(), now.getMonth() + 2, 0).toISOString().slice(0, 10)
  const [from, setFrom] = useState(defaultFrom)
  const [to, setTo] = useState(defaultTo)
  const [overrides, setOverrides] = useState<ShiftOverride[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [formDate, setFormDate] = useState(defaultFrom)
  const [formType, setFormType] = useState<'cancel' | 'substitute'>('cancel')
  const [saving, setSaving] = useState(false)
  const [confirmingOverride, setConfirmingOverride] = useState<ShiftOverride | null>(null)

  useEffect(() => {
    listShiftOverrides(from, to)
      .then(r => setOverrides(r.overrides))
      .catch(() => toast(t('common.error'), 'error'))
      .finally(() => setLoading(false))
  }, [from, to])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await createShiftOverride({ id: crypto.randomUUID(), date: formDate, type: formType })
      setOverrides(prev => [...prev, res])
      setShowForm(false)
      toast(t('common.success'), 'success')
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string, confirmed: DeletionConfirmed) {
    try {
      await deleteShiftOverride(id, confirmed)
      setOverrides(prev => prev.filter(o => o.id !== id))
    } catch {
      toast(t('common.error'), 'error')
    }
  }

  return (
    <div className="space-y-4">
      {confirmingOverride && (
        <DeletionConfirmed.Dialog
          action="shiftOverride"
          targetId={confirmingOverride.id}
          subject={confirmingOverride.date}
          open
          onOpenChange={(open) => { if (!open) setConfirmingOverride(null) }}
          onConfirmed={(confirmed) => handleDelete(confirmingOverride.id, confirmed)}
        />
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label>{t('common.from')}</Label>
          <Input type="date" value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>{t('common.to')}</Label>
          <Input type="date" value={to} onChange={e => setTo(e.target.value)} />
        </div>
        <Button data-testid="override-create-btn" onClick={() => setShowForm(true)}>
          <CalendarX className="h-4 w-4" />
          {t('shifts.overrides.create')}
        </Button>
      </div>

      {showForm && (
        <Card>
          <CardContent className="pt-4">
            <form data-testid="override-form" onSubmit={handleCreate} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>{t('shifts.overrides.date')}</Label>
                  <Input type="date" value={formDate} onChange={e => setFormDate(e.target.value)} required />
                </div>
                <div className="space-y-1">
                  <Label>{t('shifts.overrides.type')}</Label>
                  <select
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                    value={formType}
                    onChange={e => setFormType(e.target.value as 'cancel' | 'substitute')}
                  >
                    <option value="cancel">{t('shifts.overrides.typeCancel')}</option>
                    <option value="substitute">{t('shifts.overrides.typeSubstitute')}</option>
                  </select>
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={saving}>{saving ? t('common.loading') : t('common.save')}</Button>
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>{t('common.cancel')}</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <div data-testid="override-list" className="space-y-2">
        {loading ? (
          <div className="py-4 text-center text-muted-foreground">{t('common.loading')}</div>
        ) : overrides.length === 0 ? (
          <Card>
            <CardContent>
              <div className="py-8 text-center text-muted-foreground">
                <CalendarOff className="mx-auto mb-2 h-8 w-8 opacity-40" />
                <p>{t('shifts.overrides.empty')}</p>
              </div>
            </CardContent>
          </Card>
        ) : overrides.map(ov => (
          <Card key={ov.id} data-testid="override-card">
            <CardContent>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">{ov.date}</p>
                  <Badge variant={ov.type === 'cancel' ? 'destructive' : 'secondary'} className="mt-1">
                    {ov.type === 'cancel' ? t('shifts.overrides.typeCancel') : t('shifts.overrides.typeSubstitute')}
                  </Badge>
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-destructive hover:text-destructive"
                  data-testid="override-delete-btn"
                  onClick={() => setConfirmingOverride(ov)}
                  aria-label={t('a11y.deleteItem')}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
