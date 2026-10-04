import { useTranslation } from 'react-i18next'
import type { DirectoryContact, DirectoryContactType } from '@/lib/api'
import { formatRelativeTime } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { TagBadge } from '@/components/tag-badge'
import { useTags } from '@/lib/queries/tags'
import { Lock, User, Building2, Scale, Briefcase } from 'lucide-react'

const CONTACT_TYPE_CONFIG: Record<DirectoryContactType, { icon: typeof User; label: string }> = {
  individual: { icon: User, label: 'contactDirectory.typeIndividual' },
  organization: { icon: Building2, label: 'contactDirectory.typeOrganization' },
  legal_resource: { icon: Scale, label: 'contactDirectory.typeLegalResource' },
  service_provider: { icon: Briefcase, label: 'contactDirectory.typeServiceProvider' },
}

interface ContactCardProps {
  contact: DirectoryContact
  isSelected: boolean
  onSelect: (id: string) => void
}

export function ContactCard({ contact, isSelected, onSelect }: ContactCardProps) {
  const { t } = useTranslation()
  const config = CONTACT_TYPE_CONFIG[contact.contactType] ?? CONTACT_TYPE_CONFIG.individual
  const TypeIcon = config.icon
  const { data: allTags = [] } = useTags()

  // Map tag slugs from contact summary to decrypted tag objects
  const contactTagObjects = contact.tags.length > 0
    ? allTags.filter((tag) => contact.tags.includes(tag.name))
    : []

  const initials = contact.canDecrypt && contact.displayName
    ? contact.displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    : null

  const relativeTime = contact.lastInteractionAt
    ? formatRelativeTime(contact.lastInteractionAt, t)
    : null

  return (
    <button
      type="button"
      data-testid="directory-contact-card"
      onClick={() => onSelect(contact.id)}
      className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
        isSelected
          ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
          : 'border-border bg-card hover:bg-accent/50'
      }`}
    >
      <div className="flex items-center gap-3">
        {/* Avatar */}
        {contact.canDecrypt ? (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-medium text-primary">
            {initials}
          </div>
        ) : (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
            <Lock className="h-4 w-4 text-muted-foreground" />
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {contact.canDecrypt
                ? contact.displayName
                : t('contactDirectory.restricted', { defaultValue: 'Restricted' })}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            <Badge data-testid="contact-type-badge" variant="outline" className="text-[10px] gap-1">
              <TypeIcon className="h-2.5 w-2.5" />
              {t(config.label, { defaultValue: contact.contactType })}
            </Badge>
            {contact.caseCount > 0 && (
              <span className="text-xs text-muted-foreground">
                {t('contactDirectory.caseCount', { count: contact.caseCount, defaultValue: '{{count}} cases' })}
              </span>
            )}
            {contactTagObjects.slice(0, 3).map((tag) => (
              <TagBadge key={tag.id} color={tag.color} label={tag.label} />
            ))}
          </div>
        </div>

        {relativeTime && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {relativeTime}
          </span>
        )}
      </div>
    </button>
  )
}

export { CONTACT_TYPE_CONFIG }
