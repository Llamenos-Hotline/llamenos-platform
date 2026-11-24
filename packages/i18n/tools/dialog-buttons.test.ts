import { readdirSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { findButtonCollisions, listDialogButtonPairs } from './dialog-buttons'

const LOCALES_DIR = resolve(__dirname, '../locales')
const load = (code: string) => JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'))

describe('listDialogButtonPairs', () => {
  it('pairs the bare dismiss key with its acting siblings in the same namespace', () => {
    const en = { common: { cancel: 'Cancel', delete: 'Delete', save: 'Save', edit: 'Edit' } }
    expect(listDialogButtonPairs(en)).toEqual([
      { namespace: 'common', dismissKey: 'cancel', actingKey: 'delete' },
      { namespace: 'common', dismissKey: 'cancel', actingKey: 'save' },
    ])
  })

  it('pairs a prefixed dismiss key only with siblings sharing the prefix', () => {
    const en = { deepLinkConfirmCancel: 'Cancel', deepLinkConfirmProceed: 'Proceed', proceed: 'Go' }
    expect(listDialogButtonPairs(en)).toEqual([
      { namespace: '', dismissKey: 'deepLinkConfirmCancel', actingKey: 'deepLinkConfirmProceed' },
    ])
  })

  it('does not compare pairs en.json itself gives identical text', () => {
    expect(listDialogButtonPairs({ cancel: 'OK', ok: 'OK' })).toEqual([])
  })
})

describe('findButtonCollisions', () => {
  const en = { common: { cancel: 'Cancel', delete: 'Delete' } }

  it('flags cancel and delete rendering as the same word', () => {
    const am = { common: { cancel: 'ሰርዝ', delete: 'ሰርዝ' } }
    expect(findButtonCollisions(en, am, 'am')).toEqual([
      { locale: 'am', namespace: 'common', dismissKey: 'cancel', actingKey: 'delete', value: 'ሰርዝ' },
    ])
  })

  it('ignores case and surrounding whitespace when comparing', () => {
    expect(findButtonCollisions(en, { common: { cancel: 'Borrar ', delete: 'borrar' } }, 'es')).toHaveLength(1)
  })

  it('passes distinct labels, and ignores keys a locale lacks', () => {
    expect(findButtonCollisions(en, { common: { cancel: 'ይቅር', delete: 'ሰርዝ' } }, 'am')).toEqual([])
    expect(findButtonCollisions(en, { common: { cancel: 'x' } }, 'xx')).toEqual([])
  })
})

describe('shipped locales', () => {
  const codes = readdirSync(LOCALES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
  const en = load('en')

  it('finds the dialog pairs the apps actually render (guards the scanner itself)', () => {
    const pairs = listDialogButtonPairs(en)
    expect(pairs).toContainEqual({ namespace: 'common', dismissKey: 'cancel', actingKey: 'delete' })
    expect(pairs).toContainEqual({ namespace: '', dismissKey: 'cancel', actingKey: 'delete' })
  })

  it.each(codes)('%s has no indistinguishable dialog buttons', (code) => {
    expect(findButtonCollisions(en, load(code), code)).toEqual([])
  })
})
