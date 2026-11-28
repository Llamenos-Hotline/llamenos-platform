#!/usr/bin/env bun
/**
 * check-amendment-pointers.ts — an amendment is recorded in BOTH directions (#3034).
 *
 * Why this rail exists
 * --------------------
 * A v2 spec that changes a signed-off decision of another spec says so in its
 * own text ("amends C11"). Without a pointer back, the amended spec still reads
 * as authoritative and signed off while stating a rule a different signed-off
 * document has changed — and nothing inside that file reveals it. Someone
 * building the connectors contract from the connectors spec would implement
 * one boundary per hub, having read a signed-off spec correctly, and be wrong.
 * A cross-file contradiction is invisible to a per-diff review, so the
 * invariant is checked mechanically instead.
 *
 * The rule
 * --------
 *   1. MARKER. An amending spec writes `amends <ID>` (or `amends #<pr> <ID>`)
 *      at each decision it changes: /\bamends (#\d+ )?([A-Z]{1,2}\d+)\b/.
 *   2. DEFINING SECTION. <ID> is defined by exactly one heading, in a v2 spec
 *      other than the amending one, of the form `## 4. X3: <title>` (the
 *      number is optional; `##` to `####`). Zero or several definitions is an
 *      error naming the files: decision ids repeat across older specs (the M1
 *      triage spec has its own D16), so only the v2 specs are scanned.
 *   3. POINTER. That section — up to the next heading of the same or higher
 *      level — holds a line carrying both `Amended by #<pr>` and
 *      `effective once`. A bare "see #X" fails on purpose: an amendment lands
 *      before it is live (C11's co-hosting needs the org membership BUILT), and
 *      a pointer without its condition would make the amended spec wrong in the
 *      other direction.
 *
 * Scope: docs/superpowers/specs/2026-11-2*-v2-*.md, plus the wire spec
 * (2026-11-24-encryption-v2-wire-format.md, which the same glob reaches).
 * Headings and markers inside fenced code blocks are ignored.
 *
 * Offline, Node built-ins only: no `bun install` needed in CI.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const SPECS_DIR = 'docs/superpowers/specs'
/** `2026-11-2*-v2-*.md`: the v2 specs, and the 2026-11-24 wire spec whose name carries `-v2-`. */
export const SPEC_FILE = /^2026-11-2.*-v2-.*\.md$/

const MARKER = /\bamends (?:#\d+ )?([A-Z]{1,2}\d+)\b/g
const POINTER = /Amended by #\d+\b.*\beffective once\b/
const HEADING = /^(#{1,6})\s+(.*)$/

export interface SpecFile {
  /** Repo-relative path, used in messages. */
  path: string
  text: string
}

export interface Problem {
  file: string
  line: number
  id: string
  message: string
}

interface Heading {
  line: number // 1-based
  level: number
  title: string
  /** 1-based, inclusive, last line of the section. */
  end: number
}

/** Lines that are real prose: `inFence[i]` is true for a fence line or a line inside a fenced block. */
function fenceMask(lines: string[]): boolean[] {
  const mask: boolean[] = []
  let open = false
  for (const l of lines) {
    const fence = /^\s*(```|~~~)/.test(l)
    mask.push(open || fence)
    if (fence) open = !open
  }
  return mask
}

function headingsOf(lines: string[]): Heading[] {
  const mask = fenceMask(lines)
  const found: Heading[] = []
  lines.forEach((l, i) => {
    const m = !mask[i] && HEADING.exec(l)
    if (m) found.push({ line: i + 1, level: m[1].length, title: m[2], end: lines.length })
  })
  found.forEach((h, i) => {
    const next = found.slice(i + 1).find((n) => n.level <= h.level)
    if (next) h.end = next.line - 1
  })
  return found
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function definesId(title: string, id: string): boolean {
  return new RegExp(`^(?:\\d+(?:\\.\\d+)*\\.?\\s+)?${escapeRe(id)}:`).test(title)
}

export function checkAmendmentPointers(files: SpecFile[]): Problem[] {
  const problems: Problem[] = []
  const parsed = files.map((f) => {
    const lines = f.text.split('\n')
    return { ...f, lines, mask: fenceMask(lines), headings: headingsOf(lines) }
  })

  for (const amender of parsed) {
    const reported = new Set<string>()
    amender.lines.forEach((text, i) => {
      if (amender.mask[i]) return
      for (const m of text.matchAll(MARKER)) {
        const id = m[1]
        if (reported.has(id)) continue
        reported.add(id)
        const at = { file: amender.path, line: i + 1, id }

        const defs = parsed
          .filter((p) => p !== amender)
          .flatMap((p) => p.headings.filter((h) => definesId(h.title, id)).map((h) => ({ spec: p, heading: h })))

        if (defs.length === 0) {
          problems.push({
            ...at,
            message: `${amender.path}:${i + 1} says "amends ${id}", but no other v2 spec has a heading defining ${id} (expected "## <n>. ${id}: <title>")`,
          })
          continue
        }
        if (defs.length > 1) {
          const where = defs.map((d) => `${d.spec.path}:${d.heading.line}`).join(' and ')
          problems.push({
            ...at,
            message: `${amender.path}:${i + 1} says "amends ${id}", but ${id} is defined more than once (${where}); an amendment must have one unambiguous target`,
          })
          continue
        }
        const { spec, heading } = defs[0]
        const section = spec.lines.slice(heading.line, heading.end)
        const hasPointer = section.some((l, j) => !spec.mask[heading.line + j] && POINTER.test(l))
        if (!hasPointer) {
          problems.push({
            ...at,
            message:
              `${amender.path}:${i + 1} amends ${id}, but its defining section (${spec.path}:${heading.line} "${heading.title}") ` +
              `has no pointer back. Add, under that heading: "**Amended by #<pr> (<section>), effective once <condition>.**"`,
          })
        }
      }
    })
  }
  return problems
}

export function loadSpecs(root: string): SpecFile[] {
  const dir = join(root, SPECS_DIR)
  return readdirSync(dir)
    .filter((n) => SPEC_FILE.test(n))
    .sort()
    .map((n) => ({ path: `${SPECS_DIR}/${n}`, text: readFileSync(join(dir, n), 'utf8') }))
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..')
  const specs = loadSpecs(root)
  if (specs.length === 0) {
    // A guard that scanned nothing proves nothing: the glob moved, or the specs did.
    console.error(`check-amendment-pointers: no spec matched ${SPEC_FILE} in ${SPECS_DIR}`)
    process.exit(2)
  }
  const problems = checkAmendmentPointers(specs)
  if (problems.length > 0) {
    console.error(`check-amendment-pointers: ${problems.length} amendment(s) without a pointer back (#3034):\n`)
    for (const p of problems) console.error(`  - ${p.message}`)
    process.exit(1)
  }
  console.log(`check-amendment-pointers: ${specs.length} v2 specs scanned, every "amends <ID>" has its pointer back.`)
}
