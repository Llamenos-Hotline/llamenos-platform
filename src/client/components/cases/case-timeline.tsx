import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { useToast } from '@/lib/toast'
import {
  listInteractions,
  type CaseInteraction,
  type InteractionType,
} from '@/lib/api'
import { openCase } from '@/lib/platform'
import { postCaseComment } from '@/lib/case-writes'
import * as keyManager from '@/lib/key-manager'
import { TimelineItem } from './timeline-item'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  ArrowUpDown,
  Loader2,
  Send,
  History,
} from 'lucide-react'
import { HelpTooltip } from '@/components/ui/help-tooltip'

// --- Filter types for dropdown ---

const FILTER_TYPES = [
  { value: 'all', label: 'All Types' },
  { value: 'note', label: 'Notes' },
  { value: 'call', label: 'Calls' },
  { value: 'status_change', label: 'Status Changes' },
  { value: 'comment', label: 'Comments' },
  { value: 'file_upload', label: 'Files' },
  { value: 'message', label: 'Messages' },
  { value: 'referral', label: 'Referrals' },
  { value: 'assessment', label: 'Assessments' },
] as const

export interface CaseTimelineProps {
  /** Record ID to load interactions for */
  recordId: string
  /** The record's own hub (`record.hubId`): comments are sealed to its admins and filed in it. */
  hubId: string
  /** Map of pubkey -> display name for resolving author names */
  volunteerNames: Record<string, string>
  /** Reader pubkeys for encrypting new comments */
  readerPubkeys: string[]
  /** Status hash -> label/color mapping for status_change rendering */
  statusLabels?: Record<string, { label: string; color: string }>
  /** Hash function for blind index (interactionTypeHash) */
  computeTypeHash?: (type: InteractionType) => string
}

