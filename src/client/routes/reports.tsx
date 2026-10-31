import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { useToast } from '@/lib/toast'
import { useState, useEffect, useCallback } from 'react'
import {
  listReports,
  getReportMessages,
  sendReportMessage,
  assignReport,
  updateReport,
  getReportTypes,
  NoActiveHubError,
  type Report,
  type ConversationMessage,
} from '@/lib/api'
import type { ReportType } from '@shared/types'
import { encryptMessage } from '@/lib/platform'
import { formatRelativeTime } from '@/lib/format'
import { ReportForm } from '@/components/ReportForm'
import { FileUpload } from '@/components/FileUpload'
import { ConversationThread } from '@/components/ConversationThread'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  FileText, Plus, Lock, Send, Loader2, Clock,
  CheckCircle2, AlertCircle, UserCheck, X, Paperclip,
} from 'lucide-react'

export const Route = createFileRoute('/reports')({
  component: ReportsPage,
})

function ReportsPage() {
  const { t } = useTranslation()
  const { hasDeviceKey, publicKey, isAdmin, hasPermission, adminDecryptionPubkey } = useAuth()
  const { toast } = useToast()

  const [reports, setReports] = useState<Report[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [replyText, setReplyText] = useState('')
  const [sending, setSending] = useState(false)
  const [showFileUpload, setShowFileUpload] = useState(false)
  const [reportTypes, setReportTypes] = useState<ReportType[]>([])

  const selectedReport = reports.find(r => r.id === selectedId)

  // Load report types
  useEffect(() => {
    getReportTypes()
      .then(({ reportTypes: types }) => setReportTypes(types.filter(rt => !rt.isArchived)))
      .catch(() => {})
  }, [])

  // Fetch reports
  useEffect(() => {
    setLoading(true)
    const params: { status?: string; category?: string } = {}
    if (statusFilter !== 'all') params.status = statusFilter
    if (categoryFilter !== 'all') params.category = categoryFilter

    listReports(params)
      .then(({ conversations }) => setReports(conversations))
      .catch(err => {
        // No hub to browse is an empty list, not a failure to load one (#2405).
        if (!(err instanceof NoActiveHubError)) toast(t('reports.loadError', { defaultValue: 'Failed to load reports' }), 'error')
      })
      .finally(() => setLoading(false))
  }, [statusFilter, categoryFilter, t, toast])

  // Poll reports periodically
  useEffect(() => {
    const interval = setInterval(() => {
      const params: { status?: string; category?: string } = {}
      if (statusFilter !== 'all') params.status = statusFilter
      if (categoryFilter !== 'all') params.category = categoryFilter
      listReports(params)
        .then(({ conversations }) => setReports(conversations))
        .catch(err => {
          if (!(err instanceof NoActiveHubError)) console.error('[reports] Background report refresh failed')
        })
    }, 30_000)
    return () => clearInterval(interval)
  }, [statusFilter, categoryFilter])

  // Load messages when report is selected
  useEffect(() => {
    if (!selectedId) { setMessages([]); return }
    setMessagesLoading(true)
    getReportMessages(selectedId, { limit: 100 })
      .then(({ messages: msgs }) => setMessages(msgs))
      .catch(() => toast(t('reports.messagesError', { defaultValue: 'Failed to load messages' }), 'error'))
      .finally(() => setMessagesLoading(false))
  }, [selectedId, t, toast])

  // Poll messages for selected report
  useEffect(() => {
    if (!selectedId) return
    const interval = setInterval(() => {
      getReportMessages(selectedId, { limit: 100 })
        .then(({ messages: msgs }) => setMessages(msgs))
        .catch(() => {
          console.error('[reports] Background message refresh failed')
        })
    }, 10_000)
    return () => clearInterval(interval)
  }, [selectedId])

  const handleAssign = useCallback(async (reportId: string) => {
    if (!publicKey) return
    try {
      await assignReport(reportId, publicKey)
      setReports(prev => prev.map(r => r.id === reportId ? { ...r, assignedTo: publicKey, status: 'active' } : r))
      toast(t('reports.assigned', { defaultValue: 'Report assigned to you' }))
    } catch {
      toast(t('reports.assignError', { defaultValue: 'Failed to assign report' }), 'error')
    }
  }, [publicKey, toast, t])

  const handleClose = useCallback(async (reportId: string) => {
    try {
      await updateReport(reportId, { status: 'closed' })
      setReports(prev => prev.filter(r => r.id !== reportId))
      if (selectedId === reportId) setSelectedId(null)
      toast(t('reports.closed', { defaultValue: 'Report closed' }))
    } catch {
      toast(t('reports.closeError', { defaultValue: 'Failed to close report' }), 'error')
    }
  }, [selectedId, toast, t])

  const handleSendReply = useCallback(async () => {
    if (!selectedId || !replyText.trim() || !hasDeviceKey || !publicKey) return
    setSending(true)
    try {
      // Build reader list: current user + admin decryption pubkey
      const readerPubkeys = [publicKey]
      if (adminDecryptionPubkey && adminDecryptionPubkey !== publicKey) {
        readerPubkeys.push(adminDecryptionPubkey)
      }

      const encrypted = await encryptMessage(replyText.trim(), readerPubkeys)

      const msg = await sendReportMessage(selectedId, {
        encryptedContent: encrypted.encryptedContent,
        readerEnvelopes: encrypted.readerEnvelopes,
      })
      setMessages(prev => [msg, ...prev])
      setReplyText('')
    } catch {
      toast(t('reports.sendError', { defaultValue: 'Failed to send message' }), 'error')
    } finally {
      setSending(false)
    }
  }, [selectedId, replyText, hasDeviceKey, publicKey, adminDecryptionPubkey, toast, t])

  const handleFileUploadComplete = useCallback(async (fileIds: string[]) => {
    if (!selectedId || !hasDeviceKey || !publicKey) return
    try {
      // Build reader list: current user + admin decryption pubkey
      const readerPubkeys = [publicKey]
      if (adminDecryptionPubkey && adminDecryptionPubkey !== publicKey) {
        readerPubkeys.push(adminDecryptionPubkey)
      }

      const placeholder = t('reports.filesAttached', { defaultValue: '[Files attached]', count: fileIds.length })
      const encrypted = await encryptMessage(placeholder, readerPubkeys)

      const msg = await sendReportMessage(selectedId, {
        encryptedContent: encrypted.encryptedContent,
        readerEnvelopes: encrypted.readerEnvelopes,
        attachmentIds: fileIds,
      })
      setMessages(prev => [msg, ...prev])
      setShowFileUpload(false)
    } catch {
      toast(t('reports.sendError', { defaultValue: 'Failed to send message' }), 'error')
    }
  }, [selectedId, hasDeviceKey, publicKey, adminDecryptionPubkey, toast, t])

  const handleReportCreated = useCallback((reportId: string) => {
    // Refresh reports list and select the new one.
    // Set loading so the list panel stays rendered (not empty state) while fetching.
    setLoading(true)
    listReports()
      .then(({ conversations }) => {
        setReports(conversations)
        setSelectedId(reportId)
      })
      .catch(() => toast(t('common.error'), 'error'))
      .finally(() => setLoading(false))
  }, [t, toast])

  const showEmptyState = !loading && reports.length === 0

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <FileText className="h-6 w-6 text-primary" />
          <h1 data-testid="page-title" className="text-xl font-bold sm:text-2xl">{t('reports.title', { defaultValue: 'Reports' })}</h1>
        </div>
        <Button size="sm" data-testid="report-new-btn" onClick={() => setShowForm(true)}>
          <Plus className="h-3.5 w-3.5" />
          {t('reports.new', { defaultValue: 'New' })}
        </Button>
      </div>

      {isAdmin && (
        <div data-testid="report-filter-area" className="flex gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger data-testid="report-status-filter" size="sm" className="flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem data-testid="report-status-option-all" value="all">{t('reports.allStatuses', { defaultValue: 'All statuses' })}</SelectItem>
              <SelectItem data-testid="report-status-option-waiting" value="waiting">{t('reports.statusWaiting', { defaultValue: 'Waiting' })}</SelectItem>
              <SelectItem data-testid="report-status-option-active" value="active">{t('reports.statusActive', { defaultValue: 'Active' })}</SelectItem>
              <SelectItem data-testid="report-status-option-closed" value="closed">{t('reports.statusClosed', { defaultValue: 'Closed' })}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger data-testid="report-category-filter" size="sm" className="flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('reports.allCategories', { defaultValue: 'All categories' })}</SelectItem>
              {reportTypes.map(rt => (
                <SelectItem key={rt.id} value={rt.name}>{rt.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {showEmptyState ? (
        <Card data-testid="empty-state">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <FileText className="mb-3 h-10 w-10 text-muted-foreground/40" />
            <p className="text-muted-foreground">{t('reports.noReports', { defaultValue: 'No reports' })}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('reports.noReportsHint', { defaultValue: 'Reports submitted by volunteers and reporters will appear here.' })}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex h-[calc(100vh-12rem)] gap-4">
          {/* Report list sidebar */}
          <div data-testid="report-list" className="w-80 shrink-0 overflow-y-auto rounded-lg border border-border bg-card">
            <div className="sticky top-0 z-10 border-b border-border bg-card p-3 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  {t('reports.title', { defaultValue: 'Reports' })}
                </h2>
              </div>

            </div>

            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="p-2 space-y-1.5">
                {reports.map(report => (
                  <ReportCard
                    key={report.id}
                    report={report}
                    isSelected={selectedId === report.id}
                    onSelect={setSelectedId}
                    reportTypes={reportTypes}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Report detail */}
          <div data-testid="report-detail" className="flex flex-1 flex-col rounded-lg border border-border bg-card overflow-hidden">
            {selectedReport ? (
              <ReportDetail
                report={selectedReport}
                messages={messages}
                messagesLoading={messagesLoading}
                replyText={replyText}
                onReplyChange={setReplyText}
                onSend={handleSendReply}
                sending={sending}
                onAssign={handleAssign}
                onClose={handleClose}
                isAdmin={isAdmin}
                hasPermission={hasPermission}
                showFileUpload={showFileUpload}
                onToggleFileUpload={() => setShowFileUpload(prev => !prev)}
                onFileUploadComplete={handleFileUploadComplete}
              />
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground">
                <FileText className="h-10 w-10 mb-3" />
                <p>{t('reports.selectReport', { defaultValue: 'Select a report to view details' })}</p>
              </div>
            )}
          </div>
        </div>
      )}

      <ReportForm
        open={showForm}
        onOpenChange={setShowForm}
        onCreated={handleReportCreated}
      />
    </div>
  )
}

function ReportCard({ report, isSelected, onSelect, reportTypes }: {
  report: Report
  isSelected: boolean
  onSelect: (id: string) => void
  reportTypes: ReportType[]
}) {
  const { t } = useTranslation()

  const statusIcon = report.status === 'active'
    ? <span className="inline-block h-2.5 w-2.5 rounded-full bg-green-500" />
    : report.status === 'waiting'
      ? <span className="inline-block h-2.5 w-2.5 rounded-full bg-yellow-500" />
      : <span className="inline-block h-2.5 w-2.5 rounded-full bg-gray-400" />

  const relativeTime = formatRelativeTime(report.lastMessageAt ?? report.updatedAt, t)

  // Resolve report type name: prefer the typed system, fall back to category string
  const reportTypeName = report.metadata?.reportTypeId
    ? reportTypes.find(rt => rt.id === report.metadata?.reportTypeId)?.name || report.metadata?.reportCategory
    : report.metadata?.reportCategory

  return (
    <button
      type="button"
      data-testid="report-card"
      onClick={() => onSelect(report.id)}
      className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
        isSelected
          ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
          : 'border-border bg-card hover:bg-accent/50'
      }`}
    >
      <div className="flex items-center gap-2">
        {statusIcon}
        <span className="truncate text-sm font-medium text-foreground flex-1">
          {report.metadata?.reportTitle || t('reports.untitled', { defaultValue: 'Untitled Report' })}
        </span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
          <Clock className="h-3 w-3" />
          {relativeTime}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        {reportTypeName && (
          <Badge data-testid="report-type-badge" variant="secondary" className="text-[10px]">
            {reportTypeName}
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          {report.messageCount} {t('reports.messagesLabel', { defaultValue: 'messages' })}
        </span>
      </div>
    </button>
  )
}

function ReportDetail({ report, messages, messagesLoading, replyText, onReplyChange, onSend, sending, onAssign, onClose, isAdmin, hasPermission, showFileUpload, onToggleFileUpload, onFileUploadComplete }: {
  report: Report
  messages: ConversationMessage[]
  messagesLoading: boolean
  replyText: string
  onReplyChange: (text: string) => void
  onSend: () => void
  sending: boolean
  onAssign: (id: string) => void
  onClose: (id: string) => void
  isAdmin: boolean
  hasPermission: (permission: string) => boolean
  showFileUpload: boolean
  onToggleFileUpload: () => void
  onFileUploadComplete: (fileIds: string[]) => void
}) {
  const { t } = useTranslation()
  const { hasDeviceKey, publicKey } = useAuth()

  const isReporter = hasPermission('reports:create') && !hasPermission('calls:answer')
  const canReply = report.status === 'active' || isReporter

  return (
    <>
      {/* Header */}
      <div data-testid="report-metadata" className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">
            {report.metadata?.reportTitle || t('reports.untitled', { defaultValue: 'Untitled Report' })}
          </p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Lock className="h-3 w-3" />
            {t('reports.e2ee', { defaultValue: 'End-to-end encrypted' })}
            {(report.metadata?.reportCategory || report.metadata?.reportTypeId) && (
              <>
                <span className="mx-1">·</span>
                <Badge data-testid="report-type-badge" variant="secondary" className="text-[10px]">
                  {report.metadata.reportCategory || report.metadata.reportTypeId}
                </Badge>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-3">
          {report.status === 'waiting' && (isAdmin || hasPermission('calls:answer')) && (
            <Button size="sm" data-testid="report-claim-btn" onClick={() => onAssign(report.id)}>
              <UserCheck className="h-3.5 w-3.5" />
              {t('reports.claim', { defaultValue: 'Claim' })}
            </Button>
          )}
          {report.status === 'active' && isAdmin && (
            <Button size="sm" variant="outline" data-testid="close-report" onClick={() => onClose(report.id)}>
              <X className="h-3.5 w-3.5" />
              {t('reports.closeReport', { defaultValue: 'Close' })}
            </Button>
          )}
          <ReportStatusBadge status={report.status ?? 'active'} />
        </div>
      </div>

      {/* Messages thread — uses shared ConversationThread */}
      <ConversationThread
        conversationId={report.id}
        messages={messages}
        isLoading={messagesLoading}
      />

      {/* File upload area */}
      {showFileUpload && hasDeviceKey && publicKey && (
        <div className="border-t border-border px-4 py-3">
          <FileUpload
            conversationId={report.id}
            recipientPubkeys={[publicKey]}
            onUploadComplete={onFileUploadComplete}
          />
        </div>
      )}

      {/* Composer */}
      {canReply && (
        <div className="border-t border-border bg-background px-4 py-3">
          <div className="flex items-center gap-1.5 mb-2 text-xs text-muted-foreground">
            <Lock className="h-3 w-3" />
            <span>{t('notes.encryptionNote', { defaultValue: 'Notes are encrypted end-to-end' })}</span>
          </div>
          <div className="flex items-end gap-2">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onToggleFileUpload}
              aria-label={t('reports.attachFile', { defaultValue: 'Attach file' })}
              className="shrink-0 text-muted-foreground"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            <textarea
              value={replyText}
              onChange={e => onReplyChange(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSend() } }}
              placeholder={t('reports.replyPlaceholder', { defaultValue: 'Type your reply...' })}
              rows={1}
              className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <Button
              size="icon-sm"
              disabled={!replyText.trim() || sending}
              onClick={onSend}
              aria-label={t('common.submit')}
              className="shrink-0"
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      )}
    </>
  )
}

function ReportStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation()

  if (status === 'active') {
    return (
      <Badge data-testid="report-status-badge" variant="secondary" className="gap-1">
        <CheckCircle2 className="h-3 w-3 text-green-500" />
        {t('reports.statusActive', { defaultValue: 'Active' })}
      </Badge>
    )
  }
  if (status === 'waiting') {
    return (
      <Badge data-testid="report-status-badge" variant="secondary" className="gap-1">
        <AlertCircle className="h-3 w-3 text-yellow-500" />
        {t('reports.statusWaiting', { defaultValue: 'Waiting' })}
      </Badge>
    )
  }
  return (
    <Badge data-testid="report-status-badge" variant="secondary" className="gap-1 text-muted-foreground">
      {t('reports.statusClosed', { defaultValue: 'Closed' })}
    </Badge>
  )
}
