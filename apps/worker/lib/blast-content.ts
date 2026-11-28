/**
 * Blast content: the wire shape and the storage shape, and the one pair of
 * functions that crosses between them (#2572).
 *
 * - Wire (`@protocol/schemas/blasts`): `{ body, mediaUrl? }` or a record of those
 *   keyed by language code. Requests carry it and every blast response answers
 *   with it, so a client sends and reads one shape.
 * - Storage (`@shared/types` `BlastContent`): `{ text, mediaUrl?, ... }` with the
 *   per-channel overrides the delivery worker reads. The `blasts.content` jsonb
 *   column holds this.
 */
import type { SingleBlastContent, BlastContentInput } from '@protocol/schemas/blasts'
import { isSingleBlastContent } from '@shared/types'
import type { BlastContent, MultiBlastContent } from '@shared/types'

type WireContent = BlastContentInput

function singleToStorage(entry: SingleBlastContent): BlastContent {
  return { text: entry.body, mediaUrl: entry.mediaUrl }
}

function singleToWire(entry: BlastContent): SingleBlastContent {
  return entry.mediaUrl === undefined
    ? { body: entry.text }
    : { body: entry.text, mediaUrl: entry.mediaUrl }
}

/** Wire content (a request body) to the shape the `blasts.content` column stores. */
export function toStorageContent(input: WireContent): BlastContent | MultiBlastContent {
  if (typeof (input as Partial<SingleBlastContent>).body === 'string') {
    return singleToStorage(input as SingleBlastContent)
  }
  const result: MultiBlastContent = {}
  for (const [lang, entry] of Object.entries(input as Record<string, SingleBlastContent>)) {
    result[lang] = singleToStorage(entry)
  }
  return result
}

/** Stored content to the wire shape every blast response declares. */
export function toWireContent(content: BlastContent | MultiBlastContent): WireContent {
  if (isSingleBlastContent(content)) return singleToWire(content)
  const result: Record<string, SingleBlastContent> = {}
  for (const [lang, entry] of Object.entries(content)) {
    result[lang] = singleToWire(entry)
  }
  return result
}

/** A blast row with its stored content replaced by the wire content. */
export function toWireBlast<T extends { content: unknown }>(
  blast: T,
): Omit<T, 'content'> & { content: WireContent } {
  return { ...blast, content: toWireContent(blast.content as BlastContent | MultiBlastContent) }
}
