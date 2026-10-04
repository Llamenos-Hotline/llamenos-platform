import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Mic, Square, Trash2 } from 'lucide-react'

interface AudioRecorderProps {
  onRecorded: (blob: Blob) => void
  /** The audio already saved, fetched so it can be played back; `version` changes when it is replaced */
  existing?: { version: string; load: () => Promise<Blob> }
  onDelete?: () => void
}

export function AudioRecorder({ onRecorded, existing, onDelete }: AudioRecorderProps) {
  const { t } = useTranslation()
  const [recording, setRecording] = useState(false)
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null)
  const [existingBlob, setExistingBlob] = useState<Blob | null>(null)
  const [duration, setDuration] = useState(0)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const mediaRecorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      if (mediaRecorder.current?.state === 'recording') {
        mediaRecorder.current.stop()
      }
    }
  }, [])

  const loadExisting = useRef(existing?.load)
  loadExisting.current = existing?.load
  const existingVersion = existing?.version
  useEffect(() => {
    setExistingBlob(null)
    const load = loadExisting.current
    if (!existingVersion || !load) return
    let cancelled = false
    load()
      .then(blob => { if (!cancelled) setExistingBlob(blob) })
      // Playback is a convenience: a prompt that fails to load is still saved
      .catch(() => {})
    return () => { cancelled = true }
  }, [existingVersion])

  // Manage blob URL lifecycle — revoke on change/unmount
  useEffect(() => {
    const blob = recordedBlob ?? existingBlob
    if (!blob) { setPreviewUrl(null); return }
    const url = URL.createObjectURL(blob)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [recordedBlob, existingBlob])

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      chunks.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.current.push(e.data)
      }

      recorder.onstop = () => {
        const blob = new Blob(chunks.current, { type: recorder.mimeType })
        setRecordedBlob(blob)
        onRecorded(blob)
        stream.getTracks().forEach(track => track.stop())
      }

      mediaRecorder.current = recorder
      recorder.start()
      setRecording(true)
      setDuration(0)

      timerRef.current = setInterval(() => {
        setDuration(d => {
          if (d >= 59) {
            stopRecording()
            return 60
          }
          return d + 1
        })
      }, 1000)
    } catch {
      // Microphone permission denied — silently fail
    }
  }

  function stopRecording() {
    if (mediaRecorder.current?.state === 'recording') {
      mediaRecorder.current.stop()
    }
    setRecording(false)
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  function handleDelete() {
    setRecordedBlob(null)
    onDelete?.()
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {recording ? (
          <>
            <Button size="sm" variant="destructive" onClick={stopRecording}>
              <Square className="h-3.5 w-3.5" />
              {t('ivrAudio.stop')}
            </Button>
            <span className="font-mono text-sm text-red-500">
              {Math.floor(duration / 60)}:{String(duration % 60).padStart(2, '0')}
            </span>
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={startRecording}>
            <Mic className="h-3.5 w-3.5" />
            {t('ivrAudio.record')}
          </Button>
        )}
        {(existing || recordedBlob) && onDelete && (
          <Button size="sm" variant="ghost" onClick={handleDelete} aria-label={t('ivrAudio.delete')}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {previewUrl && (
        <audio controls src={previewUrl} className="h-8 w-full" />
      )}
    </div>
  )
}
