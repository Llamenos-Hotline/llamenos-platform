import { useState, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { bulkCreateContacts } from '@/lib/api'
import { encryptMessage } from '@/lib/platform'
import * as keyManager from '@/lib/key-manager'
import { activeHubAdminReaders } from '@/lib/admin-recipient'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Loader2, Upload, FileText, CheckCircle2 } from 'lucide-react'

interface ContactImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: (count: number) => void
}

interface ParsedContact {
  displayName: string
  contactType: 'individual' | 'organization'
  tags: string[]
  rawRow: Record<string, string>
}

function parseCSV(text: string): ParsedContact[] {
  const lines = text.trim().split('\n')
  if (lines.length < 2) return []

  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase())
  return lines.slice(1).map((line) => {
    const vals = line.split(',').map((v) => v.trim().replace(/^"|"$/g, ''))
    const row: Record<string, string> = {}
    headers.forEach((h, i) => { row[h] = vals[i] ?? '' })

    return {
      displayName: row['name'] || row['displayname'] || row['full name'] || 'Unknown',
      contactType: 'individual',
      tags: row['tags'] ? row['tags'].split(';').map((t) => t.trim()) : [],
      rawRow: row,
    }
  })
}

const BATCH_SIZE = 100

export function ContactImportDialog({
  open,
  onOpenChange,
  onImported,
}: ContactImportDialogProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const fileRef = useRef<HTMLInputElement>(null)

  const [parsed, setParsed] = useState<ParsedContact[]>([])
  const [fileName, setFileName] = useState('')
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [done, setDone] = useState(false)

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    const text = await file.text()
    const contacts = parseCSV(text)
    setParsed(contacts)
    setDone(false)
    setProgress(0)
  }, [])

  const handleImport = async () => {
    if (!parsed.length) return

    const devicePubkey = keyManager.getPublicKeyHex()
    if (!devicePubkey) {
      toast(t('common.error'), 'error')
      return
    }

    setImporting(true)
    let imported = 0

    try {
      // The importer and every admin of the hub the contacts are created in: a
      // contact sealed to the importer alone is refused (#2174) — no admin could open it.
      const readers = [...new Set([devicePubkey, ...await activeHubAdminReaders()])]

      // Process in batches of BATCH_SIZE
      for (let i = 0; i < parsed.length; i += BATCH_SIZE) {
        const batch = parsed.slice(i, i + BATCH_SIZE)

        const encryptedContacts = await Promise.all(
          batch.map(async (contact) => {
            const payload = JSON.stringify({
              displayName: contact.displayName,
              contactType: contact.contactType,
              tags: contact.tags,
            })
            const { encryptedContent, readerEnvelopes } = await encryptMessage(payload, readers)
            return {
              encryptedSummary: encryptedContent,
              summaryEnvelopes: readerEnvelopes,
              blindIndexes: { identifierHashes: [] as string[], tagHashes: [] as string[] },
              trigramTokens: [] as string[],
            }
          }),
        )

        await bulkCreateContacts({ contacts: encryptedContacts })
        imported += batch.length
        setProgress(Math.round((imported / parsed.length) * 100))
      }

      setDone(true)
      toast(t('cms.importSuccess', { count: imported }))
      onImported(imported)
    } catch {
      toast(t('cms.importError'), 'error')
    } finally {
      setImporting(false)
    }
  }

  const reset = () => {
    setParsed([])
    setFileName('')
    setDone(false)
    setProgress(0)
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('cms.importContacts')}</DialogTitle>
          <DialogDescription>{t('cms.importContactsDesc')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div
            className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-muted p-8 cursor-pointer hover:border-muted-foreground/50 transition-colors"
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="h-8 w-8 text-muted-foreground" />
            {fileName ? (
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-primary" />
                <span className="text-sm font-medium">{fileName}</span>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('cms.importDropHint')}</p>
            )}
            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>

          {parsed.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {t('cms.importParsed', { count: parsed.length })}
            </p>
          )}

          {importing && (
            <div className="space-y-1">
              <Progress value={progress} />
              <p className="text-xs text-muted-foreground text-right">{progress}%</p>
            </div>
          )}

          {done && (
            <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
              <CheckCircle2 className="h-4 w-4" />
              <span className="text-sm font-medium">{t('cms.importDone')}</span>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { reset(); onOpenChange(false) }}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={handleImport}
              disabled={!parsed.length || importing || done}
            >
              {importing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-2 h-4 w-4" />
              )}
              {t('cms.importRun', { count: parsed.length })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
