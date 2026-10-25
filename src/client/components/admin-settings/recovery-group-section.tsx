import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import {
  enrollRecoveryGroup,
  type RecoveryGroupEnrollBody,
} from '@/lib/api'
import type { RecoveryGroupInfo } from '@protocol/schemas/recovery-group'
import {
  recoveryGroupCreate,
  sigchainCreateLinkFromState,
  getDevicePubkeys,
} from '@/lib/platform'
import {
  SectionBody,
  SectionDescription,
  SectionField,
  SectionActions,
  SectionBanner,
} from '@/components/admin-shell/section-layout'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import {
  Shield,
  Users,
  CheckCircle2,
  AlertTriangle,
  MapPin,
  RotateCw,
  Loader2,
} from 'lucide-react'

export interface ShareHolderCandidate {
  pubkey: string
  displayName: string
  encryptionPubkey: string
  deviceVerified: boolean
  lastSeen: string | null
}

interface Props {
  hubId: string
  group: RecoveryGroupInfo | null
  shareHolderCandidates: ShareHolderCandidate[]
  onGroupChanged: () => void
}

export function RecoveryGroupSettingsSection({
  hubId,
  group,
  shareHolderCandidates,
  onGroupChanged,
}: Props) {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [threshold, setThreshold] = useState(group?.threshold ?? 2)
  const [totalShares, setTotalShares] = useState(group?.totalShares ?? 3)
  const [delayHours, setDelayHours] = useState(group?.delayHours ?? 24)
  const [emergencyFloorHours, setEmergencyFloorHours] = useState(group?.emergencyFloorHours ?? 4)
  const [selectedHolders, setSelectedHolders] = useState<string[]>(
    group?.shareHolderLiveness.map((h) => h.holderPubkey) ?? [],
  )
  const [saving, setSaving] = useState(false)
  const [showSaved, setShowSaved] = useState(false)

  const isRotation = group !== null

  const thresholdError =
    threshold < 2 || threshold > 5 || threshold > totalShares
      ? t('recoveryGroup.error.thresholdExceedsTotal')
      : null
  const totalError =
    totalShares < 3 || totalShares > 5 ? t('recoveryGroup.error.thresholdExceedsTotal') : null
  const holderCountError =
    selectedHolders.length !== totalShares
      ? `Select exactly ${totalShares} recovery contacts`
      : null
  const delayError = delayHours < 4 || delayHours > 168 ? 'Must be 4–168 hours' : null
  const emergencyError =
    emergencyFloorHours < 1 || emergencyFloorHours > 24
      ? 'Must be 1–24 hours'
      : emergencyFloorHours > delayHours
        ? 'Cannot exceed recovery delay'
        : null

  const hasErrors = !!(thresholdError || totalError || holderCountError || delayError || emergencyError)

  function toggleHolder(pubkey: string) {
    setSelectedHolders((prev) => {
      if (prev.includes(pubkey)) return prev.filter((p) => p !== pubkey)
      if (prev.length >= totalShares) return prev
      return [...prev, pubkey]
    })
  }

  async function handleEnroll() {
    if (hasErrors) return
    setSaving(true)
    try {
      // 1. Resolve each selected holder's encryption pubkey
      const holderEncryptionPubkeys = selectedHolders.map((holderPubkey) => {
        const candidate = shareHolderCandidates.find((c) => c.pubkey === holderPubkey)
        if (!candidate) throw new Error(`Holder ${holderPubkey} not found`)
        return candidate.encryptionPubkey
      })

      // 2. Generate the recovery group keypair, split it and seal every share to its
      //    holder in Rust — neither the private key nor a plaintext share enters JS
      const { publicKeyHex, shareEnvelopes: sealedShares, commitments } = await recoveryGroupCreate(
        totalShares,
        threshold,
        holderEncryptionPubkeys,
      )
      const shareEnvelopes = selectedHolders.map((holderPubkey, idx) => ({
        holderPubkey,
        envelope: JSON.stringify(sealedShares[idx]),
      }))

      // 3. Create sigchain link for the recovery group enrollment
      const deviceState = await getDevicePubkeys()
      if (!deviceState) throw new Error('Device not unlocked')

      const sigchainPayload = JSON.stringify({
        type: isRotation ? 'recovery-group-rotate' : 'recovery-group-enroll',
        groupPublicKey: publicKeyHex,
        shareHolderPubkeys: selectedHolders,
        threshold,
        totalShares,
      })

      const sigchainLink = await sigchainCreateLinkFromState(
        crypto.randomUUID(),
        1,
        null,
        new Date().toISOString(),
        sigchainPayload,
      )

      // 4. Submit to server
      const body: RecoveryGroupEnrollBody = {
        hubId,
        threshold,
        totalShares,
        groupPublicKey: publicKeyHex,
        shareEnvelopes,
        shareCommitments: commitments,
        sigchainLinkHash: sigchainLink.entryHash,
        delayHours,
        emergencyFloorHours,
        rotate: isRotation,
      }

      await enrollRecoveryGroup(body)
      toast(
        isRotation ? t('recoveryGroup.rotateSuccess') : t('recoveryGroup.setupSuccess'),
        'success',
      )
      setShowSaved(true)
      setTimeout(() => setShowSaved(false), 3000)
      onGroupChanged()
    } catch (err) {
      toast(err instanceof Error ? err.message : t('common.error'), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <SectionBody>
      <SectionDescription>{t('recoveryGroup.description')}</SectionDescription>

      {/* Current group status */}
      {group && (
        <div
          className="rounded-lg border border-border p-4 space-y-3"
          data-testid="recovery-group-status"
        >
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-emerald-600" />
            <span className="font-medium text-sm">{t('recoveryGroup.title')}</span>
            <Badge variant="outline" className="ml-auto">
              {group.threshold}/{group.totalShares}
            </Badge>
          </div>
          <div className="text-xs text-muted-foreground space-y-1">
            <div>
              {t('recoveryGroup.delayConfig')}: {group.delayHours}h
            </div>
            <div>
              {t('recoveryGroup.emergencyFloorConfig')}: {group.emergencyFloorHours}h
            </div>
            {group.rotatedAt && (
              <div>
                {t('recoveryGroup.lastRotated')}: {new Date(group.rotatedAt).toLocaleDateString()}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label className="text-xs">{t('recoveryGroup.contactHealth')}</Label>
            {group.shareHolderLiveness.map((holder) => {
              const candidate = shareHolderCandidates.find(
                (c) => c.pubkey === holder.holderPubkey,
              )
              const livenessOk =
                holder.lastLivenessProof &&
                Date.now() - new Date(holder.lastLivenessProof).getTime() <
                  30 * 24 * 60 * 60 * 1000
              return (
                <div key={holder.holderPubkey} className="flex items-center gap-2 text-xs">
                  <span className="truncate max-w-[200px]">
                    {candidate?.displayName || `${holder.holderPubkey.slice(0, 16)}...`}
                  </span>
                  {candidate?.deviceVerified ? (
                    <Badge variant="outline" className="text-emerald-600 border-emerald-600/30">
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                      {t('recoveryGroup.deviceVerified')}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-amber-600 border-amber-600/30">
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      {t('recoveryGroup.deviceUnverified')}
                    </Badge>
                  )}
                  <Badge
                    variant="outline"
                    className={
                      livenessOk
                        ? 'text-emerald-600 border-emerald-600/30'
                        : 'text-amber-600 border-amber-600/30'
                    }
                  >
                    {livenessOk ? t('recoveryGroup.livenessOk') : t('recoveryGroup.livenessStale')}
                  </Badge>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Configuration fields */}
      <SectionField
        label={t('recoveryGroup.requiredApprovals')}
        htmlFor="recovery-threshold"
        error={thresholdError}
      >
        <Input
          id="recovery-threshold"
          data-testid="recovery-threshold"
          type="number"
          min={2}
          max={5}
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
        />
      </SectionField>

      <SectionField
        label={t('recoveryGroup.totalContacts')}
        htmlFor="recovery-total"
        error={totalError}
      >
        <Input
          id="recovery-total"
          data-testid="recovery-total"
          type="number"
          min={3}
          max={5}
          value={totalShares}
          onChange={(e) => setTotalShares(Number(e.target.value))}
        />
      </SectionField>

      <SectionField
        label={t('recoveryGroup.delayConfig')}
        htmlFor="recovery-delay"
        error={delayError}
        help="4–168 hours"
      >
        <Input
          id="recovery-delay"
          data-testid="recovery-delay"
          type="number"
          min={4}
          max={168}
          value={delayHours}
          onChange={(e) => setDelayHours(Number(e.target.value))}
        />
      </SectionField>

      <SectionField
        label={t('recoveryGroup.emergencyFloorConfig')}
        htmlFor="recovery-emergency-floor"
        error={emergencyError}
        help="1–24 hours"
      >
        <Input
          id="recovery-emergency-floor"
          data-testid="recovery-emergency-floor"
          type="number"
          min={1}
          max={24}
          value={emergencyFloorHours}
          onChange={(e) => setEmergencyFloorHours(Number(e.target.value))}
        />
      </SectionField>

      {/* Share holder picker */}
      <SectionField label={t('recoveryGroup.contacts')} error={holderCountError}>
        <div className="space-y-2 max-h-[300px] overflow-y-auto">
          {shareHolderCandidates.map((candidate) => (
            <button
              key={candidate.pubkey}
              type="button"
              data-testid={`recovery-holder-${candidate.pubkey.slice(0, 8)}`}
              className={`w-full flex items-center gap-3 rounded-lg border p-3 text-left text-sm transition-colors ${
                selectedHolders.includes(candidate.pubkey)
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-muted/50'
              }`}
              onClick={() => toggleHolder(candidate.pubkey)}
            >
              <Users className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{candidate.displayName}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {candidate.pubkey.slice(0, 16)}...
                </div>
              </div>
              {candidate.deviceVerified ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
              )}
              {selectedHolders.includes(candidate.pubkey) && (
                <Badge variant="default" className="shrink-0">
                  {t('recoveryGroup.selected')}
                </Badge>
              )}
            </button>
          ))}
          {shareHolderCandidates.length === 0 && (
            <div className="text-sm text-muted-foreground p-3">
              {t('recoveryGroup.noContacts')}
            </div>
          )}
        </div>
      </SectionField>

      {/* Geographic distribution advisory */}
      {selectedHolders.length >= 3 && selectedHolders.length === totalShares && (
        <SectionBanner tone="warn">
          <div className="flex items-start gap-2">
            <MapPin className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{t('recoveryGroup.geoWarning')}</span>
          </div>
        </SectionBanner>
      )}

      <SectionActions
        slug="recovery-group"
        onSave={handleEnroll}
        saving={saving}
        disabled={hasErrors}
        showSaved={showSaved}
        saveLabel={
          isRotation ? (
            <>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <RotateCw className="mr-2 h-4 w-4" />
              {t('recoveryGroup.rotate')}
            </>
          ) : (
            <>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('recoveryGroup.setup')}
            </>
          )
        }
      />
    </SectionBody>
  )
}
