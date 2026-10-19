import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Key, Pencil, Trash2, Check, Usb, Wifi, ShieldCheck } from 'lucide-react'
import { useToast } from '@/lib/toast'
import { usePasskeys, renamePasskey, deletePasskey, registerPasskey } from '@/lib/queries/devices'

const TRANSPORT_ICONS: Record<string, typeof Usb> = {
  usb: Usb,
  ble: Wifi,
  nfc: Wifi,
  internal: ShieldCheck,
}

export const Route = createFileRoute('/security/passkeys')({
  component: PasskeysPage,
})

function PasskeysPage() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { data: passkeys, isLoading, refetch } = usePasskeys()
  const [newLabel, setNewLabel] = useState('')
  const [registering, setRegistering] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  if (isLoading) return <div className="animate-pulse">{t('common.loading')}</div>

  async function handleRegister() {
    const label = newLabel.trim()
    if (!label) return
    setRegistering(true)
    try {
      await registerPasskey(label)
      setNewLabel('')
      toast(t('webauthn.registerSuccess'), 'success')
      refetch()
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setRegistering(false)
    }
  }

  async function handleRename(credentialId: string) {
    await renamePasskey(credentialId, renameValue)
    setRenamingId(null)
    refetch()
  }

  async function handleDelete(credentialId: string) {
    await deletePasskey(credentialId)
    refetch()
  }

  return (
    <div className="space-y-4" data-testid="security-passkeys">
      <h2 className="text-lg font-semibold">{t('security.passkeys.title')}</h2>

      <div className="flex gap-2">
        <Input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder={t('webauthn.label')}
          className="flex-1"
          data-testid="passkey-label-input"
        />
        <Button
          size="sm"
          onClick={handleRegister}
          disabled={registering || !newLabel.trim()}
          data-testid="passkey-register"
        >
          <Key className="h-4 w-4 mr-1" />
          {t('security.passkeys.register')}
        </Button>
      </div>

      <div className="space-y-2">
        {passkeys?.map((passkey) => (
          <div key={passkey.credentialId} className="flex items-center gap-3 p-3 rounded-md border">
            <Key className="h-5 w-5 text-muted-foreground" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                {renamingId === passkey.credentialId ? (
                  <div className="flex gap-1">
                    <Input
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleRename(passkey.credentialId)
                        }
                      }}
                      className="h-7 text-sm"
                      autoFocus
                    />
                    <Button size="sm" variant="ghost" onClick={() => handleRename(passkey.credentialId)}>
                      <Check className="h-3 w-3" />
                    </Button>
                  </div>
                ) : (
                  <span className="font-medium text-sm">{passkey.label || t('security.passkeys.unnamed')}</span>
                )}
                {passkey.backedUp && (
                  <Badge variant="outline" className="text-xs">{t('security.passkeys.backedUp')}</Badge>
                )}
              </div>
              <div className="flex items-center gap-2 mt-1">
                {passkey.transports?.map((transport: string) => {
                  const Icon = TRANSPORT_ICONS[transport] ?? Key
                  return (
                    <Badge key={transport} variant="secondary" className="text-xs gap-1">
                      <Icon className="h-3 w-3" />
                      {transport}
                    </Badge>
                  )
                })}
                {passkey.lastUsedAt && (
                  <span className="text-xs text-muted-foreground">
                    {t('security.passkeys.lastUsed')} {new Date(passkey.lastUsedAt).toLocaleDateString()}
                  </span>
                )}
              </div>
            </div>
            <div className="flex gap-1">
              <Button
                size="icon"
                variant="ghost"
                onClick={() => {
                  setRenamingId(passkey.credentialId)
                  setRenameValue(passkey.label ?? '')
                }}
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => handleDelete(passkey.credentialId)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default PasskeysPage
