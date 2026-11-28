import { useTranslation } from 'react-i18next'
import { useState, useEffect, useCallback } from 'react'
import type {
  DirectoryContact,
  ContactRelationship,
  AffinityGroup,
  ContactCaseLink,
} from '@/lib/api'
import {
  listDirectoryContactRelationships,
  listDirectoryContactGroups,
  listDirectoryContactCases,
} from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { RelationshipWritePanel, relationshipCounterpartId } from './relationship-write-panel'
import { useToast } from '@/lib/toast'
import { CONTACT_TYPE_CONFIG } from './contact-card'
import { ContactMergeDialog } from '@/components/contact-merge-dialog'
import { TagBadge } from '@/components/tag-badge'
import { TagInput } from '@/components/tag-input'
import { useTags } from '@/lib/queries/tags'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  User, Phone, Mail, MessageSquare, Lock, ArrowRight,
  FileText, Users, Loader2, Shield, GitMerge, Tag,
} from 'lucide-react'

type Tab = 'profile' | 'identifiers' | 'cases' | 'relationships' | 'groups'

interface ContactProfileProps {
  contact: DirectoryContact
  onContactMerged?: () => void
}

export function ContactProfile({ contact, onContactMerged }: ContactProfileProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<Tab>('profile')
  const [showMergeDialog, setShowMergeDialog] = useState(false)

  // Reset tab when contact changes
  useEffect(() => {
    setActiveTab('profile')
  }, [contact.id])

  const tabs: { key: Tab; label: string }[] = [
    { key: 'profile', label: t('contactDirectory.tabProfile', { defaultValue: 'Profile' }) },
    { key: 'identifiers', label: t('contactDirectory.tabIdentifiers', { defaultValue: 'Identifiers' }) },
    { key: 'cases', label: t('contactDirectory.tabCases', { defaultValue: 'Cases' }) },
    { key: 'relationships', label: t('contactDirectory.tabRelationships', { defaultValue: 'Relationships' }) },
    { key: 'groups', label: t('contactDirectory.tabGroups', { defaultValue: 'Groups' }) },
  ]

  const config = CONTACT_TYPE_CONFIG[contact.contactType] ?? CONTACT_TYPE_CONFIG.individual
  const TypeIcon = config.icon

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div data-testid="contact-profile-header" className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          {contact.canDecrypt ? (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-medium text-primary">
              {contact.displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
            </div>
          ) : (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted">
              <Lock className="h-5 w-5 text-muted-foreground" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-semibold text-foreground">
              {contact.canDecrypt
                ? contact.displayName
                : t('contactDirectory.restricted', { defaultValue: 'Restricted' })}
            </h2>
            <div className="flex items-center gap-2 mt-0.5">
              <Badge variant="outline" className="text-[10px] gap-1">
                <TypeIcon className="h-2.5 w-2.5" />
                {t(config.label, { defaultValue: contact.contactType })}
              </Badge>
              {contact.tags.map(tag => (
                <Badge key={tag} variant="secondary" className="text-[10px]">{tag}</Badge>
              ))}
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            data-testid="contact-merge-btn"
            onClick={() => setShowMergeDialog(true)}
            className="shrink-0"
          >
            <GitMerge className="h-3.5 w-3.5" />
            {t('cms.mergeContact', { defaultValue: 'Merge' })}
          </Button>
        </div>
      </div>

      {showMergeDialog && (
        <ContactMergeDialog
          open={showMergeDialog}
          onOpenChange={setShowMergeDialog}
          primaryContact={contact}
          onMerged={() => { setShowMergeDialog(false); onContactMerged?.() }}
        />
      )}

      {/* Tab bar */}
      <div data-testid="contact-profile-tabs" className="flex border-b border-border bg-muted/30">
        {tabs.map(tab => (
          <button
            key={tab.key}
            type="button"
            data-testid={`contact-tab-${tab.key}`}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === tab.key
                ? 'border-b-2 border-primary text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'profile' && <ProfileTab contact={contact} />}
        {activeTab === 'identifiers' && <IdentifiersTab contact={contact} />}
        {activeTab === 'cases' && <CasesTab contactId={contact.id} />}
        {activeTab === 'relationships' && <RelationshipsTab contactId={contact.id} />}
        {activeTab === 'groups' && <GroupsTab contactId={contact.id} />}
      </div>
    </div>
  )
}

function ProfileTab({ contact }: { contact: DirectoryContact }) {
  const { t } = useTranslation()
  const { data: allTags = [] } = useTags()

  // Map tag slugs from contact summary to tag IDs for TagInput
  const contactTagIds = contact.tags
    .map((slug) => allTags.find((tag) => tag.name === slug)?.id)
    .filter((id): id is string => id !== undefined)

  if (!contact.canDecrypt) {
    return (
      <RestrictedPlaceholder
        message={t('contactDirectory.profileRestricted', { defaultValue: 'You do not have access to view this contact\'s profile details.' })}
      />
    )
  }

  const sections: Array<{ key: string; label: string; content: string | undefined }> = [
    { key: 'demographics', label: t('contactDirectory.demographics', { defaultValue: 'Demographics' }), content: contact.demographics },
    { key: 'emergencyContacts', label: t('contactDirectory.emergencyContacts', { defaultValue: 'Emergency Contacts' }), content: contact.emergencyContacts },
    { key: 'communicationPrefs', label: t('contactDirectory.communicationPrefs', { defaultValue: 'Communication Preferences' }), content: contact.communicationPrefs },
    { key: 'notes', label: t('contactDirectory.notes', { defaultValue: 'Notes' }), content: contact.notes },
  ]

  const hasContent = sections.some(s => s.content)

  return (
    <div data-testid="contact-profile-content" className="space-y-4">
      {/* Tags section */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center gap-2 mb-3">
            <Tag className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium text-foreground">
              {t('contactDirectory.tags', { defaultValue: 'Tags' })}
            </h3>
          </div>
          {contactTagIds.length > 0 ? (
            <div className="flex flex-wrap gap-1 mb-2">
              {contactTagIds.map((tagId) => {
                const tag = allTags.find((t) => t.id === tagId)
                if (!tag) return null
                return <TagBadge key={tagId} color={tag.color} label={tag.label} />
              })}
            </div>
          ) : null}
          <TagInput
            value={contactTagIds}
            onChange={() => {
              // Tag assignment to contacts requires backend support for tagHashes
              // This is display-only for now; editing is done via the edit dialog
            }}
          />
        </CardContent>
      </Card>

      {!hasContent ? (
        <div data-testid="contact-profile-empty" className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
          <User className="h-8 w-8 mb-2 opacity-40" />
          <p>{t('contactDirectory.noProfileData', { defaultValue: 'No profile details have been added yet.' })}</p>
        </div>
      ) : null}

      {sections.map(section => section.content ? (
        <Card key={section.key}>
          <CardContent className="pt-4">
            <h3 className="text-sm font-medium text-foreground mb-2">{section.label}</h3>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{section.content}</p>
          </CardContent>
        </Card>
      ) : null)}
    </div>
  )
}

function IdentifiersTab({ contact }: { contact: DirectoryContact }) {
  const { t } = useTranslation()

  if (!contact.canDecrypt) {
    return (
      <RestrictedPlaceholder
        message={t('contactDirectory.identifiersRestricted', { defaultValue: 'You do not have access to view this contact\'s identifiers.' })}
      />
    )
  }

  const identifiers = contact.identifiers ?? []

  if (identifiers.length === 0) {
    return (
      <div data-testid="contact-identifiers-empty" className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
        <Phone className="h-8 w-8 mb-2 opacity-40" />
        <p>{t('contactDirectory.noIdentifiers', { defaultValue: 'No identifiers have been added.' })}</p>
      </div>
    )
  }

  const typeIcons: Record<string, typeof Phone> = {
    phone: Phone,
    email: Mail,
    signal: MessageSquare,
  }

  return (
    <div data-testid="contact-identifiers-list" className="space-y-2">
      {identifiers.map(ident => {
        const Icon = typeIcons[ident.type] ?? Phone
        return (
          <Card key={ident.id} data-testid="contact-identifier-item">
            <CardContent className="flex items-center gap-3 py-3">
              <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                <p data-testid="contact-identifier-value" className="text-sm font-medium">{ident.value}</p>
                <p data-testid="contact-identifier-type" className="text-xs text-muted-foreground capitalize">{ident.type}</p>
              </div>
              {ident.isPrimary && (
                <Badge data-testid="identifier-primary-badge" variant="default" className="text-[10px]">
                  {t('contactDirectory.primary', { defaultValue: 'Primary' })}
                </Badge>
              )}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

function CasesTab({ contactId }: { contactId: string }) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [cases, setCases] = useState<ContactCaseLink[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await listDirectoryContactCases(contactId)
      setCases(res.cases)
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setLoading(false)
    }
  }, [contactId, t, toast])

  useEffect(() => { load() }, [load])

  if (loading) {
    return <LoadingPlaceholder />
  }

  if (cases.length === 0) {
    return (
      <div data-testid="contact-cases-empty" className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
        <FileText className="h-8 w-8 mb-2 opacity-40" />
        <p>{t('contactDirectory.noCases', { defaultValue: 'This contact is not linked to any cases.' })}</p>
      </div>
    )
  }

  return (
    <div data-testid="contact-cases-list" className="space-y-2">
      {cases.map(caseLink => (
        <Card key={caseLink.recordId} data-testid="contact-case-item">
          <CardContent className="flex items-center gap-3 py-3">
            <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p data-testid="contact-case-number" className="text-sm font-medium">
                  {caseLink.caseNumber ?? caseLink.recordId.slice(0, 8)}
                </p>
                <Badge variant="outline" className="text-[10px]">{caseLink.entityTypeLabel}</Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('contactDirectory.caseStatus', { defaultValue: 'Status' })}: {caseLink.status}
              </p>
            </div>
            <Badge data-testid="contact-case-role" variant="secondary" className="text-[10px]">{caseLink.role}</Badge>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function RelationshipsTab({ contactId }: { contactId: string }) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { hasPermission } = useAuth()
  const [relationships, setRelationships] = useState<ContactRelationship[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await listDirectoryContactRelationships(contactId)
      setRelationships(res.relationships)
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setLoading(false)
    }
  }, [contactId, t, toast])

  useEffect(() => { load() }, [load])

  if (loading) {
    return <LoadingPlaceholder />
  }

  const canWrite = hasPermission('contacts:manage-relationships')

  if (relationships.length === 0) {
    return (
      <div data-testid="contact-relationships-empty" className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
        <ArrowRight className="h-8 w-8 mb-2 opacity-40" />
        <p>{t('contactDirectory.noRelationships', { defaultValue: 'No relationships defined for this contact.' })}</p>
        {canWrite && (
          <div className="mt-4">
            <RelationshipWritePanel
              contactId={contactId}
              relationships={relationships}
              onRelationshipsChange={setRelationships}
              canWrite={canWrite}
            />
          </div>
        )}
      </div>
    )
  }

  if (canWrite) {
    return (
      <div data-testid="contact-relationships-list">
        <RelationshipWritePanel
          contactId={contactId}
          relationships={relationships}
          onRelationshipsChange={setRelationships}
          canWrite={canWrite}
        />
      </div>
    )
  }

  return (
    <div data-testid="contact-relationships-list" className="space-y-2">
      {relationships.map(rel => {
        // The wire row names the two contacts and seals its notes; the counterpart's display
        // name is inside that contact's own envelope and is not resolved here, so identify it
        // by id (the same convention as the groups sidebar).
        const isA = rel.contactIdA === contactId
        const pointsAtThisContact = (rel.direction === 'a_to_b' && !isA) || (rel.direction === 'b_to_a' && isA)
        return (
          <Card key={rel.id}>
            <CardContent className="flex items-center gap-3 py-3">
              <div className="flex items-center gap-1.5">
                <ArrowRight className={`h-3.5 w-3.5 text-muted-foreground ${pointsAtThisContact ? 'rotate-180' : ''}`} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{relationshipCounterpartId(rel, contactId).slice(0, 8)}</p>
                <p className="text-xs text-muted-foreground capitalize">{rel.relationshipType}</p>
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

function GroupsTab({ contactId }: { contactId: string }) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [groups, setGroups] = useState<AffinityGroup[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await listDirectoryContactGroups(contactId)
      setGroups(res.groups)
    } catch {
      toast(t('common.error'), 'error')
    } finally {
      setLoading(false)
    }
  }, [contactId, t, toast])

  useEffect(() => { load() }, [load])

  if (loading) {
    return <LoadingPlaceholder />
  }

  if (groups.length === 0) {
    return (
      <div data-testid="contact-groups-empty" className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
        <Users className="h-8 w-8 mb-2 opacity-40" />
        <p>{t('contactDirectory.noGroups', { defaultValue: 'This contact does not belong to any groups.' })}</p>
      </div>
    )
  }

  return (
    <div data-testid="contact-groups-list" className="space-y-2">
      {groups.map(group => (
        <Card key={group.id} data-testid="contact-group-item">
          <CardContent className="flex items-center gap-3 py-3">
            <Users className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{group.id.slice(0, 8)}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span data-testid="contact-group-member-count" className="text-xs text-muted-foreground">
                {t('contactDirectory.memberCount', { count: group.memberCount, defaultValue: '{{count}} members' })}
              </span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function RestrictedPlaceholder({ message }: { message: string }) {
  return (
    <div data-testid="contact-restricted" className="flex flex-col items-center justify-center py-12 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted/50 mb-4">
        <Shield className="h-8 w-8 text-muted-foreground" />
      </div>
      <Badge variant="outline" className="mb-2">
        <Lock className="h-3 w-3 mr-1" />
        {/* Restricted label intentionally hardcoded here for the badge */}
        Restricted
      </Badge>
      <p className="text-sm text-muted-foreground max-w-xs">{message}</p>
    </div>
  )
}

function LoadingPlaceholder() {
  return (
    <div className="flex items-center justify-center py-12">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  )
}
