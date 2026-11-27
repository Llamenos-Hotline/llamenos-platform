import { describe, expect, test } from 'bun:test'
import { checkAmendmentPointers, loadSpecs, type SpecFile } from './check-amendment-pointers'

const POINTER = '**Amended by #3033 (releases §6), effective once #2977 stage 3 lands.**'

const amender = (body: string): SpecFile => ({ path: 'specs/a-v2-amender.md', text: `# Amender\n\n${body}\n` })
const amended = (section: string, extra = ''): SpecFile => ({
  path: 'specs/b-v2-amended.md',
  text: `# Amended\n\n## 8. C11: SDK and runtime — decided\n${section}\n\n### 8.1 Detail\nmore\n\n## 9. C12: next\n${extra}\n`,
})

describe('checkAmendmentPointers', () => {
  test('passes when the defining section carries a pointer with its condition', () => {
    expect(checkAmendmentPointers([amender('### 10.2 One boundary (amends C11)'), amended(POINTER)])).toEqual([])
  })

  test('negative: no pointer in the defining section', () => {
    const [p] = checkAmendmentPointers([amender('### 10.2 One boundary (amends C11)'), amended('Plain text.')])
    expect(p.id).toBe('C11')
    expect(p.file).toBe('specs/a-v2-amender.md')
    expect(p.line).toBe(3)
    expect(p.message).toContain('specs/b-v2-amended.md:3')
    expect(p.message).toContain('no pointer back')
  })

  test('negative: a bare "see #X" is not a pointer — the effective condition is the point', () => {
    const problems = checkAmendmentPointers([amender('amends C11'), amended('See #3033.')])
    expect(problems).toHaveLength(1)
    const noCondition = checkAmendmentPointers([amender('amends C11'), amended('**Amended by #3033 (releases §6).**')])
    expect(noCondition).toHaveLength(1)
  })

  test('negative: the pointer sits in the NEXT decision, not this one', () => {
    const problems = checkAmendmentPointers([amender('amends C11'), amended('Plain.', POINTER)])
    expect(problems).toHaveLength(1)
  })

  test('a pointer inside a subsection of the decision counts', () => {
    const spec = amended('Plain.')
    spec.text = spec.text.replace('more', POINTER)
    expect(checkAmendmentPointers([amender('amends C11'), spec])).toEqual([])
  })

  test('negative: no spec defines the id', () => {
    const [p] = checkAmendmentPointers([amender('amends Z9'), amended(POINTER)])
    expect(p.id).toBe('Z9')
    expect(p.message).toContain('no other v2 spec has a heading defining Z9')
  })

  test('negative: the id is defined twice, and both files are named', () => {
    const other: SpecFile = { path: 'specs/c-v2-other.md', text: '## 3. C11: again\n' + POINTER + '\n' }
    const [p] = checkAmendmentPointers([amender('amends C11'), amended(POINTER), other])
    expect(p.message).toContain('specs/b-v2-amended.md:3')
    expect(p.message).toContain('specs/c-v2-other.md:1')
  })

  test('the amending file does not count as a definition of its own target', () => {
    const self: SpecFile = { path: 'specs/a-v2-amender.md', text: '## 1. C11: mine\namends C11\n' }
    expect(checkAmendmentPointers([self])).toHaveLength(1)
  })

  test('"amends #3027 X3" form resolves X3, and a ##-less number-less heading defines it', () => {
    const target: SpecFile = { path: 'specs/s-v2-search.md', text: `### X3: which hubs\n${POINTER}\n` }
    expect(checkAmendmentPointers([amender('(amends #3027 X3)'), target])).toEqual([])
  })

  test('prose that is not a marker is ignored', () => {
    const t = amended('Plain.')
    expect(checkAmendmentPointers([amender('This amends wire §2.8 and amends its policy body.'), t])).toEqual([])
  })

  test('markers and headings inside code fences are ignored', () => {
    const fenced = amender('```\namends C11\n```')
    expect(checkAmendmentPointers([fenced, amended('Plain.')])).toEqual([])
    const fakeDef: SpecFile = { path: 'specs/b-v2-amended.md', text: '```\n## 1. C11: not real\n```\n' }
    expect(checkAmendmentPointers([amender('amends C11'), fakeDef])).toHaveLength(1)
  })

  test('one problem per (file, id), not per mention', () => {
    expect(checkAmendmentPointers([amender('amends C11\n\namends C11 again'), amended('Plain.')])).toHaveLength(1)
  })
})

describe('the committed v2 specs', () => {
  const specs = loadSpecs(new URL('..', import.meta.url).pathname)

  test('scans the v2 specs (a guard that scanned nothing proves nothing)', () => {
    expect(specs.length).toBeGreaterThanOrEqual(9)
    expect(specs.some((s) => s.path.endsWith('2026-11-25-v2-connectors-and-intake.md'))).toBe(true)
    expect(specs.some((s) => s.path.endsWith('2026-11-24-encryption-v2-wire-format.md'))).toBe(true)
  })

  test('every "amends <ID>" has its pointer back', () => {
    expect(checkAmendmentPointers(specs)).toEqual([])
  })

  test('is not vacuous: the specs really contain amendment markers', () => {
    const markers = specs.flatMap((s) => [...s.text.matchAll(/\bamends (?:#\d+ )?[A-Z]{1,2}\d+\b/g)])
    expect(markers.length).toBeGreaterThanOrEqual(6)
  })
})
