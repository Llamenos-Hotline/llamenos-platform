import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock, User, MessageSquare, Search } from 'lucide-react'
import type { Conversation } from '@/lib/api'
import { ChannelBadge } from '@/components/ChannelBadge'
import { contactLabel, matchesContactHash } from '@/lib/contact-label'

interface ConversationListProps {
  conversations: Conversation[]
  onSelect: (id: string) => void
  selectedId?: string
}

function StatusDot({ status }: { status: Conversation['status'] }) {
  const colorClass =
    status === 'active'
      ? 'bg-green-500'
      : status === 'waiting'
        ? 'bg-yellow-500'
        : 'bg-gray-400'

  return (
    <span
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${colorClass}`}
      aria-label={status}
    />
  )
}

function ConversationCard({
  conversation,
  isSelected,
  onSelect,
}: {
  conversation: Conversation
  isSelected: boolean
  onSelect: (id: string) => void
}) {
  const { t } = useTranslation()

  const contactDisplay = contactLabel(conversation) ?? t('conversations.unknownContact', 'Unknown')

  const assigneeDisplay = conversation.assignedTo
    ? conversation.assignedTo.slice(0, 8)
    : t('conversations.waiting', 'Waiting')

  // Relative time formatting
  const relativeTime = (() => {
    const now = Date.now()
    const then = new Date(conversation.lastMessageAt ?? conversation.updatedAt).getTime()
    const diffMs = now - then

    if (diffMs < 0) return t('conversations.justNow', 'just now')

    const seconds = Math.floor(diffMs / 1000)
    if (seconds < 60) return t('conversations.justNow', 'just now')

    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return t('conversations.minutesAgo', { count: minutes, defaultValue: '{{count}}m ago' })

    const hours = Math.floor(minutes / 60)
    if (hours < 24) return t('conversations.hoursAgo', { count: hours, defaultValue: '{{count}}h ago' })

    const days = Math.floor(hours / 24)
    return t('conversations.daysAgo', { count: days, defaultValue: '{{count}}d ago' })
  })()

  return (
    <button
      type="button"
      data-testid="conversation-item"
      onClick={() => onSelect(conversation.id)}
      className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
        isSelected
          ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
          : 'border-border bg-card hover:bg-accent/50'
      }`}
    >
      <div className="flex items-center gap-2">
        <StatusDot status={conversation.status} />
        <ChannelBadge channelType={conversation.channelType} />
        <span className="font-mono text-sm font-medium text-foreground">
          {contactDisplay}
        </span>
        <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" />
          {relativeTime}
        </span>
      </div>

      <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <MessageSquare className="h-3 w-3" />
          {conversation.messageCount}
        </span>
        <span className="flex items-center gap-1">
          <User className="h-3 w-3" />
          <span className={conversation.assignedTo ? 'font-mono' : 'italic'}>
            {assigneeDisplay}
          </span>
        </span>
      </div>
    </button>
  )
}

export function ConversationList({ conversations, onSelect, selectedId }: ConversationListProps) {
  const { t } = useTranslation()
  const [searchQuery, setSearchQuery] = useState('')

  const { waiting, active, closed } = useMemo(() => {
    const waitingList: Conversation[] = []
    const activeList: Conversation[] = []
    const closedList: Conversation[] = []

    // Filter by search query if present
    const query = searchQuery.trim().toLowerCase()
    const filtered = query
      ? conversations.filter(conv =>
          matchesContactHash(conv, query) ||
          conv.channelType.toLowerCase().includes(query) ||
          (conv.assignedTo && conv.assignedTo.toLowerCase().includes(query))
        )
      : conversations

    for (const conv of filtered) {
      if (conv.status === 'waiting') {
        waitingList.push(conv)
      } else if (conv.status === 'active') {
        activeList.push(conv)
      } else if (conv.status === 'closed') {
        closedList.push(conv)
      }
    }

    // Sort each group by most recent message first
    const byLastMessage = (a: Conversation, b: Conversation) =>
      new Date(b.lastMessageAt ?? b.updatedAt).getTime() - new Date(a.lastMessageAt ?? a.updatedAt).getTime()

    waitingList.sort(byLastMessage)
    activeList.sort(byLastMessage)
    closedList.sort(byLastMessage)

    return { waiting: waitingList, active: activeList, closed: closedList }
  }, [conversations, searchQuery])

  if (conversations.length === 0) {
    return (
      <div data-testid="conversation-list" className="flex flex-col items-center justify-center py-12 text-center text-sm text-muted-foreground">
        <MessageSquare className="mb-2 h-8 w-8 opacity-40" />
        <p>{t('conversations.noConversations', 'No conversations')}</p>
      </div>
    )
  }

  return (
    <div data-testid="conversation-list" className="space-y-4">
      {/* Search input */}
      <div className="relative px-3 pt-2">
        <Search className="absolute left-5 top-4.5 h-3.5 w-3.5 text-muted-foreground" />
        <input
          type="search"
          data-testid="conv-search"
          placeholder={t('conversations.searchPlaceholder', 'Search conversations...')}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="w-full rounded-md border border-input bg-background py-1.5 pl-8 pr-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {waiting.length > 0 && (
        <section className="px-3">
          <h3 data-testid="conv-section-header" className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <span className="inline-block h-2 w-2 rounded-full bg-yellow-500" />
            {t('conversations.waitingSection', 'Waiting')}
            <span className="rounded-full bg-yellow-500/10 px-1.5 py-0.5 text-[10px] font-bold text-yellow-600">
              {waiting.length}
            </span>
          </h3>
          <div className="space-y-1.5">
            {waiting.map(conv => (
              <ConversationCard
                key={conv.id}
                conversation={conv}
                isSelected={selectedId === conv.id}
                onSelect={onSelect}
              />
            ))}
          </div>
        </section>
      )}

      {active.length > 0 && (
        <section className="px-3">
          <h3 data-testid="conv-section-header" className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
            {t('conversations.activeSection', 'Active')}
            <span className="rounded-full bg-green-500/10 px-1.5 py-0.5 text-[10px] font-bold text-green-600">
              {active.length}
            </span>
          </h3>
          <div className="space-y-1.5">
            {active.map(conv => (
              <ConversationCard
                key={conv.id}
                conversation={conv}
                isSelected={selectedId === conv.id}
                onSelect={onSelect}
              />
            ))}
          </div>
        </section>
      )}

      {closed.length > 0 && (
        <section className="px-3">
          <h3 data-testid="conv-section-header" className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <span className="inline-block h-2 w-2 rounded-full bg-gray-400" />
            {t('conversations.closedSection', 'Closed')}
            <span className="rounded-full bg-gray-400/10 px-1.5 py-0.5 text-[10px] font-bold text-gray-500">
              {closed.length}
            </span>
          </h3>
          <div className="space-y-1.5">
            {closed.map(conv => (
              <ConversationCard
                key={conv.id}
                conversation={conv}
                isSelected={selectedId === conv.id}
                onSelect={onSelect}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
