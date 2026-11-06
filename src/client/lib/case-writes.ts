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
import { chunkedUpload } from './chunked-upload'
import { prepareEvidenceUpload } from './evidence-upload'
import {
  updateRecord,
  createInteraction,
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

/** Seal a record's field values to its readers and save them in its hub. */
export async function saveRecordFields(
  record: RecordRef,
  values: unknown,
  authorPubkey: string,
): Promise<void> {
  const readers = await recipientsFor(record, authorPubkey)
  const sealed = await sealCase('fields', JSON.stringify(values), readers)
  await updateRecord(record.id, {
    encryptedFields: sealed.encryptedContent,
    fieldEnvelopes: sealed.readerEnvelopes,
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
