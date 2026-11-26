import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compareOutputs, type OutputRoot } from './output-check'

let dir: string
let roots: OutputRoot[]
let expected: Map<string, string>

function put(rel: string, content: string) {
  const path = join(dir, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'i18n-output-check-'))
  roots = [
    { dir: join(dir, 'ios'), owns: rel => /^[^/]+\.lproj\/Localizable\.strings$/.test(rel) },
    { dir: join(dir, 'res'), owns: rel => /^values[^/]*\/strings\.xml$/.test(rel) },
  ]
  expected = new Map([
    [join(dir, 'ios/en.lproj/Localizable.strings'), '"a" = "A";\n'],
    [join(dir, 'ios/fr.lproj/Localizable.strings'), '"a" = "Á";\n'],
    [join(dir, 'res/values/strings.xml'), '<resources/>\n'],
  ])
  for (const [path, content] of expected) put(path.slice(dir.length + 1), content)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('compareOutputs (#1901)', () => {
  it('passes when the disk holds exactly what codegen produces', () => {
    expect(compareOutputs(expected, roots)).toEqual([])
  })

  it('fails on a hand-edited (tampered) generated file', () => {
    put('ios/fr.lproj/Localizable.strings', '"a" = "Á";\n"bogus" = "x";\n')
    expect(compareOutputs(expected, roots)).toEqual([{ kind: 'stale', path: join(dir, 'ios/fr.lproj/Localizable.strings') }])
  })

  it('fails when a locale edit was not regenerated (expected content moved on)', () => {
    expected.set(join(dir, 'res/values/strings.xml'), '<resources><string name="a">A</string></resources>\n')
    expect(compareOutputs(expected, roots)).toEqual([{ kind: 'stale', path: join(dir, 'res/values/strings.xml') }])
  })

  it('fails when an output was never generated', () => {
    rmSync(join(dir, 'ios/en.lproj'), { recursive: true })
    expect(compareOutputs(expected, roots)).toEqual([{ kind: 'missing', path: join(dir, 'ios/en.lproj/Localizable.strings') }])
  })

  it('fails on an owned file no locale produces (a removed locale left behind)', () => {
    put('res/values-xx/strings.xml', '<resources/>\n')
    expect(compareOutputs(expected, roots)).toEqual([{ kind: 'orphan', path: join(dir, 'res/values-xx/strings.xml') }])
  })

  it('ignores files in a root that codegen does not own', () => {
    put('res/values/colors.xml', '<resources/>\n')
    put('ios/.DS_Store', 'x')
    expect(compareOutputs(expected, roots)).toEqual([])
  })
})
