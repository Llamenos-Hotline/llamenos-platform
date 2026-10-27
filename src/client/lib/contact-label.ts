/**
 * How a messaging thread names its contact on screen.
 *
 * The server keeps no part of the contact's number: a thread is identified by a
 * per-hub keyed hash of it (#2182). So the label is a short prefix of that hash,
 * enough to tell two threads apart and to search on. A thread without a hash —
 * a web report, whose contact is its author's key, or a thread whose hash was
 * cleared by a migration — has no label, and the caller shows "Unknown".
 */
export const CONTACT_LABEL_LENGTH = 8

interface Labelled {
  channelType: string
  contactIdentifierHash: string
}

export function contactLabel(conv: Labelled): string | undefined {
  if (conv.channelType === 'web' || !conv.contactIdentifierHash) return undefined
  return conv.contactIdentifierHash.slice(0, CONTACT_LABEL_LENGTH)
}

/** True when `query` is the start of the thread's hash. Prefix only: a substring would let a short query match many unrelated threads. */
export function matchesContactHash(conv: Labelled, query: string): boolean {
  if (!query || conv.channelType === 'web' || !conv.contactIdentifierHash) return false
  return conv.contactIdentifierHash.toLowerCase().startsWith(query.toLowerCase())
}
