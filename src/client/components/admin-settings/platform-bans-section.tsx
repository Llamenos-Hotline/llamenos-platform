import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { SettingsSection } from '@/components/settings-section'
import {
  SectionField,
  SectionDescription,
} from '@/components/admin-shell/section-layout'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Loader2, Shield, Search, Upload, Trash2 } from 'lucide-react'
import {
  createPlatformBan,
  deletePlatformBan,
  bulkImportPlatformBans,
  searchPlatformBans,
} from '@/lib/api'
import type { PlatformBan } from '@protocol/schemas/bans'
import { DeletionConfirmed } from '@/lib/admin-deletion'

interface Props {
  bans: PlatformBan[]
  total: number
  onRefresh: () => void
  expanded: boolean
  onToggle: (open: boolean) => void
  statusSummary?: string
}

export function PlatformBansSection({ bans, total, onRefresh, expanded, onToggle, statusSummary }: Props) {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [newPhoneHash, setNewPhoneHash] = useState('')
  const [newReason, setNewReason] = useState('')
  const [creating, setCreating] = useState(false)

  const [showBulkDialog, setShowBulkDialog] = useState(false)
  const [bulkPhoneHashes, setBulkPhoneHashes] = useState('')
  const [bulkReason, setBulkReason] = useState('')
  const [bulkImporting, setBulkImporting] = useState(false)

  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<(PlatformBan & { scope: 'hub' | 'platform' })[] | null>(null)
  const [searching, setSearching] = useState(false)

  const [deleting, setDeleting] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState<PlatformBan | null>(null)

  async function handleCreate() {
    if (!newPhoneHash.trim() || !newReason.trim()) return
    setCreating(true)
    try {
      await createPlatformBan({ phoneHash: newPhoneHash.trim(), reason: newReason.trim() })
      toast(t('platformBans.created'), 'success')
      setShowCreateDialog(false)
      setNewPhoneHash('')
      setNewReason('')
      onRefresh()
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setCreating(false)
    }
  }

  async function handleBulkImport() {
    const hashes = bulkPhoneHashes.split('\n').map(h => h.trim()).filter(Boolean)
    if (hashes.length === 0 || !bulkReason.trim()) return
    setBulkImporting(true)
    try {
      const { count } = await bulkImportPlatformBans({ phoneHashes: hashes, reason: bulkReason.trim() })
      toast(t('platformBans.bulkImported', { count }), 'success')
      setShowBulkDialog(false)
      setBulkPhoneHashes('')
      setBulkReason('')
      onRefresh()
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setBulkImporting(false)
    }
  }

  async function handleSearch() {
    if (!searchQuery.trim()) return
    setSearching(true)
    try {
      const { bans } = await searchPlatformBans(searchQuery.trim())
      setSearchResults(bans)
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setSearching(false)
    }
  }

  async function handleDelete(id: string, confirmed: DeletionConfirmed) {
    setDeleting(id)
    try {
      await deletePlatformBan(id, confirmed)
      toast(t('platformBans.deleted'), 'success')
      onRefresh()
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setDeleting(null)
    }
  }

  return (
    <SettingsSection
      id="platform-bans"
      title={t('platformBans.title')}
      icon={<Shield className="h-5 w-5 text-muted-foreground" />}
      expanded={expanded}
      onToggle={onToggle}
      statusSummary={statusSummary}
    >
      <SectionDescription>{t('platformBans.description')}</SectionDescription>

      {/* Search bar */}
      <div className="flex items-center gap-2 mb-4">
        <Input
          data-testid="platform-bans-search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('platformBans.searchPlaceholder')}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          className="max-w-sm"
        />
        <Button
          variant="outline"
          size="sm"
          data-testid="platform-bans-search-btn"
          onClick={handleSearch}
          disabled={searching}
        >
          {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
        </Button>
      </div>

      {/* Search results */}
      {searchResults !== null && (
        <div className="mb-4 rounded-lg border border-border p-3" data-testid="platform-bans-search-results">
          <h4 className="text-sm font-medium mb-2">{t('platformBans.searchResults', { count: searchResults.length })}</h4>
          {searchResults.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('platformBans.noResults')}</p>
          ) : (
            <div className="space-y-1">
              {searchResults.map((ban) => (
                <div key={ban.id} className="flex items-center justify-between text-sm py-1">
                  <div>
                    <span className="font-mono text-xs">{ban.phoneHash.slice(0, 16)}...</span>
                    <Badge variant="outline" className="ml-2">{ban.scope}</Badge>
                  </div>
                  <span className="text-muted-foreground">{ban.reason}</span>
                </div>
              ))}
            </div>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => setSearchResults(null)}
          >
            {t('platformBans.clearSearch')}
          </Button>
        </div>
      )}

      {/* Ban list */}
      {bans.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="platform-bans-empty">
          {t('platformBans.noBans')}
        </p>
      ) : (
        <div className="space-y-2" data-testid="platform-bans-list">
          {bans.map((ban) => (
            <div
              key={ban.id}
              className="flex items-center justify-between rounded-lg border border-border p-3"
              data-testid={`platform-ban-${ban.id}`}
            >
              <div className="space-y-0.5">
                <div className="font-mono text-xs">{ban.phoneHash.slice(0, 16)}...</div>
                <div className="text-xs text-muted-foreground">{ban.reason}</div>
                <div className="text-xs text-muted-foreground">
                  {new Date(ban.bannedAt).toLocaleDateString()}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                data-testid={`platform-ban-delete-${ban.id}`}
                onClick={() => setConfirmingDelete(ban)}
                disabled={deleting === ban.id}
              >
                {deleting === ban.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4 text-destructive" />}
              </Button>
            </div>
          ))}
          <p className="text-xs text-muted-foreground mt-2">
            {t('platformBans.totalCount', { count: total })}
          </p>
        </div>
      )}

      {confirmingDelete && (
        <DeletionConfirmed.Dialog
          action="platformBan"
          targetId={confirmingDelete.id}
          subject={confirmingDelete.reason}
          open
          onOpenChange={(open) => { if (!open) setConfirmingDelete(null) }}
          onConfirmed={(confirmed) => handleDelete(confirmingDelete.id, confirmed)}
        />
      )}

      {/* Actions */}
      <div className="mt-4 flex flex-wrap gap-3 border-t border-border/60 pt-5">
        <Button data-testid="platform-bans-create-btn" onClick={() => setShowCreateDialog(true)}>
          {t('platformBans.createBan')}
        </Button>
        <Button variant="outline" data-testid="platform-bans-bulk-btn" onClick={() => setShowBulkDialog(true)}>
          <Upload className="mr-2 h-4 w-4" />
          {t('platformBans.bulkImport')}
        </Button>
      </div>

      {/* Create Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('platformBans.createDialogTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <SectionField label={t('platformBans.phoneHash')} htmlFor="ban-phone-hash" required>
              <Input
                id="ban-phone-hash"
                data-testid="ban-phone-hash-input"
                value={newPhoneHash}
                onChange={(e) => setNewPhoneHash(e.target.value)}
                placeholder={t('platformBans.phoneHashPlaceholder')}
              />
            </SectionField>
            <SectionField label={t('platformBans.reason')} htmlFor="ban-reason" required>
              <Input
                id="ban-reason"
                data-testid="ban-reason-input"
                value={newReason}
                onChange={(e) => setNewReason(e.target.value)}
                placeholder={t('platformBans.reasonPlaceholder')}
              />
            </SectionField>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              data-testid="ban-create-confirm-btn"
              onClick={handleCreate}
              disabled={creating || !newPhoneHash.trim() || !newReason.trim()}
            >
              {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('platformBans.confirmCreate')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Import Dialog */}
      <Dialog open={showBulkDialog} onOpenChange={setShowBulkDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('platformBans.bulkDialogTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <SectionField label={t('platformBans.phoneHashList')} htmlFor="bulk-phone-hashes" required>
              <Textarea
                id="bulk-phone-hashes"
                data-testid="bulk-phone-hashes-input"
                value={bulkPhoneHashes}
                onChange={(e) => setBulkPhoneHashes(e.target.value)}
                placeholder={t('platformBans.bulkPlaceholder')}
                rows={6}
              />
            </SectionField>
            <SectionField label={t('platformBans.reason')} htmlFor="bulk-reason" required>
              <Input
                id="bulk-reason"
                data-testid="bulk-reason-input"
                value={bulkReason}
                onChange={(e) => setBulkReason(e.target.value)}
              />
            </SectionField>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBulkDialog(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              data-testid="bulk-import-confirm-btn"
              onClick={handleBulkImport}
              disabled={bulkImporting || !bulkPhoneHashes.trim() || !bulkReason.trim()}
            >
              {bulkImporting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('platformBans.confirmBulkImport')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  )
}
