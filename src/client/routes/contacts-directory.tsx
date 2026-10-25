import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/lib/toast'
import { useState, useEffect, useCallback } from 'react'
import {
  getRawContact,
  type RawContact,
  type DirectoryContact,
} from '@/lib/api'
import { decryptContact, loadDecryptedContacts, matchesContactQuery } from '@/lib/contact-directory'
import { ContactCard } from '@/components/contacts/contact-card'
import { ContactProfile } from '@/components/contacts/contact-profile'
import { CreateContactDialog } from '@/components/contacts/create-contact-dialog'
import { ContactImportDialog } from '@/components/contact-import-dialog'
import { EditContactDialog } from '@/components/contacts/edit-contact-dialog'
import { AffinityGroupsSidebar } from '@/components/contacts/affinity-groups-sidebar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useTags } from '@/lib/queries/tags'
import { useTeams } from '@/lib/queries/teams'
import {
  Users, Plus, Search, Loader2, Upload, Pencil,
} from 'lucide-react'

export const Route = createFileRoute('/contacts-directory')({
  component: ContactDirectoryPage,
})

function ContactDirectoryPage() {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [contacts, setContacts] = useState<DirectoryContact[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedContact, setSelectedContact] = useState<DirectoryContact | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)

  // Search is a client-side filter over the loaded, decrypted contacts. The query is a
  // caller's name or number and is never sent to the server (#2224).
  const [searchQuery, setSearchQuery] = useState('')

  // Filter state
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [tagFilter, setTagFilter] = useState<string>('all')
  const [teamFilter, setTeamFilter] = useState<string>('all')

  const { data: availableTags = [] } = useTags()
  const { data: availableTeams = [] } = useTeams()

  // Load + decrypt contacts
  const loadContacts = useCallback(async () => {
    setLoading(true)
    try {
      const res = await loadDecryptedContacts(
        typeFilter !== 'all' ? { contactTypeHash: typeFilter } : undefined,
      )
      setContacts(res.contacts)
      setTotal(res.total)
    } catch {
      toast(t('contactDirectory.loadError', { defaultValue: 'Failed to load contacts' }), 'error')
    } finally {
      setLoading(false)
    }
  }, [typeFilter, t, toast])

  useEffect(() => { loadContacts() }, [loadContacts])

  // Load full contact detail when selected
  useEffect(() => {
    if (!selectedId) {
      setSelectedContact(null)
      return
    }

    // Use the list version first for instant display
    const listContact = contacts.find(c => c.id === selectedId)
    if (listContact) {
      setSelectedContact(listContact)
    }

    setDetailLoading(true)
    getRawContact(selectedId)
      .then(async (raw) => {
        const decrypted = await decryptContact(raw as unknown as RawContact)
        setSelectedContact(decrypted)
      })
      .catch(() => {
        toast(t('contactDirectory.detailError', { defaultValue: 'Failed to load contact details' }), 'error')
      })
      .finally(() => setDetailLoading(false))
  }, [selectedId, contacts, t, toast])

  const handleContactCreated = useCallback((contact: DirectoryContact) => {
    setContacts(prev => [contact, ...prev])
    setTotal(prev => prev + 1)
    setSelectedId(contact.id)
  }, [])

  // Client-side search + tag/team filter applied on top of the loaded page
  // Tag filter matches against the contact summary's tag slugs.
  // Team filter is UI-only at this stage — full server-side filtering requires
  // fetching contactTeamAssignments per contact which is deferred to a follow-up.
  const filteredContacts = contacts.filter((c) => {
    if (!matchesContactQuery(c, searchQuery)) return false
    if (tagFilter !== 'all') {
      const tag = availableTags.find((t) => t.id === tagFilter)
      if (tag && !c.tags.includes(tag.name)) return false
    }
    return true
  })

  const showEmptyState = !loading && contacts.length === 0 && !searchQuery

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <Users className="h-6 w-6 text-primary" />
          <h1 data-testid="page-title" className="text-xl font-bold sm:text-2xl">
            {t('contactDirectory.title', { defaultValue: 'Contact Directory' })}
          </h1>
          {total > 0 && (
            <Badge variant="secondary" className="text-xs">
              {total}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            data-testid="import-contacts-btn"
            onClick={() => setShowImportDialog(true)}
          >
            <Upload className="h-3.5 w-3.5" />
            {t('cms.importContacts', { defaultValue: 'Import' })}
          </Button>
          <Button size="sm" data-testid="new-contact-btn" onClick={() => setShowCreateDialog(true)}>
            <Plus className="h-3.5 w-3.5" />
            {t('contactDirectory.new', { defaultValue: 'New Contact' })}
          </Button>
        </div>
      </div>

      {showEmptyState ? (
        <Card data-testid="empty-state">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Users className="mb-3 h-10 w-10 text-muted-foreground/40" />
            <p className="text-muted-foreground">
              {t('contactDirectory.noContacts', { defaultValue: 'No contacts in the directory' })}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('contactDirectory.noContactsHint', { defaultValue: 'Contacts are created automatically from incoming calls, or you can add them manually.' })}
            </p>
            <Button
              size="sm"
              className="mt-4"
              data-testid="empty-state-create-btn"
              onClick={() => setShowCreateDialog(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              {t('contactDirectory.new', { defaultValue: 'New Contact' })}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="flex h-[calc(100vh-12rem)] gap-4">
          {/* Groups sidebar */}
          <div className="w-40 shrink-0 overflow-hidden rounded-lg border border-border bg-card hidden lg:flex flex-col">
            <AffinityGroupsSidebar
              selectedGroupId={selectedGroupId}
              onGroupSelect={setSelectedGroupId}
            />
          </div>

          {/* Left pane: contact list */}
          <div
            data-testid="contact-list"
            className="w-80 shrink-0 overflow-y-auto rounded-lg border border-border bg-card md:block"
          >
            {/* Search + filters */}
            <div className="sticky top-0 z-10 border-b border-border bg-card p-3 space-y-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  data-testid="contact-search-input"
                  placeholder={t('contactDirectory.searchPlaceholder', { defaultValue: 'Search contacts...' })}
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>

              {/* Type filter */}
              <Select value={typeFilter} onValueChange={v => { setTypeFilter(v); setSearchQuery('') }}>
                <SelectTrigger data-testid="contact-type-filter" size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {t('contactDirectory.allTypes', { defaultValue: 'All types' })}
                  </SelectItem>
                  <SelectItem value="individual">
                    {t('contactDirectory.typeIndividual', { defaultValue: 'Individual' })}
                  </SelectItem>
                  <SelectItem value="organization">
                    {t('contactDirectory.typeOrganization', { defaultValue: 'Organization' })}
                  </SelectItem>
                  <SelectItem value="legal_resource">
                    {t('contactDirectory.typeLegalResource', { defaultValue: 'Legal Resource' })}
                  </SelectItem>
                  <SelectItem value="service_provider">
                    {t('contactDirectory.typeServiceProvider', { defaultValue: 'Service Provider' })}
                  </SelectItem>
                </SelectContent>
              </Select>

              {/* Tag filter */}
              {availableTags.length > 0 && (
                <Select value={tagFilter} onValueChange={setTagFilter}>
                  <SelectTrigger data-testid="contact-tag-filter" size="sm" className="w-full">
                    <SelectValue placeholder={t('contactDirectory.filterByTag', { defaultValue: 'All tags' })} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">
                      {t('contactDirectory.allTags', { defaultValue: 'All tags' })}
                    </SelectItem>
                    {availableTags.map((tag) => (
                      <SelectItem key={tag.id} value={tag.id}>
                        <span className="flex items-center gap-1.5">
                          <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ backgroundColor: tag.color }}
                          />
                          {tag.label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              {/* Team filter */}
              {availableTeams.length > 0 && (
                <Select value={teamFilter} onValueChange={setTeamFilter}>
                  <SelectTrigger data-testid="contact-team-filter" size="sm" className="w-full">
                    <SelectValue placeholder={t('contactDirectory.filterByTeam', { defaultValue: 'All teams' })} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">
                      {t('contactDirectory.allTeams', { defaultValue: 'All teams' })}
                    </SelectItem>
                    {availableTeams.map((team) => (
                      <SelectItem key={team.id} value={team.id}>
                        {team.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* Contact list */}
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : filteredContacts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center px-4">
                <Search className="h-6 w-6 mb-2 text-muted-foreground/40" />
                <p data-testid="contact-list-no-results" className="text-sm text-muted-foreground">
                  {searchQuery
                    ? t('contactDirectory.noSearchResults', { defaultValue: 'No contacts match your search.' })
                    : t('contactDirectory.noFilterResults', { defaultValue: 'No contacts match the selected filter.' })}
                </p>
              </div>
            ) : (
              <div className="p-2 space-y-1.5">
                {filteredContacts.map(contact => (
                  <ContactCard
                    key={contact.id}
                    contact={contact}
                    isSelected={selectedId === contact.id}
                    onSelect={setSelectedId}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Right pane: contact detail */}
          <div
            data-testid="contact-detail"
            className="flex flex-1 flex-col rounded-lg border border-border bg-card overflow-hidden"
          >
            {selectedContact ? (
              detailLoading ? (
                <div className="flex flex-1 items-center justify-center">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="flex flex-col h-full">
                  {selectedContact.canDecrypt && (
                    <div className="flex justify-end px-3 pt-2 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => setShowEditDialog(true)}
                        data-testid="edit-contact-button"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        {t('common.edit', { defaultValue: 'Edit' })}
                      </Button>
                    </div>
                  )}
                  <ContactProfile
                    contact={selectedContact}
                    onContactMerged={() => { setSelectedId(null); loadContacts() }}
                  />
                </div>
              )
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground">
                <Users className="h-10 w-10 mb-3" />
                <p>{t('contactDirectory.selectContact', { defaultValue: 'Select a contact to view details' })}</p>
              </div>
            )}
          </div>
        </div>
      )}

      <CreateContactDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onCreated={handleContactCreated}
      />

      <ContactImportDialog
        open={showImportDialog}
        onOpenChange={setShowImportDialog}
        onImported={(count) => {
          toast(t('cms.importSuccess', { count }))
          loadContacts()
        }}
      />

      {selectedContact && (
        <EditContactDialog
          contact={selectedContact}
          open={showEditDialog}
          onOpenChange={setShowEditDialog}
          onUpdated={(raw) => {
            setContacts(prev => prev.map(c => c.id === raw.id ? { ...c, _raw: raw } : c))
          }}
        />
      )}
    </div>
  )
}
