import { useState, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { UploadProgress } from '@/components/UploadProgress'
import { encryptFile } from '@/lib/file-crypto'
import { chunkedUpload } from '@/lib/chunked-upload'
import { useToast } from '@/lib/toast'

interface FileUploadProps {
  conversationId: string
  recipientPubkeys: string[]
  onUploadComplete: (fileIds: string[]) => void
  disabled?: boolean
}

interface FileUploadState {
  file: File
  status: 'encrypting' | 'uploading' | 'complete' | 'failed'
  completedChunks: number
  totalChunks: number
  fileId?: string
}

export function FileUpload({ conversationId, recipientPubkeys, onUploadComplete, disabled }: FileUploadProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [uploads, setUploads] = useState<FileUploadState[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const processFiles = useCallback(async (files: File[]) => {
    if (disabled || files.length === 0) return

    const newUploads: FileUploadState[] = files.map(file => ({
      file,
      status: 'encrypting' as const,
      completedChunks: 0,
      totalChunks: 1,
    }))

    setUploads(prev => [...prev, ...newUploads])

    const completedIds: string[] = []

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const uploadIndex = uploads.length + i

      try {
        const encrypted = await encryptFile(file, recipientPubkeys)

        setUploads(prev => prev.map((u, idx) =>
          idx === uploadIndex ? { ...u, status: 'uploading', totalChunks: Math.ceil(encrypted.encryptedContent.length / (5 * 1024 * 1024)) || 1 } : u
        ))

        const result = await chunkedUpload({
          encrypted,
          owner: { kind: 'conversation', conversationId },
          onProgress: (completed, total) => {
            setUploads(prev => prev.map((u, idx) =>
              idx === uploadIndex ? { ...u, completedChunks: completed, totalChunks: total } : u
            ))
          },
        })

        setUploads(prev => prev.map((u, idx) =>
          idx === uploadIndex ? { ...u, status: 'complete', fileId: result.fileId, completedChunks: u.totalChunks } : u
        ))

        completedIds.push(result.fileId)
      } catch {
        setUploads(prev => prev.map((u, idx) =>
          idx === uploadIndex ? { ...u, status: 'failed' } : u
        ))
        toast(t('reports.uploadError', { defaultValue: 'Failed to upload {{name}}', name: file.name }), 'error')
      }
    }

    if (completedIds.length > 0) {
      onUploadComplete(completedIds)
    }
  }, [conversationId, recipientPubkeys, disabled, uploads.length, toast, t, onUploadComplete])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    processFiles(files)
  }, [processFiles])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
  }, [])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    processFiles(files)
    if (inputRef.current) inputRef.current.value = ''
  }, [processFiles])

  const removeUpload = useCallback((index: number) => {
    setUploads(prev => prev.filter((_, i) => i !== index))
  }, [])

  return (
    <div className="space-y-3">
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-6 transition-colors ${
          isDragOver
            ? 'border-primary bg-primary/5'
            : disabled
              ? 'border-border bg-muted/30 opacity-50 cursor-not-allowed'
              : 'border-border bg-muted/10 hover:border-primary/50 hover:bg-muted/20 cursor-pointer'
        }`}
        onClick={() => !disabled && inputRef.current?.click()}
        role="button"
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click() } }}
        aria-label={t('reports.dropzoneLabel', { defaultValue: 'Drop files here or click to browse' })}
      >
        <Upload className="h-6 w-6 text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground text-center">
          {t('reports.dropzone', { defaultValue: 'Drop files here or click to browse' })}
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
          disabled={disabled}
        />
      </div>

      {uploads.length > 0 && (
        <div className="space-y-2">
          {uploads.map((upload, index) => (
            <div key={`${upload.file.name}-${index}`} className="flex items-center gap-2">
              <div className="flex-1">
                <UploadProgress
                  completedChunks={upload.completedChunks}
                  totalChunks={upload.totalChunks}
                  fileName={upload.file.name}
                  status={upload.status === 'encrypting' ? 'uploading' : upload.status}
                />
              </div>
              {(upload.status === 'complete' || upload.status === 'failed') && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => removeUpload(index)}
                  aria-label={t('common.close')}
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
