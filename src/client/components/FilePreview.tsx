import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { FileAccessDeniedError, openStoredFile } from '@/lib/stored-file'
import * as keyManager from '@/lib/key-manager'
import { FileIcon, ImageIcon, VideoIcon, Music, Download, Loader2, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { EncryptedFileMetadata } from '@shared/types'

interface FilePreviewProps {
  fileId: string
  /**
   * The hub the file belongs to — the hub of the conversation it was attached
   * to. Omit it only where the file is of the hub being browsed. The file is
   * requested through this hub whichever hub is active (multi-hub axiom).
   */
  hubId?: string
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function FilePreview({ fileId, hubId }: FilePreviewProps) {
  const { t } = useTranslation()
  const { hasDeviceKey, publicKey } = useAuth()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [metadata, setMetadata] = useState<EncryptedFileMetadata | null>(null)

  useEffect(() => {
    let mounted = true
    let objectUrl: string | null = null

    async function loadAndDecrypt() {
      if (!hasDeviceKey || !keyManager.isUnlocked()) {
        if (mounted) setError(t('reports.noKeyAvailable', { defaultValue: 'Encryption key not available' }))
        if (mounted) setLoading(false)
        return
      }

      try {
        const file = await openStoredFile(fileId, hubId)
        if (!mounted) return

        setMetadata(file.metadata)
        const resolvedMime = file.metadata?.mimeType || 'application/octet-stream'
        objectUrl = URL.createObjectURL(new Blob([file.blob], { type: resolvedMime }))
        setBlobUrl(objectUrl)
      } catch (err) {
        if (!mounted) return
        // No envelope addressed to this device is "you are not a reader", not a
        // decrypt failure — and never a reason to try someone else's envelope.
        setError(err instanceof FileAccessDeniedError
          ? t('reports.noAccess', { defaultValue: 'No access to this file' })
          : t('reports.decryptError', { defaultValue: 'Failed to decrypt file' }))
      } finally {
        if (mounted) setLoading(false)
      }
    }

    loadAndDecrypt()

    return () => {
      mounted = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [fileId, hubId, hasDeviceKey, publicKey, t])

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-xs text-muted-foreground">
          {t('reports.decrypting', { defaultValue: 'Decrypting...' })}
        </span>
      </div>
    )
  }

  if (error) {
    return (
      <div role="alert" className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
        <AlertCircle className="h-4 w-4 text-destructive" />
        <span className="text-xs text-destructive">{error}</span>
      </div>
    )
  }

  if (!blobUrl) return null

  const mimeType = metadata?.mimeType || ''
  const fileName = metadata?.originalName || t('reports.unknownFile', { defaultValue: 'Encrypted file' })
  const fileSize = metadata?.size ? formatFileSize(metadata.size) : ''

  const handleDownload = () => {
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  // Image preview
  if (mimeType.startsWith('image/')) {
    return (
      <div className="space-y-1">
        <img
          src={blobUrl}
          alt={fileName}
          className="max-h-64 max-w-full rounded-md border border-border object-contain"
        />
        <FileInfo fileName={fileName} fileSize={fileSize} onDownload={handleDownload} icon={<ImageIcon className="h-3.5 w-3.5" />} />
      </div>
    )
  }

  // Video preview
  if (mimeType.startsWith('video/')) {
    return (
      <div className="space-y-1">
        <video
          src={blobUrl}
          controls
          className="max-h-64 max-w-full rounded-md border border-border"
        >
          {t('reports.videoNotSupported', { defaultValue: 'Your browser does not support video playback.' })}
        </video>
        <FileInfo fileName={fileName} fileSize={fileSize} onDownload={handleDownload} icon={<VideoIcon className="h-3.5 w-3.5" />} />
      </div>
    )
  }

  // Audio preview
  if (mimeType.startsWith('audio/')) {
    return (
      <div className="space-y-1">
        <audio src={blobUrl} controls className="w-full">
          {t('reports.audioNotSupported', { defaultValue: 'Your browser does not support audio playback.' })}
        </audio>
        <FileInfo fileName={fileName} fileSize={fileSize} onDownload={handleDownload} icon={<Music className="h-3.5 w-3.5" />} />
      </div>
    )
  }

  // Generic download link (PDF, docs, etc.)
  return (
    <FileInfo fileName={fileName} fileSize={fileSize} onDownload={handleDownload} icon={<FileIcon className="h-3.5 w-3.5" />} />
  )
}

function FileInfo({ fileName, fileSize, onDownload, icon }: {
  fileName: string
  fileSize: string
  onDownload: () => void
  icon: React.ReactNode
}) {
  const { t } = useTranslation()

  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">{fileName}</p>
        {fileSize && <p className="text-[10px] text-muted-foreground">{fileSize}</p>}
      </div>
      <Button variant="ghost" size="icon-xs" onClick={onDownload} aria-label={t('reports.download', { defaultValue: 'Download' })}>
        <Download className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
