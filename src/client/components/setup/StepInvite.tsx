import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { createInvite, listRoles, type InviteCode, type RoleDefinition } from '@/lib/api'
import { getHubOrigin } from '@/lib/api-config'
import { buildInviteLink } from '@/lib/invite-code'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { UserPlus, Copy, Loader2, Check, ArrowRight } from 'lucide-react'

interface Props {
  /**
   * The hub the wizard just created. This step runs only after `POST
   * /api/setup/complete` has created it: an invite admits someone into a hub,
   * and one minted before the hub existed admitted them into none (#2194).
   */
  hubId: string | null
  onFinish: () => void
  headingRef?: React.RefObject<HTMLHeadingElement | null>
}

export function StepInvite({ hubId, onFinish, headingRef }: Props) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  // The roles this hub offers — user-defined permission bundles, never a
  // hardcoded list. Nothing is preselected: an empty choice means the hub
  // template's default member role, as on the users page.
  const [roles, setRoles] = useState<RoleDefinition[]>([])
  const [roleId, setRoleId] = useState('')
  const [generating, setGenerating] = useState(false)
  const [invites, setInvites] = useState<InviteCode[]>([])
  const [copiedCode, setCopiedCode] = useState<string | null>(null)

  useEffect(() => {
    listRoles()
      .then(res => setRoles(res.roles))
      .catch(() => toast(t('common.error'), 'error'))
  }, [t, toast])

  async function handleGenerate() {
    if (!name.trim() || !phone.trim()) return
    setGenerating(true)
    try {
      const { invite } = await createInvite({
        name: name.trim(),
        phone: phone.trim(),
        roleIds: roleId ? [roleId] : undefined,
        ...(hubId ? { hubId } : {}),
      })
      setInvites(prev => [invite, ...prev])
      setName('')
      setPhone('')
      toast(t('setup.inviteCreated'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : t('common.error'), 'error')
    } finally {
      setGenerating(false)
    }
  }

  function roleNames(invite: InviteCode): string {
    return invite.roleIds
      .map(id => roles.find(r => r.id === id)?.name ?? id)
      .join(', ')
  }

  // A link on the hub's own address (#1128) — the volunteer pastes it into the
  // app's invite screen, which reads the code and checks the hub it names.
  function copyInviteLink(code: string) {
    navigator.clipboard.writeText(buildInviteLink(code, getHubOrigin()))
    setCopiedCode(code)
    toast(t('setup.inviteCopied'), 'success')
    setTimeout(() => setCopiedCode(null), 2000)
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold outline-none">{t('setup.inviteTitle')}</h2>
        <p className="text-sm text-muted-foreground mt-1">{t('setup.inviteDescription')}</p>
      </div>

      {/* Invite form */}
      <div className="space-y-4 rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <UserPlus className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">{t('setup.inviteNew')}</h3>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="invite-name">{t('users.name')}</Label>
            <Input
              id="invite-name"
              data-testid="invite-name-input"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('setup.namePlaceholder')}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="invite-phone">{t('users.phone')}</Label>
            <Input
              id="invite-phone"
              data-testid="invite-phone-input"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="+12125551234"
            />
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor="setup-invite-role">{t('users.role')}</Label>
          <Select value={roleId} onValueChange={setRoleId}>
            <SelectTrigger id="setup-invite-role" data-testid="user-form-role-select">
              <SelectValue placeholder={t('users.roleHubDefault')} />
            </SelectTrigger>
            <SelectContent>
              {roles.map(role => (
                <SelectItem key={role.id} value={role.id} data-testid="user-form-role-option" data-role-id={role.id}>{role.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          onClick={handleGenerate}
          disabled={generating || !name.trim() || !phone.trim()}
          aria-busy={generating}
          className="w-full"
          data-testid="setup-generate-invite-btn"
        >
          {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
          {generating ? t('common.loading') : t('setup.generateInvite')}
        </Button>
      </div>

      {/* Generated invites list */}
      {invites.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">{t('setup.generatedInvites')}</h3>
          <div className="space-y-2">
            {invites.map(invite => (
              <div
                key={invite.code}
                className="flex items-center justify-between rounded-lg border bg-muted/50 p-3"
              >
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{invite.name}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {roleNames(invite)}
                    </Badge>
                  </div>
                  <p className="font-mono text-xs text-muted-foreground">{invite.code}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="copy-invite-link-btn"
                  aria-label={t('a11y.copyToClipboard')}
                  onClick={() => copyInviteLink(invite.code)}
                >
                  {copiedCode === invite.code ? (
                    <Check className="h-3.5 w-3.5 text-green-500" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      <Button onClick={onFinish} className="w-full" size="lg" data-testid="setup-finish-btn">
        {t('setup.goToDashboard')}
        <ArrowRight className="h-4 w-4" />
      </Button>
    </div>
  )
}
