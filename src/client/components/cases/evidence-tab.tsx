import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import {
  listEvidence,
  type EvidenceMetadata,
  type EvidenceClassification,
} from '@/lib/api'
import { formatRelativeTime } from '@/lib/format'
import { EvidenceDetailDialog } from './evidence-detail-dialog'
import { EvidenceUploadDialog } from './evidence-upload-dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  LayoutGrid,
  List,
  Upload,
  Image,
  Video,
  FileText,
  AudioLines,
  File,
  Loader2,
  Package,
} from 'lucide-react'
import { HelpTooltip } from '@/components/ui/help-tooltip'

// --- Classification icons & labels ---

const CLASSIFICATION_CONFIG: Record<EvidenceClassification, {
  icon: React.ComponentType<{ className?: string }>
  label: string
  color: string
}> = {
  photo: { icon: Image, label: 'Photo', color: '#3b82f6' },
  video: { icon: Video, label: 'Video', color: '#8b5cf6' },
  document: { icon: FileText, label: 'Document', color: '#f59e0b' },
  audio: { icon: AudioLines, label: 'Audio', color: '#22c55e' },
  other: { icon: File, label: 'Other', color: '#6b7280' },
}

function ClassificationBadge({ classification }: { classification: EvidenceClassification }) {
  const config = CLASSIFICATION_CONFIG[classification]
  const Icon = config.icon
  return (
    <Badge
      data-testid="evidence-classification-badge"
      variant="outline"
      className="gap-1"
      style={{ borderColor: config.color, color: config.color }}
    >
      <Icon className="h-3 w-3" />
      {config.label}
    </Badge>
  )
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

// --- Evidence Grid Item ---

function EvidenceGridItem({
  evidence,
  uploaderName,
  onClick,
}: {
  evidence: EvidenceMetadata
  uploaderName: string
  onClick: () => void
}) {
  const { t } = useTranslation()
  const config = CLASSIFICATION_CONFIG[evidence.classification]
  const Icon = config.icon

  return (
    <button
      type="button"
      data-testid="evidence-grid-item"
      onClick={onClick}
      className="flex flex-col rounded-lg border border-border bg-card p-3 text-left hover:bg-accent/50 transition-colors"
    >
      {/* Thumbnail / icon area */}
      <div className="flex h-24 items-center justify-center rounded-md bg-muted mb-2">
        {evidence.classification === 'photo' && evidence.mimeType.startsWith('image/') ? (
          <Image className="h-10 w-10 text-muted-foreground/50" />
        ) : (
          <Icon className="h-10 w-10 text-muted-foreground/50" />
        )}
      </div>

      <p className="text-sm font-medium truncate" title={evidence.filename}>
        {evidence.filename}
      </p>

      <div className="mt-1 flex items-center gap-2">
        <ClassificationBadge classification={evidence.classification} />
        <span className="text-xs text-muted-foreground">{formatFileSize(evidence.sizeBytes)}</span>
      </div>

      <div className="mt-1.5 text-xs text-muted-foreground">
        {uploaderName} &middot; {formatRelativeTime(evidence.uploadedAt, t)}
      </div>
    </button>
  )
}

// --- Evidence List Row ---

function EvidenceListRow({
  evidence,
  uploaderName,
  onClick,
}: {
  evidence: EvidenceMetadata
  uploaderName: string
  onClick: () => void
}) {
  const { t } = useTranslation()
  const config = CLASSIFICATION_CONFIG[evidence.classification]
  const Icon = config.icon

  return (
    <button
      type="button"
      data-testid="evidence-list-item"
      onClick={onClick}
      className="flex items-center gap-3 w-full rounded-lg border border-border bg-card px-3 py-2.5 text-left hover:bg-accent/50 transition-colors"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{evidence.filename}</p>
        <p className="text-xs text-muted-foreground">
          {formatFileSize(evidence.sizeBytes)} &middot; {uploaderName}
        </p>
      </div>

      <ClassificationBadge classification={evidence.classification} />

      <span className="text-xs text-muted-foreground shrink-0">
        {formatRelativeTime(evidence.uploadedAt, t)}
      </span>
    </button>
  )
}

// --- Main Evidence Tab ---

export interface EvidenceTabProps {
  /** Record/case ID */
  recordId: string
  /** The record's own hub (`record.hubId`) */
  hubId: string
  /** Map of pubkey -> display name */
  volunteerNames: Record<string, string>
  /** Reader pubkeys for encrypting evidence descriptions */
  readerPubkeys: string[]
}

export function EvidenceTab({
  recordId,
  hubId,
  volunteerNames,
  readerPubkeys,
}: EvidenceTabProps) {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [evidence, setEvidence] = useState<EvidenceMetadata[]>([])
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [classificationFilter, setClassificationFilter] = useState<string>('all')
  const [selectedEvidence, setSelectedEvidence] = useState<EvidenceMetadata | null>(null)
  const [showUpload, setShowUpload] = useState(false)

  // --- Load evidence ---
  const loadEvidence = useCallback(async () => {
    try {
      const classification = classificationFilter !== 'all'
        ? classificationFilter as EvidenceClassification
        : undefined
      const result = await listEvidence(recordId, { classification, limit: 100 }, hubId)
      setEvidence(result.evidence)
    } catch {
      toast(t('cases.evidence.loadError', { defaultValue: 'Failed to load evidence' }), 'error')
    } finally {
      setLoading(false)
    }
  }, [recordId, hubId, classificationFilter, t, toast])

  useEffect(() => {
    setLoading(true)
    loadEvidence()
  }, [loadEvidence])

  const handleUploadComplete = useCallback((newEvidence: EvidenceMetadata) => {
    setEvidence(prev => [newEvidence, ...prev])
    setShowUpload(false)
    toast(t('cases.evidence.uploadSuccess', { defaultValue: 'Evidence uploaded successfully' }))
  }, [t, toast])

  // --- Render ---

  if (loading) {
    return (
      <div data-testid="evidence-loading" className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div data-testid="evidence-tab" className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <HelpTooltip helpKey="evidenceTab" side="bottom" />
          {/* View mode toggle */}
          <div className="flex rounded-md border border-border">
            <Button
              variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
              size="icon-sm"
              data-testid="evidence-view-grid"
              onClick={() => setViewMode('grid')}
              aria-label={t('cases.evidence.gridView', { defaultValue: 'Grid view' })}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant={viewMode === 'list' ? 'secondary' : 'ghost'}
              size="icon-sm"
              data-testid="evidence-view-list"
              onClick={() => setViewMode('list')}
              aria-label={t('cases.evidence.listView', { defaultValue: 'List view' })}
            >
              <List className="h-3.5 w-3.5" />
            </Button>
          </div>

          {/* Classification filter */}
          <Select value={classificationFilter} onValueChange={setClassificationFilter}>
            <SelectTrigger size="sm" data-testid="evidence-classification-filter" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {t('cases.evidence.allTypes', { defaultValue: 'All types' })}
              </SelectItem>
              {(Object.keys(CLASSIFICATION_CONFIG) as EvidenceClassification[]).map(cls => (
                <SelectItem key={cls} value={cls}>
                  {CLASSIFICATION_CONFIG[cls].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          size="sm"
          data-testid="evidence-upload-btn"
          onClick={() => setShowUpload(true)}
          className="gap-1.5"
        >
          <Upload className="h-3.5 w-3.5" />
          {t('cases.evidence.upload', { defaultValue: 'Upload Evidence' })}
        </Button>
      </div>

      {/* Evidence list/grid */}
      <div className="flex-1 overflow-y-auto p-4">
        {evidence.length === 0 ? (
          <div data-testid="evidence-empty" className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <Package className="h-8 w-8 mb-2" />
            <p className="text-sm">
              {classificationFilter !== 'all'
                ? t('cases.evidence.noFilteredItems', { defaultValue: 'No evidence matches this filter' })
                : t('cases.evidence.noItems', { defaultValue: 'No evidence uploaded yet. Evidence files are encrypted and tracked with a chain of custody.' })
              }
            </p>
          </div>
        ) : viewMode === 'grid' ? (
          <div data-testid="evidence-grid" className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {evidence.map(item => (
              <EvidenceGridItem
                key={item.id}
                evidence={item}
                uploaderName={
                  volunteerNames[item.uploadedBy]
                  ?? item.uploadedBy.slice(0, 8) + '...'
                }
                onClick={() => setSelectedEvidence(item)}
              />
            ))}
          </div>
        ) : (
          <div data-testid="evidence-list" className="space-y-2">
            {evidence.map(item => (
              <EvidenceListRow
                key={item.id}
                evidence={item}
                uploaderName={
                  volunteerNames[item.uploadedBy]
                  ?? item.uploadedBy.slice(0, 8) + '...'
                }
                onClick={() => setSelectedEvidence(item)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Evidence detail dialog */}
      <EvidenceDetailDialog
        evidence={selectedEvidence}
        open={selectedEvidence !== null}
        onOpenChange={open => { if (!open) setSelectedEvidence(null) }}
        volunteerNames={volunteerNames}
      />

      {/* Upload dialog */}
      <EvidenceUploadDialog
        recordId={recordId}
        hubId={hubId}
        open={showUpload}
        onOpenChange={setShowUpload}
        onUploadComplete={handleUploadComplete}
        readerPubkeys={readerPubkeys}
      />
    </div>
  )
}
