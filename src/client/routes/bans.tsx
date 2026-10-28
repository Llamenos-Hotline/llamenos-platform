import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { useEffect, useState } from 'react'
import { listBans, addBan, removeBan, bulkAddBans, type BanEntry } from '@/lib/api'
import { useToast } from '@/lib/toast'
import { ShieldBan, Plus, Upload, Trash2 } from 'lucide-react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PhoneInput, isValidE164 } from '@/components/phone-input'

export const Route = createFileRoute('/bans')({
  component: BansPage,
})

export function BansPage() {
  const { t } = useTranslation()
  const { isAdmin } = useAuth()
  const { toast } = useToast()
  const [bans, setBans] = useState<BanEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [showBulk, setShowBulk] = useState(false)

  useEffect(() => {
    listBans()
      .then(r => setBans(r.bans))
      .catch(() => toast(t('common.error'), 'error'))
      .finally(() => setLoading(false))
  }, [])

  if (!isAdmin) {
    return <div className="text-muted-foreground">{t('common.accessDenied')}</div>
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldBan className="h-6 w-6 text-primary" />
          <h1 data-testid="page-title" className="text-xl font-bold sm:text-2xl">{t('banList.title')}</h1>
        </div>
        <div className="flex gap-2">
          <Button data-testid="ban-import-btn" variant="outline" onClick={() => setShowBulk(!showBulk)}>
            <Upload className="h-4 w-4" />
            {t('banList.bulkImport')}
          </Button>
          <Button data-testid="ban-add-btn" onClick={() => setShowAdd(!showAdd)}>
            <Plus className="h-4 w-4" />
            {t('banList.addNumber')}
          </Button>
        </div>
      </div>

      {showAdd && (
        <AddBanForm
          onAdded={(ban) => {
            setBans(prev => [ban, ...prev])
            setShowAdd(false)
          }}
          onCancel={() => setShowAdd(false)}
        />
      )}

      {showBulk && (
        <BulkImportForm
          onImported={() => {
            listBans().then(r => setBans(r.bans))
            setShowBulk(false)
          }}
          onCancel={() => setShowBulk(false)}
        />
      )}

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="divide-y divide-border">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 px-6 py-3">
                  <div className="h-4 w-28 animate-pulse rounded bg-muted" />
                  <div className="h-4 w-40 animate-pulse rounded bg-muted" />
                  <div className="h-4 w-20 animate-pulse rounded bg-muted" />
                  <div className="ml-auto h-6 w-6 animate-pulse rounded bg-muted" />
                </div>
              ))}
            </div>
          ) : bans.length === 0 ? (
            <div data-testid="empty-state" className="py-8 text-center text-muted-foreground">
              <ShieldBan className="mx-auto mb-2 h-8 w-8 opacity-40" />
              {t('banList.noEntries')}
            </div>
          ) : (
            <div data-testid="ban-list" className="divide-y divide-border">
              {bans.map(ban => (
                <BanRow
                  key={ban.phoneHash}
                  ban={ban}
                  onRemoved={() => setBans(prev => prev.filter(b => b.phoneHash !== ban.phoneHash))}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function AddBanForm({ onAdded, onCancel }: {
  onAdded: (ban: BanEntry) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [phone, setPhone] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!isValidE164(phone)) {
      toast(t('users.invalidPhone'), 'error')
      return
    }
    setSaving(true)
    try {
      const res = await addBan({ phone, reason })
      onAdded(res.ban)
      toast(t('common.success'), 'success')
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldBan className="h-4 w-4 text-muted-foreground" />
          {t('banList.addNumber')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form data-testid="ban-form" onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ban-phone">{t('banList.phoneNumber')}</Label>
              <PhoneInput
                id="ban-phone"
                value={phone}
                onChange={setPhone}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ban-reason">{t('banList.reason')}</Label>
              <Input
                id="ban-reason"
                value={reason}
                onChange={e => setReason(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button data-testid="form-save-btn" type="submit" disabled={saving}>
              {saving ? t('common.loading') : t('common.save')}
            </Button>
            <Button data-testid="form-cancel-btn" type="button" variant="outline" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function BanRow({ ban, onRemoved }: {
  ban: BanEntry
  onRemoved: () => void
}) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [showConfirm, setShowConfirm] = useState(false)

  return (
    <div data-testid="ban-row" className="flex flex-wrap items-center gap-4 px-4 py-3 sm:px-6">
      <span className="flex-1 text-sm text-muted-foreground">{ban.reason}</span>
      <span className="text-xs text-muted-foreground">
        {new Date(ban.bannedAt).toLocaleDateString()}
      </span>
      <Button
        data-testid="ban-remove-btn"
        variant="ghost"
        size="icon-xs"
        className="text-destructive hover:text-destructive"
        onClick={() => setShowConfirm(true)}
        aria-label={t('a11y.removeItem')}
      >
        <Trash2 className="h-3 w-3" />
      </Button>

      <ConfirmDialog
        open={showConfirm}
        onOpenChange={setShowConfirm}
        title={t('banList.confirmUnban')}
        description={ban.reason}
        confirmLabel={t('banList.removeNumber')}
        onConfirm={async () => {
          try {
            await removeBan(ban.phoneHash)
            onRemoved()
          } catch {
            toast(t('common.error'), 'error')
          }
        }}
      />
    </div>
  )
}

function BulkImportForm({ onImported, onCancel }: {
  onImported: (count: number) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [text, setText] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const phones = text.split('\n').map(l => l.trim()).filter(Boolean)
      const invalid = phones.filter(p => !/^\+\d{7,15}$/.test(p))
      if (invalid.length > 0) {
        toast(`${t('users.invalidPhone')}: ${invalid[0]}`, 'error')
        setSaving(false)
        return
      }
      const res = await bulkAddBans({ phones, reason })
      onImported(res.count)
      toast(t('common.success'), 'success')
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Upload className="h-4 w-4 text-muted-foreground" />
          {t('banList.bulkImport')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form data-testid="ban-bulk-form" onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>{t('banList.bulkImportDescription')}</Label>
            <textarea
              data-testid="ban-bulk-phones"
              value={text}
              onChange={e => setText(e.target.value)}
              rows={6}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bulk-reason">{t('banList.reason')}</Label>
            <Input
              id="bulk-reason"
              value={reason}
              onChange={e => setReason(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button data-testid="form-submit-btn" type="submit" disabled={saving}>
              {saving ? t('common.loading') : t('common.submit')}
            </Button>
            <Button data-testid="form-cancel-btn" type="button" variant="outline" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
