// @suite: repo
/**
 * Structure rail for the protocol specification (#2388).
 *
 * `docs/protocol/PROTOCOL.md` is an index; the specification lives in one file
 * per domain beside it. The split exists so two unrelated protocol changes do
 * not edit the same file, and it only stays useful while three things hold:
 *
 *   - the index names every file in the set, and every file it names exists —
 *     an unlisted file is invisible to readers and to `check-ecies-active.sh`,
 *     which scans the set in index order;
 *   - every section heading sits in the file whose row in the index claims its
 *     number — 179 files elsewhere in the repo cite `PROTOCOL.md §N.N`, and the
 *     index is how a citation finds its section;
 *   - every relative link between the files resolves.
 *
 * Deliberately NOT asserted: that the index lists each section. A new section in
 * an existing domain edits that domain's file alone — that is the point.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const DIR = join(import.meta.dir, '..', 'docs', 'protocol')
const INDEX = join(DIR, 'PROTOCOL.md')
/** The deprecated v1 document: historical, deliberately outside the set. */
const SUPERSEDED = 'llamenos-protocol.md'

const toPosix = (p: string): string => p.split(sep).join('/')

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return markdownFiles(path)
    return name.endsWith('.md') ? [toPosix(relative(DIR, path))] : []
  })
}

interface IndexRow {
  /** Path relative to docs/protocol, POSIX separators. */
  file: string
  /** The raw "Sections" cell, e.g. `2, 2.1–2.2.1` or `Appendix A–C`. */
  sections: string
}

/** The index's table rows, in the order the index lists them. */
function indexRows(): IndexRow[] {
  const rows: IndexRow[] = []
  for (const line of readFileSync(INDEX, 'utf8').split('\n')) {
    const match = /^\|\s*([^|]+?)\s*\|\s*\[[^\]]+\]\(([^)]+\.md)\)\s*\|/.exec(line)
    if (match) rows.push({ sections: match[1], file: match[2] })
  }
  return rows
}

type Section = number[]

const parseSection = (text: string): Section => text.split('.').map(Number)

function compare(a: Section, b: Section): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? -1) - (b[i] ?? -1)
    if (diff !== 0) return diff
  }
  return 0
}

const startsWith = (section: Section, prefix: Section): boolean =>
  prefix.length <= section.length && prefix.every((n, i) => section[i] === n)

/**
 * Whether one token of a "Sections" cell covers `section`. A range `A–B` covers
 * from A through B, including B's subsections (`2.3–2.4` covers `2.4.1`). A bare
 * number covers its whole subtree (`5` covers `5.3`) when it is the entire cell,
 * and only itself when it sits beside other tokens: the cell `2, 2.1–2.2.1` is
 * the `## 2.` heading plus a range, not a claim on all of §2.
 */
function covers(token: string, section: Section, entireCell: boolean): boolean {
  const [from, to] = token.split('–')
  if (to === undefined) {
    const own = parseSection(from)
    return entireCell ? startsWith(section, own) : compare(section, own) === 0
  }
  const upper = parseSection(to)
  return compare(section, parseSection(from)) >= 0 && (compare(section, upper) <= 0 || startsWith(section, upper))
}

/** `## 4. REST API Endpoints` and `### 4.12 Settings` → `4` and `4.12`. */
const NUMBERED_HEADING = /^#{2,3} (\d+(?:\.\d+)*)[ .]/

describe('protocol specification set', () => {
  const rows = indexRows()
  const files = markdownFiles(DIR).filter((f) => f !== 'PROTOCOL.md' && f !== SUPERSEDED)

  test('the index lists a plausible number of files (an empty parse must not pass)', () => {
    expect(rows.length).toBeGreaterThanOrEqual(30)
  })

  test('every file the index names exists, and is named once', () => {
    const missing = rows.filter((r) => !existsSync(join(DIR, r.file))).map((r) => r.file)
    expect(missing).toEqual([])
    const names = rows.map((r) => r.file)
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([])
  })

  test('every specification file under docs/protocol is named by the index', () => {
    const listed = new Set(rows.map((r) => r.file))
    expect(files.filter((f) => !listed.has(f)).sort()).toEqual([])
  })

  test('every numbered heading sits in a file whose index row claims its number', () => {
    const unclaimed: string[] = []
    for (const row of rows) {
      const tokens = row.sections.split(',').map((t) => t.trim())
      for (const line of readFileSync(join(DIR, row.file), 'utf8').split('\n')) {
        const heading = NUMBERED_HEADING.exec(line)
        if (!heading) continue
        const section = parseSection(heading[1])
        if (!tokens.some((token) => covers(token, section, tokens.length === 1))) unclaimed.push(`${row.file}: ${line}`)
      }
    }
    expect(unclaimed).toEqual([])
  })

  test('every relative markdown link between the files resolves', () => {
    const broken: string[] = []
    for (const file of ['PROTOCOL.md', ...files]) {
      const text = readFileSync(join(DIR, file), 'utf8')
      for (const match of text.matchAll(/\]\((?!https?:|mailto:|#)([^)#\s]+)(#[^)\s]*)?\)/g)) {
        const target = resolve(dirname(join(DIR, file)), match[1])
        if (!existsSync(target)) broken.push(`${file} -> ${match[1]}`)
      }
    }
    expect(broken).toEqual([])
  })
})
