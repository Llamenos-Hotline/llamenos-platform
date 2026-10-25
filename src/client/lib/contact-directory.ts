import {
  listRawContacts,
  type RawContact,
  type DirectoryContact,
  type DirectoryContactType,
  type DirectoryContactSummary,
  type ContactPII,
  type ContactIdentifier,
} from '@/lib/api'
import { decryptMessage } from '@/lib/platform'

/** Decrypt a RawContact into a DirectoryContact for UI rendering */
export async function decryptContact(raw: RawContact): Promise<DirectoryContact> {
  let displayName = raw.id.slice(0, 8) + '...'
  let contactType: DirectoryContactType = 'individual'
  let tags: string[] = []
  let canDecrypt = false
  let demographics: string | undefined
  let emergencyContacts: string | undefined
  let communicationPrefs: string | undefined
  let notes: string | undefined
  let identifiers: ContactIdentifier[] | undefined

  // Decrypt summary tier
  if (raw.encryptedSummary && raw.summaryEnvelopes?.length) {
    const plaintext = await decryptMessage(raw.encryptedSummary, raw.summaryEnvelopes)
    if (plaintext) {
      canDecrypt = true
      try {
        const summary = JSON.parse(plaintext) as DirectoryContactSummary
        displayName = summary.displayName || displayName
        if (summary.contactType) {
          contactType = summary.contactType as DirectoryContactType
        }
        tags = summary.tags ?? []
      } catch { /* malformed JSON */ }
    }
  }

  // Use contactTypeHash as fallback
  if (!canDecrypt && raw.contactTypeHash) {
    contactType = raw.contactTypeHash as DirectoryContactType
  }

  // Decrypt PII tier
  if (raw.encryptedPII && raw.piiEnvelopes?.length) {
    const piiPlaintext = await decryptMessage(raw.encryptedPII, raw.piiEnvelopes)
    if (piiPlaintext) {
      try {
        const pii = JSON.parse(piiPlaintext) as ContactPII
        if (pii.demographics) {
          demographics = typeof pii.demographics === 'string'
            ? pii.demographics
            : JSON.stringify(pii.demographics)
        }
        if (pii.emergencyContacts) {
          emergencyContacts = JSON.stringify(pii.emergencyContacts)
        }
        if (pii.communicationPreferences) {
          communicationPrefs = JSON.stringify(pii.communicationPreferences)
        }
        notes = pii.notes
        if (pii.identifiers?.length) {
          identifiers = pii.identifiers.map((ident, i) => ({
            id: `${raw.id}-ident-${i}`,
            type: ident.type as 'phone' | 'email' | 'signal',
            value: ident.value,
            isPrimary: ident.isPrimary,
          }))
        }
      } catch { /* malformed JSON */ }
    }
  }

  return {
    id: raw.id,
    displayName,
    contactType,
    tags,
    caseCount: raw.caseCount,
    lastInteractionAt: raw.lastInteractionAt || null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    canDecrypt,
    demographics,
    emergencyContacts,
    communicationPrefs,
    notes,
    identifiers,
    _raw: raw,
  }
}

/** Page size of the directory the client holds and searches; see matchesContactQuery. */
export const DIRECTORY_PAGE_SIZE = 50

/** Fetch one page of the directory and decrypt it. */
export async function loadDecryptedContacts(params?: { contactTypeHash?: string }) {
  const res = await listRawContacts({ limit: DIRECTORY_PAGE_SIZE, ...params })
  return { contacts: await Promise.all(res.contacts.map(decryptContact)), total: res.total }
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
const digitsOf = (s: string) => s.replace(/\D/g, '')

/**
 * Does a decrypted contact match what the user typed?
 *
 * Runs entirely on the client over contacts it has already decrypted: the query is a
 * caller's name or phone number and must never leave the device, in plaintext or as any
 * derived index (#2224). Every whitespace-separated term must match somewhere in the
 * display name, tags or identifiers; terms that are mostly digits (a phone number typed
 * with or without punctuation) are compared digit-for-digit against identifier values.
 *
 * The limit is the caller's: this only sees the contacts it is handed (one page of the
 * directory), so a contact beyond that page cannot be found until blind-index search
 * (#1042) exists.
 */
export function matchesContactQuery(contact: DirectoryContact, query: string): boolean {
  const terms = fold(query).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true

  const text = fold([
    contact.displayName,
    ...contact.tags,
    ...(contact.identifiers ?? []).map((i) => i.value),
  ].join('\n'))
  const identifierDigits = (contact.identifiers ?? []).map((i) => digitsOf(i.value))

  return terms.every((term) => {
    if (text.includes(term)) return true
    const termDigits = digitsOf(term)
    // A phone number typed with punctuation ("123-4567") is mostly digits; a word like "a1" is not.
    return termDigits.length >= 3
      && termDigits.length * 2 >= term.length
      && identifierDigits.some((d) => d.includes(termDigits))
  })
}
