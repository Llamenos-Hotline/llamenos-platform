import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/lib/auth'
import { decryptMessage } from '@/lib/platform'
import * as keyManager from '@/lib/key-manager'
import type { ConversationMessage } from '@/lib/api'
import { formatTimestamp } from '@/lib/format'
import { FilePreview } from '@/components/FilePreview'
import { Lock, ArrowDown, Loader2, Check, CheckCheck, Clock, AlertCircle } from 'lucide-react'

interface ConversationThreadProps {
  conversationId: string
  messages: ConversationMessage[]
  isLoading: boolean
  /** Compact mode for note reply threads — smaller bubbles */
  compact?: boolean
}

export function ConversationThread({ conversationId: _conversationId, messages, isLoading, compact }: ConversationThreadProps) {
  const { t } = useTranslation()
  const { hasDeviceKey, publicKey } = useAuth()
  const [decryptedContent, setDecryptedContent] = useState<Map<string, string>>(new Map())
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showScrollDown, setShowScrollDown] = useState(false)

  // Decrypt messages when they change
  useEffect(() => {
    if (messages.length === 0 || !publicKey) return
    if (!hasDeviceKey || !keyManager.isUnlocked()) return

    ;(async () => {
      const newDecrypted = new Map<string, string>()
      for (const msg of messages) {
        if (msg.encryptedContent && msg.readerEnvelopes?.length) {
          const plaintext = await decryptMessage(
            msg.encryptedContent,
            msg.readerEnvelopes,
          )
          if (plaintext !== null) {
            newDecrypted.set(msg.id, plaintext)
          }
        }
      }
      setDecryptedContent(newDecrypted)
    })()
  }, [messages, hasDeviceKey, publicKey])

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages.length])

  // Track scroll position to show/hide scroll-down button
  function handleScroll() {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    setShowScrollDown(scrollHeight - scrollTop - clientHeight > 100)
  }

  function scrollToBottom() {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    }
  }

  function StatusIcon({ status }: { status?: string }) {
    switch (status) {
      case 'pending':
        return <Clock className="h-3 w-3" />
      case 'sent':
        return <Check className="h-3 w-3" />
      case 'delivered':
        return <CheckCheck className="h-3 w-3" />
      case 'read':
        return <CheckCheck className="h-3 w-3 text-blue-400" />
      case 'failed':
        return <AlertCircle className="h-3 w-3 text-red-400" />
      default:
        return <Check className="h-3 w-3" />
    }
  }

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        {t('conversations.noMessages', 'No messages yet')}
      </div>
    )
  }

  const bubblePadding = compact ? 'px-3 py-2' : 'px-4 py-2.5'

  return (
    <div data-testid="conversation-thread" className="relative flex flex-1 flex-col overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-3"
      >
        {messages.map((msg) => {
          const isInbound = msg.direction === 'inbound'
          const text = decryptedContent.get(msg.id)
          const isEncrypted = text === undefined

          return (
            <div
              key={msg.id}
              data-testid="conversation-message"
              className={`flex ${isInbound ? 'justify-start' : 'justify-end'}`}
            >
              <div
                className={`max-w-[75%] rounded-2xl ${bubblePadding} ${
                  isInbound
                    ? 'bg-muted text-foreground rounded-bl-md'
                    : 'bg-primary text-primary-foreground rounded-br-md'
                }`}
              >
                <p className="text-sm whitespace-pre-wrap break-words">
                  {isEncrypted ? (
                    <span className="italic text-muted-foreground">{t('conversations.encrypted', '[Encrypted]')}</span>
                  ) : (
                    text
                  )}
                </p>

                {/* File attachments */}
                {msg.hasAttachments && msg.attachmentIds && msg.attachmentIds.length > 0 && (
                  <div className="mt-2 space-y-2">
                    {msg.attachmentIds.map(fileId => (
                      <FilePreview key={fileId} fileId={fileId} />
                    ))}
                  </div>
                )}

                <div
                  className={`mt-1 flex items-center gap-1.5 text-xs ${
                    isInbound ? 'text-muted-foreground' : 'text-primary-foreground/70'
                  }`}
                >
                  <Lock className="h-3 w-3" />
                  <span>{formatTimestamp(msg.createdAt)}</span>
                  {isInbound ? (
                    <ArrowDown className="h-3 w-3" />
                  ) : (
                    <>
                      <StatusIcon status={msg.status} />
                      {msg.status === 'failed' && msg.failureReason && (
                        <span className="text-red-400 truncate max-w-[100px]" title={msg.failureReason}>
                          {t('conversations.failed', 'Failed')}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Scroll to bottom button */}
      {showScrollDown && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-background border border-border shadow-md p-2 hover:bg-muted transition-colors"
          aria-label={t('conversations.scrollToBottom', 'Scroll to bottom')}
        >
          <ArrowDown className="h-4 w-4 text-muted-foreground" />
        </button>
      )}
    </div>
  )
}
