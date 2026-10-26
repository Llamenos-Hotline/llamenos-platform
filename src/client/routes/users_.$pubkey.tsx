import { createFileRoute, Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { useEffect, useState, useMemo } from 'react'
import {
  listUsers,
  listRoles,
  listAuditLog,
  listShifts,
  updateUser,
  type User,
  type RoleDefinition,
  type AuditLogEntry,
  type Shift,
} from '@/lib/api'
import { rolesConferHubAdmin } from '@shared/permissions'
import { useToast } from '@/lib/toast'
import {
  ArrowLeft,
  ScrollText,
  Clock,
  Shield,
  ShieldCheck,
  Coffee,
  ChevronLeft,
  ChevronRight,
  User as UserIcon,
  Phone,
  Eye,
  EyeOff,
  MessageSquare,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'

const MESSAGING_CHANNELS = ['sms', 'whatsapp', 'signal', 'rcs', 'web'] as const

export const Route = createFileRoute('/users_/$pubkey')({
  component: UserProfilePage,
})

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const

function UserProfilePage() {
  const { t } = useTranslation()
  const { isAdmin } = useAuth()
  const { pubkey } = Route.useParams()
  const { toast } = useToast()
  const [user, setUser] = useState<User | null>(null)
  const [shifts, setShifts] = useState<Shift[]>([])
  const [roles, setRoles] = useState<RoleDefinition[]>([])
  const [auditEntries, setAuditEntries] = useState<AuditLogEntry[]>([])
  const [auditTotal, setAuditTotal] = useState(0)
  const [auditPage, setAuditPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [auditLoading, setAuditLoading] = useState(true)
  const [showPhone, setShowPhone] = useState(false)
  const [savingChannels, setSavingChannels] = useState(false)
  const auditLimit = 20

  // Load user + shifts
  useEffect(() => {
    Promise.all([
      listUsers(),
      listShifts(),
      listRoles(),
    ]).then(([userRes, shiftRes, rolesRes]) => {
      const found = userRes.users.find(u => u.pubkey === pubkey) || null
      setUser(found)
      setShifts(shiftRes.shifts)
      setRoles(rolesRes.roles)
    }).catch(() => toast(t('common.error'), 'error'))
      .finally(() => setLoading(false))
  }, [pubkey, t, toast])

  // Load audit entries for this user
  useEffect(() => {
    setAuditLoading(true)
    listAuditLog({ page: auditPage, limit: auditLimit, actorPubkey: pubkey })
      .then(r => { setAuditEntries(r.entries); setAuditTotal(r.total) })
      .catch(() => toast(t('common.error'), 'error'))
      .finally(() => setAuditLoading(false))
  }, [pubkey, auditPage, t, toast])

  const assignedShifts = useMemo(
    () => shifts.filter(s => s.userPubkeys.includes(pubkey)),
    [shifts, pubkey],
  )

  const holdsAdminRole = user !== null && rolesConferHubAdmin(user.roles, roles)

  if (!isAdmin) {
    return <div className="text-muted-foreground">{t('common.accessDenied')}</div>
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-6 w-48 animate-pulse rounded bg-muted" />
        <div className="h-40 animate-pulse rounded-lg bg-muted" />
        <div className="h-60 animate-pulse rounded-lg bg-muted" />
      </div>
    )
  }

  if (!user) {
    return (
      <div className="space-y-4">
        <Link to="/users" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          {t('nav.users')}
        </Link>
        <div className="py-8 text-center text-muted-foreground">
          {t('common.noData')}
        </div>
      </div>
    )
  }

  const auditTotalPages = Math.ceil(auditTotal / auditLimit)

  function maskedPhone(phone: string) {
    if (!phone || phone.length < 6) return phone
    return phone.slice(0, 3) + '\u2022'.repeat(phone.length - 5) + phone.slice(-2)
  }

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link to="/users" data-testid="back-btn" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        {t('nav.users')}
      </Link>

      {/* User Info Card */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xl font-semibold text-primary">
              {user.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 space-y-3">
              <div>
                <h1 data-testid="volunteer-name" className="text-xl font-bold">{user.name}</h1>
                <code data-testid="volunteer-pubkey" className="text-xs text-muted-foreground">{user.pubkey}</code>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge data-testid="volunteer-role-badge" variant={holdsAdminRole ? 'default' : 'secondary'}>
                  {holdsAdminRole ? (
                    <><ShieldCheck className="h-3 w-3" /> {t('users.roleAdmin')}</>
                  ) : (
                    <><Shield className="h-3 w-3" /> {roles.find(r => r.id === user.roles[0])?.name || '\u2014'}</>
                  )}
                </Badge>
                <Badge data-testid="volunteer-status-badge" variant="outline" className={
                  user.active
                    ? 'border-green-500/50 text-green-700 dark:text-green-400'
                    : 'border-red-500/50 text-red-700 dark:text-red-400'
                }>
                  {user.active ? t('users.active') : t('users.inactive')}
                </Badge>
                {user.onBreak && (
                  <Badge variant="outline" className="border-yellow-500/50 text-yellow-700 dark:text-yellow-400">
                    <Coffee className="h-3 w-3" />
                    {t('dashboard.onBreak')}
                  </Badge>
                )}
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Phone className="h-3.5 w-3.5" />
                  <span className="font-mono text-xs">
                    {showPhone ? user.phone : maskedPhone(user.phone)}
                  </span>
                  <button onClick={() => setShowPhone(!showPhone)} className="text-muted-foreground hover:text-foreground">
                    {showPhone ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  </button>
                </span>
                <span data-testid="volunteer-join-date" className="flex items-center gap-1.5">
                  <UserIcon className="h-3.5 w-3.5" />
                  {t('userProfile.joined')} {new Date(user.createdAt).toLocaleDateString()}
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Shift Assignments */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="h-4 w-4 text-muted-foreground" />
            {t('userProfile.assignedShifts')}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {assignedShifts.length === 0 ? (
            <div className="px-6 pb-6 text-sm text-muted-foreground">
              {t('userProfile.noShifts')}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {assignedShifts.map(shift => (
                <div key={shift.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
                  <span className="text-sm font-medium">{shift.encryptedName}</span>
                  <span className="text-xs text-muted-foreground">
                    {shift.startTime} – {shift.endTime}
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {shift.days.sort((a, b) => a - b).map(d => (
                      <Badge key={d} variant="outline" className="text-[10px]">
                        {t(`shifts.days.${DAY_KEYS[d]}`)}
                      </Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Messaging Channels Configuration */}
      <MessagingChannelsCard
        user={user}
        saving={savingChannels}
        onSave={async (channels, enabled) => {
          setSavingChannels(true)
          try {
            const updated = await updateUser(pubkey, {
              supportedMessagingChannels: channels,
              messagingEnabled: enabled,
            })
            setUser(updated)
            toast(t('userProfile.channelsSaved'), 'success')
          } catch {
            toast(t('common.error'), 'error')
          } finally {
            setSavingChannels(false)
          }
        }}
      />

      {/* Activity / Audit Log */}
      <Card data-testid="volunteer-activity-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ScrollText className="h-4 w-4 text-muted-foreground" />
            {t('userProfile.activity')}
            {auditTotal > 0 && (
              <span className="text-xs font-normal text-muted-foreground">({auditTotal})</span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {auditLoading ? (
            <div className="divide-y divide-border">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 px-6 py-3">
                  <div className="h-4 w-28 animate-pulse rounded bg-muted" />
                  <div className="h-5 w-20 animate-pulse rounded-full bg-muted" />
                  <div className="h-4 w-40 animate-pulse rounded bg-muted" />
                </div>
              ))}
            </div>
          ) : auditEntries.length === 0 ? (
            <div className="px-6 pb-6 text-sm text-muted-foreground">
              {t('userProfile.noActivity')}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {auditEntries.map(entry => (
                <div key={entry.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 sm:px-6">
                  <span className="w-full text-xs text-muted-foreground whitespace-nowrap sm:w-32 sm:shrink-0">
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                  <Badge variant="secondary" className="text-[11px]">
                    {t(`auditLog.events.${entry.action}`, { defaultValue: entry.action })}
                  </Badge>
                  <span className="flex-1 truncate text-xs text-muted-foreground">
                    {Object.entries(entry.details || {})
                      .filter(([k]) => !['ip', 'ua', 'country'].includes(k))
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(', ') || '—'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>

        {auditTotalPages > 1 && (
          <div className="flex items-center justify-center gap-2 border-t border-border py-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAuditPage(p => Math.max(1, p - 1))}
              disabled={auditPage === 1}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-xs text-muted-foreground">{auditPage} / {auditTotalPages}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAuditPage(p => Math.min(auditTotalPages, p + 1))}
              disabled={auditPage === auditTotalPages}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </Card>
    </div>
  )
}

function MessagingChannelsCard({
  user,
  saving,
  onSave,
}: {
  user: User
  saving: boolean
  onSave: (channels: string[], enabled: boolean) => Promise<void>
}) {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState(user.messagingEnabled !== false)
  const [channels, setChannels] = useState<string[]>(
    user.supportedMessagingChannels || []
  )
  const [dirty, setDirty] = useState(false)

  const channelLabels: Record<string, string> = {
    sms: t('userProfile.channelSms'),
    whatsapp: t('userProfile.channelWhatsapp'),
    signal: t('userProfile.channelSignal'),
    rcs: t('userProfile.channelRcs'),
    web: t('userProfile.channelWeb'),
  }

  function toggleChannel(ch: string) {
    setChannels(prev => {
      const next = prev.includes(ch)
        ? prev.filter(c => c !== ch)
        : [...prev, ch]
      setDirty(true)
      return next
    })
  }

  function handleEnabledChange(checked: boolean) {
    setEnabled(checked)
    setDirty(true)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
          {t('userProfile.messagingChannels')}
        </CardTitle>
        <CardDescription>
          {t('userProfile.messagingChannelsDescription')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Messaging Enabled Toggle */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="messaging-enabled">{t('userProfile.messagingEnabled')}</Label>
            <p className="text-xs text-muted-foreground">
              {t('userProfile.messagingEnabledDescription')}
            </p>
          </div>
          <Switch
            id="messaging-enabled"
            checked={enabled}
            onCheckedChange={handleEnabledChange}
          />
        </div>

        {/* Channel Selection */}
        {enabled && (
          <div className="space-y-3">
            <Label>{t('userProfile.selectChannels')}</Label>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {MESSAGING_CHANNELS.map(ch => (
                <label
                  key={ch}
                  className="flex cursor-pointer items-center gap-2 rounded-md border border-border p-3 hover:bg-muted/50"
                >
                  <Checkbox
                    checked={channels.length === 0 || channels.includes(ch)}
                    onCheckedChange={() => toggleChannel(ch)}
                  />
                  <span className="text-sm">{channelLabels[ch]}</span>
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {channels.length === 0
                ? t('userProfile.allChannels')
                : `${channels.length} ${channels.length === 1 ? 'channel' : 'channels'} selected`}
            </p>
          </div>
        )}

        {/* Save Button */}
        {dirty && (
          <Button
            onClick={() => onSave(channels, enabled)}
            disabled={saving}
          >
            {saving ? t('common.loading') : t('common.save')}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
