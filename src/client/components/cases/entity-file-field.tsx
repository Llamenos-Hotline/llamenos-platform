import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Upload, X, File as FileIcon } from 'lucide-react'
import { encryptFile } from '@/lib/file-crypto'
import { chunkedUpload } from '@/lib/chunked-upload'
import { useAuth } from '@/lib/auth'
import { useToast } from '@/lib/toast'
import type { FileFieldValue } from '@protocol/schemas/entity-schema'
import { hubAdminReaders } from '@/lib/admin-recipient'

interface EntityFileFieldProps {
  value: FileFieldValue | null
  onChange: (value: FileFieldValue | null) => void
  maxFileSize?: number
  allowedMimeTypes?: string[]
  disabled?: boolean
}

export function EntityFileField({
  value, onChange, maxFileSize = 10 * 1024 * 1024, allowedMimeTypes, disabled = false,
}: EntityFileFieldProps) {
  const { t } = useTranslation()
  const { publicKey } = useAuth()
  const { toast } = useToast()
  const inputRef = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<number | null>(null)

  async function handleFile(file: File) {
    if (file.size > maxFileSize) {
      toast(t('cms.fileTooLarge', { defaultValue: 'File exceeds maximum size' }), 'error')
      return
    }
    if (allowedMimeTypes && !allowedMimeTypes.includes(file.type)) {
      toast(t('cms.fileTypeNotAllowed', { defaultValue: 'File type not allowed' }), 'error')
      return
    }

    setProgress(10)
    try {
      const recipients: string[] = publicKey ? [publicKey] : []
      // Every admin of the hub, not one env-configured key (#1035).
      recipients.push(...await hubAdminReaders())
      const encrypted = await encryptFile(file, recipients)
      setProgress(30)
      // A file row of the active hub, with its envelopes, through the same
      // chunked path as every other file (#2462). Its parent is the hub: the
      // entity this field belongs to may not exist yet.
      const { fileId, completedAt: uploadedAt } = await chunkedUpload({
        encrypted,
        owner: { kind: 'entity_field' },
        onProgress: (completed, total) => setProgress(30 + Math.round((completed / total) * 70)),
      })

      // Build first metadata envelope for encryptedName (if available)
      const firstMeta = encrypted.encryptedMetadata[0]
      const fieldValue: FileFieldValue = {
        fileId,
        encryptedName: firstMeta?.encryptedContent ?? '',
        encryptedMimeType: '',
        encryptedSize: '',
        recipientEnvelopes: encrypted.recipientEnvelopes.map(e => ({
          recipientPubkey: e.pubkey,
          encryptedKey: e.ct,
        })),
        uploadedAt,
      }
      onChange(fieldValue)
    } catch {
      toast(t('cms.fileUploadError', { defaultValue: 'Upload failed' }), 'error')
    } finally {
      setProgress(null)
    }
  }

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-md border px-3 py-2" data-testid="entity-file-value">
        <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-sm text-muted-foreground">
          {t('cms.fileAttached', { defaultValue: 'File attached' })}
        </span>
        {!disabled && (
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => onChange(null)}>
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    )
  }

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept={allowedMimeTypes?.join(',')}
        onChange={e => { const f = e.target.files?.[0]; if (f) { handleFile(f).catch(() => {}) } }}
      />
      {progress !== null ? (
        <div className="space-y-1">
          <Progress value={progress} className="h-1.5" />
          <p className="text-xs text-muted-foreground">{t('cms.uploading', { defaultValue: 'Uploading…' })}</p>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 w-full"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          data-testid="entity-file-upload-btn"
        >
          <Upload className="h-3.5 w-3.5" />
          {t('cms.chooseFile', { defaultValue: 'Choose File' })}
        </Button>
      )}
    </div>
  )
}