export function CaseTimeline({
  recordId,
  hubId,
  volunteerNames,
  readerPubkeys,
  statusLabels,
  computeTypeHash,
}: CaseTimelineProps) {
  const { t } = useTranslation()
  const { hasDeviceKey, publicKey } = useAuth()
  const { toast } = useToast()

  // --- State ---
  const [interactions, setInteractions] = useState<CaseInteraction[]>([])
  const [loading, setLoading] = useState(true)
  const [newestFirst, setNewestFirst] = useState(true)
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [decryptedMap, setDecryptedMap] = useState<Map<string, string>>(new Map())
  const [commentText, setCommentText] = useState('')
  const [sending, setSending] = useState(false)

  // --- Load interactions ---
  const loadInteractions = useCallback(async () => {
    try {
      const result = await listInteractions(recordId, { limit: 200 }, hubId)
      setInteractions(result.interactions)
    } catch {
      toast(t('cases.timeline.loadError', { defaultValue: 'Failed to load timeline' }), 'error')
    } finally {
      setLoading(false)
    }
  }, [recordId, hubId, t, toast])

  useEffect(() => {
    setLoading(true)
    loadInteractions()
  }, [loadInteractions])

  // Poll for updates
  useEffect(() => {
    const interval = setInterval(() => {
      listInteractions(recordId, { limit: 200 }, hubId)
        .then(result => setInteractions(result.interactions))
        .catch(() => { /* silent background refresh */ })
    }, 15_000)
    return () => clearInterval(interval)
  }, [recordId, hubId])

  // --- Decrypt interaction content ---
  useEffect(() => {
    if (interactions.length === 0 || !publicKey) return
    if (!hasDeviceKey || !keyManager.isUnlocked()) return

    ;(async () => {
      const newMap = new Map<string, string>()
      for (const interaction of interactions) {
        if (interaction.encryptedContent && interaction.contentEnvelopes?.length) {
          const plaintext = await openCase(
            'comment',
            interaction.encryptedContent,
            interaction.contentEnvelopes,
          )
          if (plaintext !== null) {
            newMap.set(interaction.id, plaintext)
          }
        }
      }
      setDecryptedMap(newMap)
    })()
  }, [interactions, hasDeviceKey, publicKey])

  // --- Filter and sort ---
  const filteredInteractions = interactions.filter(i => {
    if (typeFilter === 'all') return true
    return i.interactionType === typeFilter
  })

  const sortedInteractions = [...filteredInteractions].sort((a, b) => {
    const diff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    return newestFirst ? -diff : diff
  })

  // --- Post comment ---
  const handlePostComment = useCallback(async () => {
    if (!commentText.trim() || !hasDeviceKey || !publicKey) return
    setSending(true)
    try {
      // Sealed to the case's readers and every admin of the RECORD's hub
      // (#1035) — not the hub being browsed — and filed in that hub.
      const newInteraction = await postCaseComment(
        { id: recordId, hubId },
        commentText.trim(),
        publicKey,
        readerPubkeys,
        computeTypeHash?.('comment') ?? '',
      )

      setInteractions(prev => [newInteraction, ...prev])
      setDecryptedMap(prev => {
        const next = new Map(prev)
        next.set(newInteraction.id, commentText.trim())
        return next
      })
      setCommentText('')
    } catch {
      toast(t('cases.timeline.commentError', { defaultValue: 'Failed to post comment' }), 'error')
    } finally {
      setSending(false)
    }
  }, [commentText, hasDeviceKey, publicKey, readerPubkeys, recordId, hubId, computeTypeHash, t, toast])

  // --- Render ---

  if (loading) {
    return (
      <div data-testid="timeline-loading" className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div data-testid="case-timeline" className="flex flex-col h-full">
      {/* Toolbar: sort toggle + type filter */}
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <HelpTooltip helpKey="caseTimeline" side="bottom" />
          <Button
            variant="ghost"
            size="sm"
            data-testid="timeline-sort-toggle"
            onClick={() => setNewestFirst(prev => !prev)}
            className="gap-1.5"
          >
            <ArrowUpDown className="h-3.5 w-3.5" />
            {newestFirst
              ? t('cases.timeline.newestFirst', { defaultValue: 'Newest first' })
              : t('cases.timeline.oldestFirst', { defaultValue: 'Oldest first' })
            }
          </Button>
        </div>

        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger size="sm" data-testid="timeline-type-filter" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FILTER_TYPES.map(ft => (
              <SelectItem key={ft.value} value={ft.value}>
                {t(`cases.timeline.filter.${ft.value}`, { defaultValue: ft.label })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Timeline items */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {sortedInteractions.length === 0 ? (
          <div data-testid="timeline-empty" className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <History className="h-8 w-8 mb-2" />
            <p className="text-sm">
              {typeFilter !== 'all'
                ? t('cases.timeline.noFilteredItems', { defaultValue: 'No items match this filter' })
                : t('cases.timeline.noItems', { defaultValue: 'No timeline activity yet' })
              }
            </p>
          </div>
        ) : (
          <div data-testid="timeline-items">
            {sortedInteractions.map((interaction, index) => (
              <TimelineItem
                key={interaction.id}
                interaction={interaction}
                decryptedText={decryptedMap.get(interaction.id) ?? null}
                authorName={
                  volunteerNames[interaction.authorPubkey]
                  ?? interaction.authorPubkey.slice(0, 8) + '...'
                }
                isLast={index === sortedInteractions.length - 1}
                statusLabels={statusLabels}
              />
            ))}
          </div>
        )}
      </div>

      {/* Inline comment composer */}
      {hasDeviceKey && (
        <div data-testid="timeline-comment-composer" className="border-t border-border px-4 py-3">
          <div className="flex items-end gap-2">
            <Textarea
              data-testid="timeline-comment-input"
              value={commentText}
              onChange={e => setCommentText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  handlePostComment()
                }
              }}
              placeholder={t('cases.timeline.commentPlaceholder', { defaultValue: 'Add a comment...' })}
              rows={2}
              className="flex-1 resize-none"
            />
            <Button
              size="icon-sm"
              data-testid="timeline-comment-submit"
              disabled={!commentText.trim() || sending}
              onClick={handlePostComment}
              aria-label={t('cases.timeline.postComment', { defaultValue: 'Post comment' })}
              className="shrink-0"
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
