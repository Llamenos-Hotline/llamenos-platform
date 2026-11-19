// @suite: repo
/**
 * Rails for scripts/test-repo.ts (#2730): the discovery that replaced the
 * one-line path list in package.json. If it silently found too little, the
 * tier would go green having measured less, so these pin both directions —
 * a marked file is picked up wherever it lives, an unmarked or skipped one never.
 *
 *   bun test scripts/test-repo.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DIRECTORY_ROOTS, HEAD_LINES, discoverMarked, hasMarker, repoTestPaths } from './test-repo'

const sandboxes: string[] = []
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'test-repo-'))
  sandboxes.push(root)
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  return root
}
afterAll(() => { for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true }) })

const MARKED = '// @suite: repo\nexport {}\n'

describe('hasMarker', () => {
  test('accepts the line comment, with or without surrounding whitespace', () => {
    expect(hasMarker(MARKED)).toBe(true)
    expect(hasMarker('  //   @suite:repo  \n')).toBe(true)
  })
  test('accepts it below a leading docblock, inside the head window', () => {
    expect(hasMarker('/**\n * docs\n */\n// @suite: repo\n')).toBe(true)
  })
  test('rejects other suites, prose mentions and a marker past the head window', () => {
    expect(hasMarker('// @suite: migration\n')).toBe(false)
    expect(hasMarker('// see @suite: repo for details\n')).toBe(false)
    expect(hasMarker(`${'\n'.repeat(HEAD_LINES)}// @suite: repo\n`)).toBe(false)
  })
})

describe('discoverMarked', () => {
  test('finds marked tests at any depth, sorted, as POSIX paths', () => {
    const root = tree({
      'z/last.test.ts': MARKED,
      'a/deep/er/first.test.ts': MARKED,
      'a/unmarked.test.ts': 'export {}\n',
    })
    expect(discoverMarked(root)).toEqual(['a/deep/er/first.test.ts', 'z/last.test.ts'])
  })
  test('ignores marked files that are not tests', () => {
    expect(discoverMarked(tree({ 'a/helper.ts': MARKED, 'a/x.spec.ts': MARKED }))).toEqual([])
  })
  test('does not descend into dependency or build trees', () => {
    const root = tree({
      'node_modules/pkg/x.test.ts': MARKED,
      'apps/android/build/y.test.ts': MARKED,
      'real.test.ts': MARKED,
    })
    expect(discoverMarked(root)).toEqual(['real.test.ts'])
  })
})

describe('repoTestPaths', () => {
  test('leads with the directory roots and does not repeat a file already under one', () => {
    const root = tree({
      [`${DIRECTORY_ROOTS[0]}inside.test.ts`]: MARKED,
      'scripts/outside.test.ts': MARKED,
    })
    expect(repoTestPaths(root)).toEqual([...DIRECTORY_ROOTS, 'scripts/outside.test.ts'])
  })
})

describe('the real repository', () => {
  test('discovery finds this very file, so a regression cannot empty the tier unnoticed', () => {
    expect(discoverMarked(join(import.meta.dir, '..'))).toContain('scripts/test-repo.test.ts')
  })
})
