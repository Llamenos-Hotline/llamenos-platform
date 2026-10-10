import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { createInvite, type InviteCode } from '@/lib/api'
import { getOnboardingUrl } from '@/lib/api-config'
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
import { UserPlus, Copy, Loader2, Check } from 'lucide-react'

interface Props {
  headingRef?: React.RefObject<HTMLHeadingElement | null>
}

export function StepInvite({ headingRef }: Props = {}) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [roleId, setRoleId] = useState<string>('role-volunteer')
  const [generating, setGenerating] = useState(false)
  const [invites, setInvites] = useState<InviteCode[]>([])
  const [copiedCode, setCopiedCode] = useState<string | null>(null)

  async function handleGenerate() {
    if (!name.trim() || !phone.trim()) return
    setGenerating(true)
    try {
      const { invite } = await createInvite({ name: name.trim(), phone: phone.trim(), roleIds: [roleId] })
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

  function copyInviteLink(code: string) {
    const url = getOnboardingUrl(code)
    navigator.clipboard.writeText(url)
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
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('setup.namePlaceholder')}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="invite-phone">{t('users.phone')}</Label>
            <Input
              id="invite-phone"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="+12125551234"
            />
          </div>
        </div>

        <div className="space-y-1">
          <Label>{t('users.role')}</Label>
          <Select value={roleId} onValueChange={setRoleId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="role-volunteer">{t('users.roleVolunteer')}</SelectItem>
              <SelectItem value="role-super-admin">{t('users.roleAdmin')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button
          onClick={handleGenerate}
          disabled={generating || !name.trim() || !phone.trim()}
          aria-busy={generating}
          className="w-full"
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
                      {invite.roleIds?.includes('role-super-admin') ? t('users.roleAdmin') : t('users.roleVolunteer')}
                    </Badge>
                  </div>
                  <p className="font-mono text-xs text-muted-foreground">{invite.code}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
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
    </div>
  )
}
