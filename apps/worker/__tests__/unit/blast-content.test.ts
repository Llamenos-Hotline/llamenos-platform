import { describe, it, expect } from 'vitest'
import { blastResponseSchema, createBlastBodySchema } from '@protocol/schemas/blasts'
import { toStorageContent, toWireContent, toWireBlast } from '@worker/lib/blast-content'

describe('blast content wire <-> storage (#2572)', () => {
  it('stores single-language wire content as text', () => {
    expect(toStorageContent({ body: 'Hello', mediaUrl: 'https://x.test/a.png' })).toEqual({
      text: 'Hello',
      mediaUrl: 'https://x.test/a.png',
    })
  })

  it('stores multi-language wire content as text per language', () => {
    expect(toStorageContent({ en: { body: 'Hello' }, es: { body: 'Hola' } })).toEqual({
      en: { text: 'Hello' },
      es: { text: 'Hola' },
    })
  })

  it('answers single-language storage content as body', () => {
    expect(toWireContent({ text: 'Hello', smsText: 'Hi' })).toEqual({ body: 'Hello' })
    expect(toWireContent({ text: 'Hello', mediaUrl: 'https://x.test/a.png' })).toEqual({
      body: 'Hello',
      mediaUrl: 'https://x.test/a.png',
    })
  })

  it('answers multi-language storage content as body per language', () => {
    expect(toWireContent({ en: { text: 'Hello' }, es: { text: 'Hola' } })).toEqual({
      en: { body: 'Hello' },
      es: { body: 'Hola' },
    })
  })

  it('round-trips what a client sends back to what it reads', () => {
    for (const sent of [
      { body: 'Hello' },
      { body: 'Hello', mediaUrl: 'https://x.test/a.png' },
      { en: { body: 'Hello' }, es: { body: 'Hola' } },
    ]) {
      const parsed = createBlastBodySchema.parse({ name: 'n', content: sent, channels: ['sms'] })
      expect(toWireContent(toStorageContent(parsed.content))).toEqual(sent)
    }
  })

  it('a wired blast satisfies the declared response schema', () => {
    const now = new Date().toISOString()
    const row = {
      id: 'b1',
      name: 'n',
      content: { text: 'Hello' },
      status: 'draft',
      targetChannels: ['sms'],
      createdAt: now,
      updatedAt: now,
    }
    expect(blastResponseSchema.safeParse(toWireBlast(row)).success).toBe(true)
    expect(toWireBlast(row).content).toEqual({ body: 'Hello' })
  })
})
