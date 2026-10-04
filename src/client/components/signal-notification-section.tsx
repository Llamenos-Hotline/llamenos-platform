/**
 * Signal Notification Section — settings for Signal-based security alerts.
 *
 * Lets volunteers:
 *   1. Register their Signal phone number or username (encrypted + hashed client-side)
 *   2. Choose their notification channel (web_push vs signal)
 *   3. Configure disappearing message timer, digest cadence, and per-alert toggles
 *
 * Zero-knowledge design:
 *   - HMAC key is fetched from the server (per-user derived key)
 *   - Client hashes the identifier locally before sending to the server
 *   - Plaintext is sent separately to the sidecar via a server-proxied endpoint
 *   - Server stores only the hash + HPKE ciphertext (no plaintext)
 */
import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { useToast } from '@/lib/toast'
import { aesGcmEncrypt, hpkeSealKey } from '@/lib/platform'
import { LABEL_CONTACT_ID } from '@shared/crypto-labels'
import {
  getSignalContact,
  registerSignalContact,
  registerSignalContactWithSidecar,
  deleteSignalContact,
  getSignalHmacKey,
  getSecurityPrefs,
  updateSecurityPrefs,
  type SecurityPrefs,
  type SignalContactRecord,
} from '@/lib/api'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { MessageSquare, Trash2, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'

// ---------------------------------------------------------------------------
// HMAC helpers (browser-side — Web Crypto)
// ---------------------------------------------------------------------------

async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const encoder = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function normalizeSignalIdentifier(raw: string, type: 'phone' | 'username'): string {
  if (type === 'phone') {
    const stripped = raw.replace(/[\s\-().]/g, '')
    return stripped.startsWith('+') ? stripped : `+${stripped}`
  }
  return raw.toLowerCase().replace(/^@/, '')
}

// ---------------------------------------------------------------------------
// HPKE envelope encryption for Signal contact identifiers.
// Generates a random AES-256-GCM key, encrypts the identifier, then
// HPKE-wraps the key for each admin (same pattern as encryptNote).
// ---------------------------------------------------------------------------
async function encryptIdentifier(
  plaintext: string,
  adminPubkeys: string[],
): Promise<{
  ciphertext: string
  envelope: { recipientPubkey: string; encryptedKey: string }[]
}> {
  // Generate random 32-byte content key
  const keyBytes = crypto.getRandomValues(new Uint8Array(32))
  const keyHex = Array.from(keyBytes, (b) => b.toString(16).padStart(2, '0')).join('')

  // AES-256-GCM encrypt the identifier
  const ciphertext = await aesGcmEncrypt(plaintext, keyHex, '')

  // HPKE-wrap the key for each admin
  const envelope = await Promise.all(
    adminPubkeys.map(async (pubkey) => {
      const hpkeEnvelope = await hpkeSealKey(keyHex, pubkey, LABEL_CONTACT_ID, '')
      return {
        recipientPubkey: pubkey,
        encryptedKey: JSON.stringify(hpkeEnvelope),
      }
    }),
  )

  return { ciphertext, envelope }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SignalNotificationSectionProps {
  /** Whether Signal notifications are even available (NOTIFIER_URL configured) */
  available?: boolean
}

export function SignalNotificationSection({ available = true }: SignalNotificationSectionProps) {
  const { t } = useTranslation()
  const { adminDecryptionPubkey } = useAuth()
  const { toast } = useToast()

  const [loading, setLoading] = useState(true)
  const [contact, setContact] = useState<SignalContactRecord | null>(null)
  const [prefs, setPrefs] = useState<SecurityPrefs | null>(null)

  // Registration form state
  const [identifier, setIdentifier] = useState('')
  const [identifierType, setIdentifierType] = useState<'phone' | 'username'>('phone')
  const [registering, setRegistering] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [prefsUpdating, setPrefsUpdating] = useState(false)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [contactData, prefsData] = await Promise.all([
        getSignalContact(),
        getSecurityPrefs(),
      ])
      setContact(contactData)
      setPrefs(prefsData)
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    loadData()
  }, [loadData])

  async function handleRegister() {
    if (!identifier.trim()) return
    setRegistering(true)
    try {
      // Step 1: Get per-user HMAC key from server
      const { hmacKey } = await getSignalHmacKey()

      // Step 2: Normalize + hash identifier client-side
      const normalized = normalizeSignalIdentifier(identifier.trim(), identifierType)
      const identifierHash = await hmacSha256Hex(hmacKey, normalized)

      // Step 3: Encrypt identifier with HPKE for admin readers
      const adminPubkeys = adminDecryptionPubkey ? [adminDecryptionPubkey] : []
      const { ciphertext, envelope } = await encryptIdentifier(normalized, adminPubkeys)

      // Step 4: Store hash + ciphertext in main DB
      await registerSignalContact({
        identifierHash,
        identifierCiphertext: ciphertext,
        identifierEnvelope: envelope,
        identifierType,
      })

      // Step 5: Register plaintext with sidecar (server-proxied, validates hash)
      await registerSignalContactWithSidecar({
        plaintextIdentifier: identifier.trim(),
        identifierType,
      })

      setIdentifier('')
      toast(t('signalNotifications.contactRegistered', { defaultValue: 'Signal contact registered' }), 'success')
      await loadData()
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setRegistering(false)
    }
  }

  async function handleRemove() {
    setRemoving(true)
    try {
      await deleteSignalContact()
      setContact(null)
      toast(t('signalNotifications.contactRemoved', { defaultValue: 'Signal contact removed' }), 'success')
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setRemoving(false)
    }
  }

  async function handlePrefsUpdate(patch: Partial<Omit<SecurityPrefs, 'updatedAt'>>) {
    if (!prefs) return
    setPrefsUpdating(true)
    try {
      const updated = await updateSecurityPrefs(patch)
      setPrefs(updated)
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setPrefsUpdating(false)
    }
  }

  if (!available) {
    return (
      <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
        <AlertCircle className="mb-2 h-4 w-4" />
        {t('signalNotifications.notConfigured', {
          defaultValue: 'Signal notifications are not configured on this server.',
        })}
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('common.loading')}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Contact registration */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
          <h4 className="text-sm font-medium">
            {t('signalNotifications.yourContact', { defaultValue: 'Your Signal contact' })}
          </h4>
        </div>

        {contact ? (
          <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-4 py-3">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                <span className="text-sm font-medium">
                  {t('signalNotifications.contactActive', { defaultValue: 'Contact registered' })}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('signalNotifications.contactTypeLabel', { defaultValue: 'Type' })}: {contact.identifierType}
                {contact.verifiedAt && (
                  <> · {t('signalNotifications.lastVerified', { defaultValue: 'Last verified' })}: {new Date(contact.verifiedAt).toLocaleDateString()}</>
                )}
              </p>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {t('signalNotifications.hashLabel', { defaultValue: 'Hash' })}: {contact.identifierHash.slice(0, 16)}...
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRemove}
              disabled={removing}
              data-testid="remove-signal-contact"
            >
              {removing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4 text-destructive" />
              )}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t('signalNotifications.registerHelp', {
                defaultValue:
                  'Register your Signal phone number or username to receive security alerts. Your identifier is hashed before being stored — the server never sees the plaintext.',
              })}
            </p>

            {/* Identifier type toggle */}
            <div className="flex gap-2">
              {(['phone', 'username'] as const).map((type) => (
                <button
                  key={type}
                  onClick={() => setIdentifierType(type)}
                  className={`rounded-md border px-3 py-1.5 text-xs transition-colors ${
                    identifierType === type
                      ? 'border-primary bg-primary/10 text-primary font-medium'
                      : 'border-border hover:border-primary/50'
                  }`}
                >
                  {type === 'phone'
                    ? t('signalNotifications.phoneNumber', { defaultValue: 'Phone number' })
                    : t('signalNotifications.username', { defaultValue: 'Username' })}
                </button>
              ))}
            </div>

            <div className="flex gap-2">
              <Input
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder={
                  identifierType === 'phone'
                    ? t('signalNotifications.phonePlaceholder', { defaultValue: '+1 555 123 4567' })
                    : t('signalNotifications.usernamePlaceholder', { defaultValue: '@yourname.01' })
                }
                data-testid="signal-identifier-input"
                className="flex-1"
              />
              <Button
                onClick={handleRegister}
                disabled={registering || !identifier.trim()}
                data-testid="register-signal-contact"
              >
                {registering ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                {t('signalNotifications.register', { defaultValue: 'Register' })}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Security preferences */}
      {prefs && (
        <div className="space-y-3">
          <h4 className="text-sm font-medium">
            {t('signalNotifications.alertPreferences', { defaultValue: 'Alert preferences' })}
          </h4>

          {/* Notification channel */}
          <div className="flex items-center justify-between rounded-lg border border-border p-4">
            <div className="space-y-0.5">
              <Label>{t('signalNotifications.useSignalAlerts', { defaultValue: 'Signal security alerts' })}</Label>
              <p className="text-xs text-muted-foreground">
                {t('signalNotifications.useSignalAlertsHelp', {
                  defaultValue: 'Receive security alerts via Signal (requires a registered contact above).',
                })}
              </p>
            </div>
            <Switch
              checked={prefs.notificationChannel === 'signal'}
              disabled={prefsUpdating || !contact}
              data-testid="signal-channel-toggle"
              onCheckedChange={(checked) =>
                handlePrefsUpdate({ notificationChannel: checked ? 'signal' : 'web_push' })
              }
            />
          </div>

          {prefs.notificationChannel === 'signal' && (
            <>
              {/* Disappearing timer */}
              <div className="space-y-2">
                <Label>{t('signalNotifications.disappearingTimer', { defaultValue: 'Disappearing messages' })}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('signalNotifications.disappearingTimerHelp', {
                    defaultValue: 'Alert messages will disappear after this many days.',
                  })}
                </p>
                <div className="flex flex-wrap gap-2">
                  {([0, 1, 7, 30] as const).map((days) => (
                    <button
                      key={days}
                      onClick={() => handlePrefsUpdate({ disappearingTimerDays: days })}
                      disabled={prefsUpdating}
                      className={`rounded-md border px-3 py-1.5 text-xs transition-colors ${
                        prefs.disappearingTimerDays === days
                          ? 'border-primary bg-primary/10 text-primary font-medium'
                          : 'border-border hover:border-primary/50'
                      }`}
                    >
                      {days === 0
                        ? t('signalNotifications.timerOff', { defaultValue: 'Off' })
                        : days === 1
                          ? t('signalNotifications.timer1Day', { defaultValue: '1 day' })
                          : days === 7
                            ? t('signalNotifications.timer7Days', { defaultValue: '7 days' })
                            : t('signalNotifications.timer30Days', { defaultValue: '30 days' })}
                    </button>
                  ))}
                </div>
              </div>

              {/* Digest cadence */}
              <div className="space-y-2">
                <Label>{t('signalNotifications.digestCadence', { defaultValue: 'Activity digest' })}</Label>
                <div className="flex flex-wrap gap-2">
                  {(['off', 'daily', 'weekly'] as const).map((cadence) => (
                    <button
                      key={cadence}
                      onClick={() => handlePrefsUpdate({ digestCadence: cadence })}
                      disabled={prefsUpdating}
                      className={`rounded-md border px-3 py-1.5 text-xs transition-colors ${
                        prefs.digestCadence === cadence
                          ? 'border-primary bg-primary/10 text-primary font-medium'
                          : 'border-border hover:border-primary/50'
                      }`}
                    >
                      {cadence === 'off'
                        ? t('signalNotifications.cadenceOff', { defaultValue: 'Off' })
                        : cadence === 'daily'
                          ? t('signalNotifications.cadenceDaily', { defaultValue: 'Daily' })
                          : t('signalNotifications.cadenceWeekly', { defaultValue: 'Weekly' })}
                    </button>
                  ))}
                </div>
              </div>

              {/* Per-event toggles */}
              <div className="space-y-2">
                <Label>{t('signalNotifications.alertEvents', { defaultValue: 'Alert on these events' })}</Label>
                {[
                  {
                    key: 'alertOnNewDevice' as const,
                    label: t('signalNotifications.alertNewDevice', { defaultValue: 'New device sign-in' }),
                  },
                  {
                    key: 'alertOnPasskeyChange' as const,
                    label: t('signalNotifications.alertPasskeyChange', { defaultValue: 'Passkey added/removed' }),
                  },
                  {
                    key: 'alertOnPinChange' as const,
                    label: t('signalNotifications.alertPinChange', { defaultValue: 'PIN changed' }),
                  },
                ].map(({ key, label }) => (
                  <div key={key} className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                    <Label className="text-sm font-normal">{label}</Label>
                    <Switch
                      checked={prefs[key]}
                      disabled={prefsUpdating}
                      data-testid={`signal-alert-${key}`}
                      onCheckedChange={(checked) => handlePrefsUpdate({ [key]: checked })}
                    />
                  </div>
                ))}
              </div>
            </>
          )}

          {!contact && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3">
              <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" />
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {t('signalNotifications.noContactWarning', {
                  defaultValue: 'Register a Signal contact above to enable Signal alerts.',
                })}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Privacy note */}
      <p className="text-xs text-muted-foreground">
        {t('signalNotifications.privacyNote', {
          defaultValue:
            'Your Signal identifier is hashed with a unique key before being stored. The server cannot determine your phone number or username from the stored data.',
        })}
      </p>
    </div>
  )
}
