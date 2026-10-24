import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useRelaySubscription } from '@/lib/relay/hooks'
import { useConfig } from '@/lib/config'
import { useShiftStatus } from '@/lib/hooks'
import {
  KIND_SHIFT_CLOCK_IN,
  KIND_SHIFT_CLOCK_OUT,
  KIND_SHIFT_OVERRIDE_CREATED,
  KIND_SHIFT_REQUEST_RECEIVED,
  KIND_SHIFT_REQUEST_REVIEWED,
} from '@shared/event-kinds'
import {
  useShifts,
  useFallbackGroup,
  useRingGroups,
  useShiftOverrides,
  useMyAvailabilityBlocks,
  useShiftRequests,
  useActiveShifts,
  useCreateShift,
  useUpdateShift,
  useDeleteShift,
  useSetFallbackGroup,
  useCreateRingGroup,
  useDeleteRingGroup,
  useAddRingGroupMembers,
  useRemoveRingGroupMembers,
  useClockIn,
  useClockOut,
  useCreateShiftOverride,
  useDeleteShiftOverride,
  useCreateAvailabilityBlock,
  useDeleteAvailabilityBlock,
  useApproveShiftRequest,
  useRejectShiftRequest,
  shiftKeys,
} from '@/lib/queries/shifts'
import { listUsers, type Shift, type User } from '@/lib/api'
import { z } from 'zod'
import { createShiftBodySchema } from '@protocol/schemas/shifts'
import { useToast } from '@/lib/toast'
import { CalendarPlus, Clock, Users, Pencil, Trash2, LifeBuoy, UserPlus, UserMinus, ShieldCheck, CalendarX, CalendarOff, Activity, CheckCircle, XCircle, LogIn, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { UserMultiSelect } from '@/components/user-multi-select'

export const Route = createFileRoute('/shifts')({
  component: ShiftsPage,
})

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const
const SHIFT_KINDS = [KIND_SHIFT_CLOCK_IN, KIND_SHIFT_CLOCK_OUT, KIND_SHIFT_OVERRIDE_CREATED, KIND_SHIFT_REQUEST_RECEIVED, KIND_SHIFT_REQUEST_REVIEWED]

type Tab = 'schedule' | 'ring-groups' | 'overrides' | 'availability' | 'requests' | 'active'

type RingGroupDetail = {
  id: string
  hubId: string
  encryptedName: string
  members: Array<{ pubkey: string; addedBy: string; createdAt: string }>
  createdAt: string
}

function ShiftsPage() {
  const { t } = useTranslation()
  const { isAdmin, hasPermission } = useAuth()
  const { toast } = useToast()
  const { currentHubId } = useConfig()
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<Tab>('schedule')
  // Server-derived: the clock-in row outlives this component, a local flag did not.
  const { clockedIn, clockedInAt: clockedInAtIso } = useShiftStatus()
  const clockedInAt = useMemo(() => (clockedInAtIso ? new Date(clockedInAtIso) : null), [clockedInAtIso])

  const clockInMutation = useClockIn()
  const clockOutMutation = useClockOut()

  // WS-driven cache invalidation for all shift events
  useRelaySubscription(currentHubId, SHIFT_KINDS, (_kind, content) => {
    const type = content.type as string
    if (type === 'shift:clockIn' || type === 'shift:clockOut') {
      queryClient.invalidateQueries({ queryKey: shiftKeys.active() })
      queryClient.invalidateQueries({ queryKey: shiftKeys.myStatus() })
    } else if (type === 'shift:overrideCreated') {
      queryClient.invalidateQueries({ queryKey: shiftKeys.all })
    } else if (type === 'shift:requestReceived' || type === 'shift:requestReviewed') {
      queryClient.invalidateQueries({ queryKey: shiftKeys.requests() })
      queryClient.invalidateQueries({ queryKey: shiftKeys.list() })
    }
  })

  const canViewShifts = isAdmin || hasPermission('shifts:read')

  if (!canViewShifts) {
    return <div className="text-muted-foreground">{t('common.accessDenied')}</div>
  }

  const tabs: Array<{ id: Tab; label: string; adminOnly?: boolean }> = [
    { id: 'schedule', label: t('shifts.schedule') },
    { id: 'ring-groups', label: t('shifts.ringGroups.title'), adminOnly: true },
    { id: 'overrides', label: t('shifts.overrides.title'), adminOnly: true },
    { id: 'availability', label: t('shifts.availability.title') },
    { id: 'requests', label: t('shifts.requests.title'), adminOnly: true },
    { id: 'active', label: t('shifts.active.title'), adminOnly: true },
  ]

  const visibleTabs = tabs.filter(tab => !tab.adminOnly || isAdmin)

  async function handleClockToggle() {
    try {
      if (clockedIn) {
        await clockOutMutation.mutateAsync()
      } else {
        await clockInMutation.mutateAsync()
      }
    } catch {
      toast(clockedIn ? t('dashboard.errorClockOut') : t('dashboard.errorClockIn'), 'error')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Clock className="h-6 w-6 text-primary" />
          <h1 data-testid="page-title" className="text-xl font-bold sm:text-2xl">{t('shifts.title')}</h1>
        </div>
        <div className="flex items-center gap-2">
          {clockedIn && clockedInAt && (
            <ShiftTimer startedAt={clockedInAt} />
          )}
          <Button
            variant={clockedIn ? 'default' : 'outline'}
            size="sm"
            data-testid="clock-toggle-btn"
            onClick={handleClockToggle}
            className={clockedIn ? 'bg-green-600 hover:bg-green-700' : ''}
          >
            {clockedIn ? <LogOut className="h-3.5 w-3.5" /> : <LogIn className="h-3.5 w-3.5" />}
            {clockedIn ? t('dashboard.clockOut') : t('dashboard.clockIn')}
          </Button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex flex-wrap gap-1 border-b pb-0">
        {visibleTabs.map(tab => (
          <button
            key={tab.id}
            data-testid={`shifts-tab-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
            className={`rounded-t px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? 'border-b-2 border-primary text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'schedule' && <ScheduleTab isAdmin={isAdmin} toast={toast} t={t} />}
      {activeTab === 'ring-groups' && isAdmin && <RingGroupsTab toast={toast} t={t} />}
      {activeTab === 'overrides' && isAdmin && <OverridesTab toast={toast} t={t} />}
      {activeTab === 'availability' && <AvailabilityTab toast={toast} t={t} />}
      {activeTab === 'requests' && isAdmin && <RequestsTab toast={toast} t={t} />}
      {activeTab === 'active' && isAdmin && <ActiveTab toast={toast} t={t} />}
    </div>
  )
}

// ============================================================================
// Schedule Tab (existing shift CRUD + fallback)
// ============================================================================

function ScheduleTab({ isAdmin, toast, t }: { isAdmin: boolean; toast: ReturnType<typeof useToast>['toast']; t: ReturnType<typeof useTranslation>['t'] }) {
  const [users, setUsers] = useState<User[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editingShift, setEditingShift] = useState<Shift | null>(null)

  const { data: shifts = [], isLoading } = useShifts()
  const { data: fallback = [] } = useFallbackGroup()
  const createShiftMutation = useCreateShift()
  const updateShiftMutation = useUpdateShift()
  const deleteShiftMutation = useDeleteShift()
  const setFallbackMutation = useSetFallbackGroup()

  useEffect(() => {
    listUsers().then(r => setUsers(r.users)).catch(() => {})
  }, [])

  async function handleSaveFallback(selected: string[]) {
    try {
      await setFallbackMutation.mutateAsync(selected)
    } catch {
      toast(t('common.error'), 'error')
    }
  }

  return (
    <div className="space-y-6">
      {isAdmin && (
        <div className="flex justify-end">
          <Button data-testid="shift-create-btn" onClick={() => { setShowForm(true); setEditingShift(null) }}>
            <CalendarPlus className="h-4 w-4" />
            {t('shifts.createShift')}
          </Button>
        </div>
      )}

      {(showForm || editingShift) && (
        <ShiftForm
          shift={editingShift}
          users={users}
          onSave={async (data) => {
            try {
              if (editingShift) {
                await updateShiftMutation.mutateAsync({ id: editingShift.id, data })
              } else {
                await createShiftMutation.mutateAsync({ ...data, id: crypto.randomUUID() } as z.infer<typeof createShiftBodySchema>)
              }
              setShowForm(false)
              setEditingShift(null)
              toast(t('common.success'), 'success')
            } catch {
              toast(t('common.error'), 'error')
            }
          }}
          onCancel={() => { setShowForm(false); setEditingShift(null) }}
          t={t}
        />
      )}

      <div data-testid="shift-list" className="space-y-3">
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Card key={i}><CardContent className="space-y-2">
                <div className="h-5 w-40 animate-pulse rounded bg-muted" />
                <div className="h-4 w-24 animate-pulse rounded bg-muted" />
              </CardContent></Card>
            ))}
          </div>
        ) : shifts.length === 0 ? (
          <Card><CardContent>
            <div className="py-8 text-center text-muted-foreground">
              <Clock className="mx-auto mb-2 h-8 w-8 opacity-40" />
              {t('shifts.noShifts')}
            </div>
          </CardContent></Card>
        ) : (
          shifts.map(shift => (
            <Card key={shift.id} data-testid="shift-card" data-shift-id={shift.id}>
              <CardContent>
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-medium">{shift.encryptedName}</h3>
                    <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                      <Clock className="h-3.5 w-3.5" />
                      {shift.startTime} - {shift.endTime}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {shift.days.map(d => (
                        <Badge key={d} variant="secondary">{t(`shifts.days.${DAY_KEYS[d]}`)}</Badge>
                      ))}
                    </div>
                    <p data-testid="shift-volunteer-count" className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Users className="h-3 w-3" />
                      {shift.userPubkeys.length} {t('shifts.users').toLowerCase()}
                    </p>
                  </div>
                  {isAdmin && (
                    <div className="flex gap-1">
                      <Button data-testid="shift-edit-btn" variant="ghost" size="icon-xs" onClick={() => setEditingShift(shift)} aria-label={t('a11y.editItem')}>
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button
                        data-testid="shift-delete-btn"
                        variant="ghost"
                        size="icon-xs"
                        className="text-destructive hover:text-destructive"
                        aria-label={t('a11y.deleteItem')}
                        onClick={async () => {
                          try {
                            await deleteShiftMutation.mutateAsync(shift.id)
                          } catch {
                            toast(t('common.error'), 'error')
                          }
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {isAdmin && (
        <Card data-testid="fallback-group-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <LifeBuoy className="h-4 w-4 text-muted-foreground" />
              {t('shifts.fallbackGroup')}
            </CardTitle>
            <CardDescription>{t('shifts.fallbackDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <UserMultiSelect
              users={users.filter(u => u.active)}
              selected={fallback}
              onSelectionChange={handleSaveFallback}
            />
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ============================================================================
// Ring Groups Tab
// ============================================================================

function RingGroupsTab({ toast, t }: { toast: ReturnType<typeof useToast>['toast']; t: ReturnType<typeof useTranslation>['t'] }) {
  const [users, setUsers] = useState<User[]>([])
  const [editingGroup, setEditingGroup] = useState<RingGroupDetail | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [nameInput, setNameInput] = useState('')

  const { data: groups = [], isLoading } = useRingGroups()
  const createMutation = useCreateRingGroup()
  const deleteMutation = useDeleteRingGroup()
  const addMembersMutation = useAddRingGroupMembers()
  const removeMembersMutation = useRemoveRingGroupMembers()

  useEffect(() => {
    listUsers().then(r => setUsers(r.users)).catch(() => {})
  }, [])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!nameInput.trim()) return
    try {
      const res = await createMutation.mutateAsync({ id: crypto.randomUUID(), encryptedName: nameInput.trim() })
      setEditingGroup({ ...res, members: res.members })
      setNameInput('')
      setShowForm(false)
      toast(t('common.success'), 'success')
    } catch {
      toast(t('common.error'), 'error')
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteMutation.mutateAsync(id)
      if (editingGroup?.id === id) setEditingGroup(null)
    } catch {
      toast(t('common.error'), 'error')
    }
  }

  async function handleAddMembers(groupId: string, pubkeys: string[]) {
    try {
      const res = await addMembersMutation.mutateAsync({ id: groupId, pubkeys })
      setEditingGroup({ ...res, members: res.members })
    } catch {
      toast(t('common.error'), 'error')
    }
  }

  async function handleRemoveMember(groupId: string, pubkey: string) {
    try {
      const res = await removeMembersMutation.mutateAsync({ id: groupId, pubkeys: [pubkey] })
      setEditingGroup({ ...res, members: res.members })
    } catch {
      toast(t('common.error'), 'error')
    }
  }

  if (isLoading) return <div className="py-8 text-center text-muted-foreground">{t('common.loading')}</div>

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button data-testid="ring-group-create-btn" onClick={() => { setShowForm(true); setNameInput('') }}>
          <UserPlus className="h-4 w-4" />
          {t('shifts.ringGroups.create')}
        </Button>
      </div>

      {showForm && (
        <Card>
          <CardContent className="pt-4">
            <form data-testid="ring-group-form" onSubmit={handleCreate} className="flex gap-2">
              <Input
                data-testid="ring-group-name-input"
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                placeholder={t('shifts.ringGroups.name')}
                required
              />
              <Button type="submit" disabled={createMutation.isPending}>{createMutation.isPending ? t('common.loading') : t('common.save')}</Button>
              <Button type="button" variant="outline" onClick={() => setShowForm(false)}>{t('common.cancel')}</Button>
            </form>
          </CardContent>
        </Card>
      )}

      <div data-testid="ring-group-list" className="space-y-3">
        {groups.length === 0 ? (
          <Card><CardContent>
            <div className="py-8 text-center text-muted-foreground">
              <Users className="mx-auto mb-2 h-8 w-8 opacity-40" />
              <p>{t('shifts.ringGroups.empty')}</p>
              <p className="text-xs">{t('shifts.ringGroups.emptySubtitle')}</p>
            </div>
          </CardContent></Card>
        ) : groups.map(group => (
          <Card key={group.id} data-testid="ring-group-card" data-ring-group-id={group.id}>
            <CardContent>
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-medium">{group.encryptedName}</h3>
                  <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                    <Users className="h-3 w-3" />
                    {t('shifts.ringGroups.memberCount', { count: group.memberCount })}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    data-testid="ring-group-edit-btn"
                    onClick={async () => {
                      try {
                        // Load detail view for member management
                        const { getRingGroup } = await import('@/lib/api')
                        const res = await getRingGroup(group.id)
                        setEditingGroup(res)
                      } catch {
                        toast(t('common.error'), 'error')
                      }
                    }}
                  >
                    <UserPlus className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-destructive hover:text-destructive"
                    data-testid="ring-group-delete-btn"
                    onClick={() => handleDelete(group.id)}
                    aria-label={t('a11y.deleteItem')}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {editingGroup && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{editingGroup.encryptedName} — {t('shifts.ringGroups.members')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              {editingGroup.members.map(m => (
                <div key={m.pubkey} className="flex items-center justify-between text-sm">
                  <span className="font-mono text-xs text-muted-foreground">{m.pubkey.slice(0, 16)}…</span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-destructive hover:text-destructive"
                    onClick={() => handleRemoveMember(editingGroup.id, m.pubkey)}
                  >
                    <UserMinus className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
            <div>
              <Label>{t('shifts.ringGroups.addMembers')}</Label>
              <UserMultiSelect
                users={users.filter(u => u.active && !editingGroup.members.some(m => m.pubkey === u.pubkey))}
                selected={[]}
                onSelectionChange={(pubkeys) => handleAddMembers(editingGroup.id, pubkeys)}
                placeholder={t('shifts.searchUsers')}
              />
            </div>
            <Button variant="outline" onClick={() => setEditingGroup(null)}>{t('common.close')}</Button>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ============================================================================
// Overrides Tab
// ============================================================================

function OverridesTab({ toast, t }: { toast: ReturnType<typeof useToast>['toast']; t: ReturnType<typeof useTranslation>['t'] }) {
  const now = new Date()
  const defaultFrom = now.toISOString().slice(0, 10)
  const defaultTo = new Date(now.getFullYear(), now.getMonth() + 2, 0).toISOString().slice(0, 10)
  const [from, setFrom] = useState(defaultFrom)
  const [to, setTo] = useState(defaultTo)
  const [showForm, setShowForm] = useState(false)
  const [formDate, setFormDate] = useState(defaultFrom)
  const [formType, setFormType] = useState<'cancel' | 'substitute'>('cancel')

  const { data: overrides = [], isLoading } = useShiftOverrides(from, to)
  const createMutation = useCreateShiftOverride()
  const deleteMutation = useDeleteShiftOverride()

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    try {
      await createMutation.mutateAsync({ id: crypto.randomUUID(), date: formDate, type: formType })
      setShowForm(false)
      toast(t('common.success'), 'success')
    } catch {
      toast(t('common.error'), 'error')
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteMutation.mutateAsync(id)
    } catch {
      toast(t('common.error'), 'error')
    }
  }

  return (
    <div className="space-y-4">
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
                <Button type="submit" disabled={createMutation.isPending}>{createMutation.isPending ? t('common.loading') : t('common.save')}</Button>
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>{t('common.cancel')}</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <div data-testid="override-list" className="space-y-2">
        {isLoading ? (
          <div className="py-4 text-center text-muted-foreground">{t('common.loading')}</div>
        ) : overrides.length === 0 ? (
          <Card><CardContent>
            <div className="py-8 text-center text-muted-foreground">
              <CalendarOff className="mx-auto mb-2 h-8 w-8 opacity-40" />
              <p>{t('shifts.overrides.empty')}</p>
            </div>
          </CardContent></Card>
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
                  onClick={() => handleDelete(ov.id)}
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

// ============================================================================
// Availability Tab (volunteer self-service)
// ============================================================================

function AvailabilityTab({ toast, t }: { toast: ReturnType<typeof useToast>['toast']; t: ReturnType<typeof useTranslation>['t'] }) {
  const [showForm, setShowForm] = useState(false)
  const [formStart, setFormStart] = useState('')
  const [formEnd, setFormEnd] = useState('')

  const { data: blocks = [], isLoading } = useMyAvailabilityBlocks()
  const createMutation = useCreateAvailabilityBlock()
  const deleteMutation = useDeleteAvailabilityBlock()

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    try {
      await createMutation.mutateAsync({ id: crypto.randomUUID(), startDate: formStart, endDate: formEnd })
      setShowForm(false)
      setFormStart('')
      setFormEnd('')
      toast(t('common.success'), 'success')
    } catch {
      toast(t('common.error'), 'error')
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteMutation.mutateAsync(id)
    } catch {
      toast(t('common.error'), 'error')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button data-testid="availability-create-btn" onClick={() => setShowForm(true)}>
          <CalendarPlus className="h-4 w-4" />
          {t('shifts.availability.create')}
        </Button>
      </div>

      {showForm && (
        <Card>
          <CardContent className="pt-4">
            <form data-testid="availability-form" onSubmit={handleCreate} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>{t('shifts.availability.startDate')}</Label>
                  <Input type="date" value={formStart} onChange={e => setFormStart(e.target.value)} required />
                </div>
                <div className="space-y-1">
                  <Label>{t('shifts.availability.endDate')}</Label>
                  <Input type="date" value={formEnd} onChange={e => setFormEnd(e.target.value)} required />
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={createMutation.isPending}>{createMutation.isPending ? t('common.loading') : t('common.save')}</Button>
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>{t('common.cancel')}</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <div data-testid="availability-list" className="space-y-2">
        {isLoading ? (
          <div className="py-4 text-center text-muted-foreground">{t('common.loading')}</div>
        ) : blocks.length === 0 ? (
          <Card><CardContent>
            <div className="py-8 text-center text-muted-foreground">
              <CalendarOff className="mx-auto mb-2 h-8 w-8 opacity-40" />
              <p>{t('shifts.availability.empty')}</p>
              <p className="text-xs">{t('shifts.availability.emptySubtitle')}</p>
            </div>
          </CardContent></Card>
        ) : blocks.map(block => (
          <Card key={block.id} data-testid="availability-card">
            <CardContent>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">{block.startDate} → {block.endDate}</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-destructive hover:text-destructive"
                  data-testid="availability-delete-btn"
                  onClick={() => handleDelete(block.id)}
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

// ============================================================================
// Shift Requests Tab (admin approval)
// ============================================================================

function RequestsTab({ toast, t }: { toast: ReturnType<typeof useToast>['toast']; t: ReturnType<typeof useTranslation>['t'] }) {
  const { data: requests = [], isLoading } = useShiftRequests()
  const approveMutation = useApproveShiftRequest()
  const rejectMutation = useRejectShiftRequest()

  async function handleApprove(id: string) {
    try {
      await approveMutation.mutateAsync(id)
      toast(t('common.success'), 'success')
    } catch {
      toast(t('common.error'), 'error')
    }
  }

  async function handleReject(id: string) {
    try {
      await rejectMutation.mutateAsync(id)
      toast(t('common.success'), 'success')
    } catch {
      toast(t('common.error'), 'error')
    }
  }

  return (
    <div className="space-y-4">
      <div data-testid="requests-list" className="space-y-2">
        {isLoading ? (
          <div className="py-4 text-center text-muted-foreground">{t('common.loading')}</div>
        ) : requests.length === 0 ? (
          <Card><CardContent>
            <div className="py-8 text-center text-muted-foreground">
              <ShieldCheck className="mx-auto mb-2 h-8 w-8 opacity-40" />
              <p>{t('shifts.requests.empty')}</p>
              <p className="text-xs">{t('shifts.requests.emptySubtitle')}</p>
            </div>
          </CardContent></Card>
        ) : requests.map(req => (
          <Card key={req.id} data-testid="request-card">
            <CardContent>
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <Badge variant={req.type === 'join' ? 'default' : 'secondary'}>
                      {req.type === 'join' ? t('shifts.requests.typeJoin') : t('shifts.requests.typeLeave')}
                    </Badge>
                    <Badge variant={req.status === 'pending' ? 'outline' : req.status === 'approved' ? 'default' : 'destructive'}>
                      {req.status === 'pending' ? t('shifts.requests.statusPending') : req.status === 'approved' ? t('shifts.requests.statusApproved') : t('shifts.requests.statusDenied')}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground font-mono">{req.userPubkey.slice(0, 20)}…</p>
                </div>
                {req.status === 'pending' && (
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="text-green-600 hover:text-green-700"
                      data-testid="request-approve-btn"
                      onClick={() => handleApprove(req.id)}
                      aria-label={t('shifts.requests.approve')}
                    >
                      <CheckCircle className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="text-destructive hover:text-destructive"
                      data-testid="request-reject-btn"
                      onClick={() => handleReject(req.id)}
                      aria-label={t('shifts.requests.reject')}
                    >
                      <XCircle className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

// ============================================================================
// Active Volunteers Tab (admin view)
// ============================================================================

function ActiveTab({ t }: { toast: ReturnType<typeof useToast>['toast']; t: ReturnType<typeof useTranslation>['t'] }) {
  const { data: active = [], isLoading } = useActiveShifts()

  return (
    <div className="space-y-4">
      <div data-testid="active-list" className="space-y-2">
        {isLoading ? (
          <div className="py-4 text-center text-muted-foreground">{t('common.loading')}</div>
        ) : active.length === 0 ? (
          <Card><CardContent>
            <div className="py-8 text-center text-muted-foreground">
              <Activity className="mx-auto mb-2 h-8 w-8 opacity-40" />
              <p>{t('shifts.active.empty')}</p>
            </div>
          </CardContent></Card>
        ) : active.map(a => (
          <Card key={a.pubkey} data-testid="active-card">
            <CardContent>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-mono text-sm">{a.pubkey.slice(0, 20)}…</p>
                  <p className="text-xs text-muted-foreground">
                    {t('shifts.active.since', { time: new Date(a.startedAt).toLocaleTimeString() })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('shifts.active.heartbeat', { time: new Date(a.lastHeartbeat).toLocaleTimeString() })}
                  </p>
                </div>
                <Badge variant="default" className="bg-green-100 text-green-800">
                  <Activity className="mr-1 h-3 w-3" />
                  {t('shifts.onShift')}
                </Badge>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

// ============================================================================
// Shift Timer (shows elapsed time since clock-in)
// ============================================================================

function ShiftTimer({ startedAt }: { startedAt: Date }) {
  const [elapsed, setElapsed] = useState('')

  useEffect(() => {
    function update() {
      const diff = Math.floor((Date.now() - startedAt.getTime()) / 1000)
      const h = Math.floor(diff / 3600)
      const m = Math.floor((diff % 3600) / 60)
      const s = diff % 60
      setElapsed(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`)
    }
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [startedAt])

  return (
    <span data-testid="shift-timer" className="font-mono text-sm text-muted-foreground">
      {elapsed}
    </span>
  )
}

// ============================================================================
// Shift Form (used in ScheduleTab)
// ============================================================================

function ShiftForm({ shift, users, onSave, onCancel, t }: {
  shift: Shift | null
  users: User[]
  onSave: (data: Partial<Shift>) => Promise<void>
  onCancel: () => void
  t: ReturnType<typeof useTranslation>['t']
}) {
  const [encryptedName, setEncryptedName] = useState(shift?.encryptedName || '')
  const [startTime, setStartTime] = useState(shift?.startTime || '09:00')
  const [endTime, setEndTime] = useState(shift?.endTime || '17:00')
  const [days, setDays] = useState<number[]>(shift?.days || [1, 2, 3, 4, 5])
  const [selectedVolunteers, setSelectedVolunteers] = useState<string[]>(shift?.userPubkeys || [])
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      await onSave({ encryptedName, startTime, endTime, days, userPubkeys: selectedVolunteers })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarPlus className="h-4 w-4 text-muted-foreground" />
          {shift ? t('shifts.editShift') : t('shifts.createShift')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form data-testid="shift-form" onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="shift-name">{t('shifts.shiftName')}</Label>
            <Input
              id="shift-name"
              data-testid="shift-name-input"
              value={encryptedName}
              onChange={e => setEncryptedName(e.target.value)}
              required
            />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="start-time">{t('shifts.startTime')}</Label>
              <Input id="start-time" data-testid="shift-start-time" type="time" value={startTime} onChange={e => setStartTime(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="end-time">{t('shifts.endTime')}</Label>
              <Input id="end-time" data-testid="shift-end-time" type="time" value={endTime} onChange={e => setEndTime(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>{t('shifts.recurring')}</Label>
            <div className="flex flex-wrap gap-2">
              {DAY_KEYS.map((day, i) => (
                <button
                  key={i}
                  type="button"
                  aria-pressed={days.includes(i)}
                  onClick={() => setDays(prev => prev.includes(i) ? prev.filter(d => d !== i) : [...prev, i])}
                >
                  <Badge variant={days.includes(i) ? 'default' : 'outline'}>{t(`shifts.days.${day}`)}</Badge>
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <Label>{t('shifts.assignUsers')}</Label>
            <UserMultiSelect
              users={users.filter(u => u.active)}
              selected={selectedVolunteers}
              onSelectionChange={setSelectedVolunteers}
              placeholder={t('shifts.searchUsers')}
            />
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
