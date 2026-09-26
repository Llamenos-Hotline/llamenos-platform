import { useState, useEffect, useRef, useCallback } from 'react'
import { encryptDraft, decryptDraft } from './hub-key-manager'
import * as keyManager from './key-manager'

type FieldValues = Record<string, string | number | boolean>

interface DraftData {
  text: string
  callId: string
  fields: FieldValues
  savedAt: number
}

const STORAGE_PREFIX = 'llamenos-draft:'
const DEBOUNCE_MS = 500

export function useDraft(key: string) {
  const [text, setText] = useState('')
  const [callId, setCallId] = useState('')
  const [fields, setFields] = useState<FieldValues>({})
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [isDirty, setIsDirty] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const storageKey = STORAGE_PREFIX + key

  // Restore on mount
  useEffect(() => {
    if (!keyManager.isUnlocked()) return
    const raw = localStorage.getItem(storageKey)
    if (!raw) return

    ;(async () => {
      try {
        const decrypted = await decryptDraft(raw)
        if (!decrypted) return
        const data: DraftData = JSON.parse(decrypted)
        setText(data.text)
        setCallId(data.callId)
        setFields(data.fields || {})
        setSavedAt(data.savedAt)
      } catch {
        // Corrupted draft or key locked — ignore
      }
    })()
  }, [storageKey])

  // Persist helper
  const persist = useCallback(async (t: string, cId: string, f: FieldValues) => {
    if (!keyManager.isUnlocked()) return
    const hasFields = Object.keys(f).length > 0
    if (!t && !cId && !hasFields) {
      localStorage.removeItem(storageKey)
      setSavedAt(null)
      return
    }
    try {
      const now = Date.now()
      const data: DraftData = { text: t, callId: cId, fields: f, savedAt: now }
      const encrypted = await encryptDraft(JSON.stringify(data))
      localStorage.setItem(storageKey, encrypted)
      setSavedAt(now)
      setIsDirty(false)
    } catch {
      // Key locked during persist — ignore
    }
  }, [storageKey])

  // Debounced save on text/callId/fields change
  useEffect(() => {
    if (!isDirty) return
    timerRef.current = setTimeout(() => persist(text, callId, fields), DEBOUNCE_MS)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [text, callId, fields, isDirty, persist])

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    }
  }, [])

  const setTextWrapped = useCallback((v: string) => {
    setText(v)
    setIsDirty(true)
  }, [])

  const setCallIdWrapped = useCallback((v: string) => {
    setCallId(v)
    setIsDirty(true)
  }, [])

  const setFieldValue = useCallback((fieldName: string, value: string | number | boolean) => {
    setFields(prev => ({ ...prev, [fieldName]: value }))
    setIsDirty(true)
  }, [])

  const clearDraft = useCallback(() => {
    localStorage.removeItem(storageKey)
    setText('')
    setCallId('')
    setFields({})
    setSavedAt(null)
    setIsDirty(false)
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [storageKey])

  return {
    text,
    callId,
    fields,
    setText: setTextWrapped,
    setCallId: setCallIdWrapped,
    setFieldValue,
    clearDraft,
    savedAt,
    isDirty,
  }
}
