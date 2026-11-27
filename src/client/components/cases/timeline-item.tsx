import { useTranslation } from 'react-i18next'
import type { CaseInteraction, InteractionType } from '@/lib/api'
import { formatRelativeTime } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import {
  FileText,
  Phone,
  MessageSquare,
  ArrowRightLeft,
  MessageCircle,
  Paperclip,
  ClipboardList,
  Stethoscope,
} from 'lucide-react'

// --- Type icon mapping ---

const INTERACTION_ICONS: Record<InteractionType, React.ComponentType<{ className?: string }>> = {
  note: FileText,
  call: Phone,
  message: MessageSquare,
  status_change: ArrowRightLeft,
  comment: MessageCircle,
  file_upload: Paperclip,
  referral: ClipboardList,
  assessment: Stethoscope,
}

const INTERACTION_TYPE_LABELS: Record<InteractionType, string> = {
  note: 'Note',
  call: 'Call',
  message: 'Message',
  status_change: 'Status Change',
  comment: 'Comment',
  file_upload: 'File Uploaded',
  referral: 'Referral',
  assessment: 'Assessment',
}

// --- Type-specific content renderers ---

interface TypeContentProps {
  interaction: CaseInteraction
  decryptedText: string | null
  authorName: string
  /** Mapping of status hashes to readable labels, provided by parent */
  statusLabels?: Record<string, { label: string; color: string }>
}

function NoteContent({ decryptedText }: TypeContentProps) {
  const { t } = useTranslation()
  const preview = decryptedText
    ? decryptedText.length > 200
      ? decryptedText.slice(0, 200) + '...'
      : decryptedText
    : t('cases.timeline.encrypted', { defaultValue: '[Encrypted]' })

  return (
    <div>
      <p className="text-sm text-foreground whitespace-pre-wrap">{preview}</p>
      {decryptedText && decryptedText.length > 200 && (
        <button
          type="button"
          data-testid="timeline-view-full-note"
          className="mt-1 text-xs text-primary hover:underline"
        >
          {t('cases.timeline.viewFullNote', { defaultValue: 'View full note' })}
        </button>
      )}
    </div>
  )
}

function CallContent({ decryptedText }: TypeContentProps) {
  const { t } = useTranslation()
  return (
    <p className="text-sm text-foreground">
      {decryptedText ?? t('cases.timeline.callLinked', { defaultValue: 'Call linked to case' })}
    </p>
  )
}

function MessageContent({ decryptedText }: TypeContentProps) {
  const { t } = useTranslation()
  const preview = decryptedText
    ? decryptedText.length > 150
      ? decryptedText.slice(0, 150) + '...'
      : decryptedText
    : t('cases.timeline.encrypted', { defaultValue: '[Encrypted]' })

  return <p className="text-sm text-foreground whitespace-pre-wrap">{preview}</p>
}

function parseStatusChange(decryptedText: string | null | undefined): { text?: string; previous?: string; next?: string } {
  if (!decryptedText) return {}
  try {
    const parsed = JSON.parse(decryptedText) as { text?: string; previousStatus?: string; newStatus?: string }
    return { text: parsed.text || undefined, previous: parsed.previousStatus, next: parsed.newStatus }
  } catch {
    return { text: decryptedText }
  }
}

function StatusChangeContent({ decryptedText, statusLabels }: TypeContentProps) {
  const { t } = useTranslation()

  // The transition is sealed with the entry: {text, previousStatus, newStatus}, the
  // statuses being the entity type's values. The server knows neither.
  const change = parseStatusChange(decryptedText)
  const prevLabel = change.previous && statusLabels?.[change.previous]
  const newLabel = change.next && statusLabels?.[change.next]

  if (change.text) {
    return <p className="text-sm text-foreground">{change.text}</p>
  }

  return (
    <div className="flex items-center gap-2 text-sm">
      {prevLabel ? (
        <Badge
          data-testid="timeline-status-old"
          variant="outline"
          style={prevLabel.color ? { borderColor: prevLabel.color, color: prevLabel.color } : undefined}
        >
          {prevLabel.label}
        </Badge>
      ) : (
        <Badge data-testid="timeline-status-old" variant="outline">
          {t('cases.timeline.unknownStatus', { defaultValue: 'Unknown' })}
        </Badge>
      )}
      <ArrowRightLeft className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      {newLabel ? (
        <Badge
          data-testid="timeline-status-new"
          variant="secondary"
          style={newLabel.color ? { backgroundColor: `${newLabel.color}20`, color: newLabel.color, borderColor: newLabel.color } : undefined}
        >
          {newLabel.label}
        </Badge>
      ) : (
        <Badge data-testid="timeline-status-new" variant="secondary">
          {t('cases.timeline.unknownStatus', { defaultValue: 'Unknown' })}
        </Badge>
      )}
    </div>
  )
}

