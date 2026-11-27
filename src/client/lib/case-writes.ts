/**
 * The three writes that seal content onto an EXISTING case record: an edit of
 * its fields, a timeline comment, and an evidence file.
 *
 * Each of them is addressed to the admins of the RECORD's hub (`record.hubId`)
 * and filed in that same hub — never the hub being browsed. The active hub is a
 * browsing context (multi-hub axiom): the cross-hub case list shows records of
 * every hub the user belongs to, so a record in hub B can be open while hub A is
 * active. Resolving the readers from the active hub there sealed hub B's case
 * content to hub A's admins (#2527). The hub is therefore a required field of
 * `RecordRef`, read off the row, and the three writes live here together so the
 * rule is stated — and tested — in one place rather than at three call sites.
 */
import { sealCase } from './platform'
import { hubAdminReaders } from './admin-recipient'
import { resolveRecordReaders } from './record-recipients'
import { chunkedUpload } from './chunked-upload'
import { prepareEvidenceUpload } from './evidence-upload'
import { readTriage, type SealedSummary } from './case-triage'
import {
  updateRecord,
  createInteraction,
  type CaseRecord,
  uploadEvidence,
  type CaseInteraction,
  type EvidenceMetadata,
  type EvidenceClassification,
  type InteractionType,
} from './api'

/** The identity of a record: its id and — read off the row — its hub. */
export interface RecordRef {
  id: string
  hubId: string
}

/** `base`, then the record's hub admins, then `authorPubkey`; each key once. */
async function recipientsFor(
  record: RecordRef,
  authorPubkey: string,
  base: readonly string[] = [],
): Promise<string[]> {
  const admins = await hubAdminReaders(record.hubId)
  return Array.from(new Set([...base, authorPubkey, ...admins]))
}

/**
 * Seal a record's field values to its `fields` tier and save them in its hub.
 *
 * The tier is asked for now, by record id in the record's hub
 * (`resolveRecordReaders`): a save REPLACES the envelope set, so sealing to
 * the author and the admins alone would drop every co-assignee and `editRoles`
 * holder the record already had (#1682).
 */
export async function saveRecordFields(
  record: RecordRef,
  values: unknown,
  authorPubkey: string,
): Promise<void> {
  const readers = await resolveRecordReaders({ recordId: record.id, hubId: record.hubId, authorPubkey })
  const sealed = await sealCase('fields', JSON.stringify(values), readers.fields)
  await updateRecord(record.id, {
    encryptedFields: sealed.encryptedContent,
    fieldEnvelopes: sealed.readerEnvelopes,
  }, record.hubId)
}

/**
 * The token that marks a write as a status change. The server cannot see the
 * status, so it learns that one happened from this — and only that. It is the
 * interaction type, not a derived index (registered as known debt, #3118).
 */
const STATUS_CHANGE_TYPE = 'status_change'

/** Raised when a status change would have to overwrite a summary this device cannot read. */
export class SummaryUnreadableError extends Error {
  constructor() {
    super('The case summary cannot be opened on this device, so its status cannot be changed here.')
    this.name = 'SummaryUnreadableError'
  }
}

/**
 * Change a record's status: re-seal its summary with the new status VALUE and
 * file the transition as a sealed status-change entry on its timeline. Nothing
 * about the status travels in the clear (#2779).
 *
 * The summary is re-opened here, not taken from the caller: a status change
 * REPLACES the summary, so the title, description and severity it carries must
 * come from the current ciphertext. A summary this device cannot open is refused
 * rather than overwritten with a blank one.
 */
export async function changeRecordStatus(
  record: RecordRef & SealedSummary,
  status: string,
  authorPubkey: string,
): Promise<CaseRecord> {
  const current = await readTriage(record)
  if (!current) throw new SummaryUnreadableError()

  const readers = await resolveRecordReaders({ recordId: record.id, hubId: record.hubId, authorPubkey })
  const summary = await sealCase('summary', JSON.stringify({ ...current, status }), readers.summary)
  const change = await sealCase(
    'comment',
    JSON.stringify({ text: '', previousStatus: current.status, newStatus: status }),
    readers.summary,
  )
  return updateRecord(record.id, {
    encryptedSummary: summary.encryptedContent,
    summaryEnvelopes: summary.readerEnvelopes,
    statusChangeTypeHash: STATUS_CHANGE_TYPE,
    statusChangeContent: change.encryptedContent,
    statusChangeEnvelopes: change.readerEnvelopes,
  }, record.hubId)
}

/** Seal a timeline comment to the record's readers and file it in its hub. */
export async function postCaseComment(
  record: RecordRef,
  text: string,
  authorPubkey: string,
  readerPubkeys: readonly string[],
  interactionTypeHash: string,
): Promise<CaseInteraction> {
  const readers = await recipientsFor(record, authorPubkey, readerPubkeys)
  const sealed = await sealCase('comment', text, readers)
  const type: InteractionType = 'comment'
  return createInteraction(record.id, record.hubId, {
    interactionType: type,
    encryptedContent: sealed.encryptedContent,
    contentEnvelopes: sealed.readerEnvelopes,
    interactionTypeHash,
  })
}

/**
 * Encrypt an evidence file to the record's readers, upload it as a file of the
 * record, and register it as evidence — all in the record's hub.
 *
 * `sizeBytes` and `integrityHash` are derived from the CIPHERTEXT: a hash or
 * length of the plaintext stored next to the ciphertext would let the server (or
 * anyone with its DB) confirm a guessed file without decrypting.
 */
export async function uploadCaseEvidence(args: {
  record: RecordRef
  file: File
  authorPubkey: string
  readerPubkeys: readonly string[]
  classification: EvidenceClassification
  chunkSize: number
  onProgress: (percent: number) => void
}): Promise<EvidenceMetadata> {
  const { record, file, onProgress } = args
  const recipients = await recipientsFor(record, args.authorPubkey, args.readerPubkeys)
  const { encrypted, sizeBytes, integrityHash } = await prepareEvidenceUpload(file, recipients)
  onProgress(15)

  // The record — not a conversation — is the file's parent (#2462).
  const { fileId } = await chunkedUpload({
    encrypted,
    owner: { kind: 'case_record', caseRecordId: record.id },
    hubId: record.hubId,
    chunkSize: args.chunkSize,
    onProgress: (completed, total) => onProgress(20 + Math.round((completed / total) * 70)),
  })
  onProgress(95)

  const evidence = await uploadEvidence(record.id, record.hubId, {
    fileId,
    filename: file.name,
    mimeType: file.type || 'application/octet-stream',
    sizeBytes,
    classification: args.classification,
    integrityHash,
    source: 'volunteer_upload',
  })
  onProgress(100)
  return evidence
}
