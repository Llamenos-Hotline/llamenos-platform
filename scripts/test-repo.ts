// @suite: repo
/**
 * Runner for `bun run test:repo` — the repo-level bun test tier (#2730).
 *
 * It used to be one `bun test <path> <path> ...` line in package.json, so every
 * PR that added a repo test appended to that same line and conflicted with every
 * other such PR — a semantically empty conflict, resolved by hand, costing a
 * merge-queue group build each time.
 *
 * Nothing is enumerated in a shared file any more. A test joins the tier by
 * carrying this marker as a line comment in its first {@link HEAD_LINES} lines:
 *
 *     // @suite: repo
 *
 * so adding a test touches only the new file. DIRECTORY_ROOTS holds the few
 * directories whose every test belongs to the tier; a new test inside one needs
 * no marker. That list changes when a directory is added, not when a test is.
 *
 *   bun scripts/test-repo.ts [bun test flags...]
 *
 * The file list is printed before bun runs, and an empty list exits non-zero:
 * `bun test` exits 0 when its path arguments match nothing, which would turn a
 * discovery bug into a green job that measured nothing.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** Directories whose every `*.test.ts` is part of the tier (trailing slash: bun filters by path substring). */
export const DIRECTORY_ROOTS: readonly string[] = [
  'packages/shared/__tests__/',
  'packages/test-specs/tools/',
  'tests/eslint/',
]

export const MARKER = /^\s*\/\/\s*@suite:\s*repo\s*$/
export const HEAD_LINES = 30

/** Trees never worth walking: dependencies, VCS state and platform build output. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'target', 'dist', 'build', '.gradle', 'Pods', 'DerivedData',
  '.codegraph', '.claude', 'generated', 'test-results', 'playwright-report',
])

export function hasMarker(source: string): boolean {
  return source.split('\n', HEAD_LINES).some((line) => MARKER.test(line))
}

/** Every `*.test.ts` under `root` (POSIX-style relative paths, sorted) carrying the marker. */
export function discoverMarked(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name))
      } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
        const path = join(dir, entry.name)
        if (hasMarker(readFileSync(path, 'utf8'))) found.push(relative(root, path).split(sep).join('/'))
      }
    }
  }
  walk(root)
  return found.sort()
}

/** The bun test path arguments for the tier: directory roots, then marked files not already under one. */
export function repoTestPaths(root: string): string[] {
  const marked = discoverMarked(root).filter((file) => !DIRECTORY_ROOTS.some((dir) => file.startsWith(dir)))
  return [...DIRECTORY_ROOTS, ...marked]
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..')
  const paths = repoTestPaths(root)
  if (paths.length === DIRECTORY_ROOTS.length) {
    console.error('test:repo: discovered no `// @suite: repo` test files — discovery is broken, refusing to run an empty tier.')
    process.exit(1)
  }
  console.log(`test:repo: ${paths.length} path(s):\n${paths.map((p) => `  ${p}`).join('\n')}`)
  const proc = Bun.spawn(['bun', 'test', ...process.argv.slice(2), ...paths], {
    cwd: root,
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  process.exit(await proc.exited)
}