function CommentContent({ decryptedText }: TypeContentProps) {
  const { t } = useTranslation()
  return (
    <p className="text-sm text-foreground whitespace-pre-wrap">
      {decryptedText ?? t('cases.timeline.encrypted', { defaultValue: '[Encrypted]' })}
    </p>
  )
}

function FileUploadContent({ decryptedText }: TypeContentProps) {
  const { t } = useTranslation()
  return (
    <p className="text-sm text-foreground">
      {decryptedText ?? t('cases.timeline.fileUploaded', { defaultValue: 'File uploaded' })}
    </p>
  )
}

function ReferralContent({ decryptedText }: TypeContentProps) {
  const { t } = useTranslation()
  return (
    <p className="text-sm text-foreground">
      {decryptedText ?? t('cases.timeline.referral', { defaultValue: 'Case referred' })}
    </p>
  )
}

function AssessmentContent({ decryptedText }: TypeContentProps) {
  const { t } = useTranslation()
  return (
    <p className="text-sm text-foreground">
      {decryptedText ?? t('cases.timeline.assessment', { defaultValue: 'Assessment conducted' })}
    </p>
  )
}

const CONTENT_RENDERERS: Record<InteractionType, React.ComponentType<TypeContentProps>> = {
  note: NoteContent,
  call: CallContent,
  message: MessageContent,
  status_change: StatusChangeContent,
  comment: CommentContent,
  file_upload: FileUploadContent,
  referral: ReferralContent,
  assessment: AssessmentContent,
}

// --- Main TimelineItem component ---

export interface TimelineItemProps {
  interaction: CaseInteraction
  /** Decrypted plaintext of the interaction content, or null if not decryptable */
  decryptedText: string | null
  /** Display name of the author */
  authorName: string
  /** Whether this is the last item in the list (hides connector line) */
  isLast: boolean
  /** Status hash -> label/color mapping for status_change rendering */
  statusLabels?: Record<string, { label: string; color: string }>
}

export function TimelineItem({
  interaction,
  decryptedText,
  authorName,
  isLast,
  statusLabels,
}: TimelineItemProps) {
  const { t } = useTranslation()
  const Icon = INTERACTION_ICONS[interaction.interactionType] ?? FileText
  const typeLabel = INTERACTION_TYPE_LABELS[interaction.interactionType] ?? interaction.interactionType
  const ContentRenderer = CONTENT_RENDERERS[interaction.interactionType] ?? NoteContent

  return (
    <div data-testid="timeline-item" className="flex gap-3">
      {/* Icon column with connecting line */}
      <div className="flex flex-col items-center">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        {!isLast && (
          <div className="flex-1 w-px bg-border min-h-4" />
        )}
      </div>

      {/* Content column */}
      <div className="flex-1 pb-4 min-w-0">
        {/* Header: type label, author, time */}
        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
          <span data-testid="timeline-item-type" className="font-medium text-foreground">
            {typeLabel}
          </span>
          <span aria-hidden="true">&middot;</span>
          <span data-testid="timeline-item-author">{authorName}</span>
          <span aria-hidden="true">&middot;</span>
          <time
            data-testid="timeline-item-time"
            dateTime={interaction.createdAt}
            title={new Date(interaction.createdAt).toLocaleString()}
          >
            {formatRelativeTime(interaction.createdAt, t)}
          </time>
        </div>

        {/* Type-specific content */}
        <ContentRenderer
          interaction={interaction}
          decryptedText={decryptedText}
          authorName={authorName}
          statusLabels={statusLabels}
        />
      </div>
    </div>
  )
}
