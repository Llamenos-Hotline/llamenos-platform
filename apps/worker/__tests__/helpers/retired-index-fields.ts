/**
 * The plaintext-under-a-hash-name fields that #2779 and #3114 retired. A case's
 * status, severity and category, and a contact's type, are sealed in the
 * record's summary and filtered by the client after it decrypts; the server
 * never receives them.
 *
 * This is the one place a test names them. Source under `apps/worker`,
 * `packages/protocol/schemas` and the three clients may not (the
 * `triage-state-retired` gate checks), so a test that proves a field is
 * refused imports the list from here instead of spelling it.
 */
export const RETIRED_INDEX_FIELDS = [
  'statusHash',
  'severityHash',
  'categoryHash',
  'contactTypeHash',
] as const

/** The interaction body's retired audit copy of a status change. */
export const RETIRED_INTERACTION_FIELDS = ['previousStatusHash', 'newStatusHash'] as const
