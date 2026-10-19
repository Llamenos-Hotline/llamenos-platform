/**
 * text-lex.ts — a small, string-aware lexer for Swift and Kotlin source.
 *
 * The mobile call-site parser cannot use a regex per line: `request(` calls
 * span several lines, the path is often assigned to a `val path = …` a few
 * lines earlier, and string literals nest (`"…${a("x")}…"`, `"…\(f("x"))…"`).
 * Everything here works on the *masked* source (comments blanked out, offsets
 * preserved) so that a `/api/…` inside a doc comment never counts as a call.
 */

export type Lang = 'swift' | 'kotlin'

export type StringPart = { lit: string } | { expr: string; exprStart: number }

export interface StringLiteral {
  start: number
  /** Offset just past the closing quote. */
  end: number
  parts: StringPart[]
}

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' }

function isIdentStart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z_]/.test(ch)
}
function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch)
}

/**
 * Parse the string literal starting at `src[i]` (which must be `"`).
 * Handles escapes, `"""` multi-line strings and nested interpolation.
 */
export function parseStringLiteral(src: string, i: number, lang: Lang): StringLiteral {
  const start = i
  const triple = src.startsWith('"""', i)
  i += triple ? 3 : 1
  const parts: StringPart[] = []
  let lit = ''
  const flush = () => {
    if (lit) parts.push({ lit })
    lit = ''
  }
  while (i < src.length) {
    const ch = src[i]
    if (triple ? src.startsWith('"""', i) : ch === '"') {
      i += triple ? 3 : 1
      flush()
      return { start, end: i, parts }
    }
    if (ch === '\\') {
      if (lang === 'swift' && src[i + 1] === '(') {
        const close = findClose(src, i + 1, lang)
        flush()
        parts.push({ expr: src.slice(i + 2, close), exprStart: i + 2 })
        i = close + 1
        continue
      }
      const next = src[i + 1] ?? ''
      lit += next === 'n' ? '\n' : next === 't' ? '\t' : next
      i += 2
      continue
    }
    if (lang === 'kotlin' && ch === '$') {
      if (src[i + 1] === '{') {
        const close = findClose(src, i + 1, lang)
        flush()
        parts.push({ expr: src.slice(i + 2, close), exprStart: i + 2 })
        i = close + 1
        continue
      }
      if (isIdentStart(src[i + 1])) {
        let j = i + 1
        while (isIdentChar(src[j])) j++
        flush()
        parts.push({ expr: src.slice(i + 1, j), exprStart: i + 1 })
        i = j
        continue
      }
    }
    lit += ch
    i++
  }
  throw new Error(`unterminated string literal at offset ${start}`)
}

/** Offset of the bracket matching the opener at `src[open]`, skipping strings. */
export function findClose(src: string, open: number, lang: Lang): number {
  const stack: string[] = []
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === '"') {
      i = parseStringLiteral(src, i, lang).end - 1
      continue
    }
    if (lang === 'kotlin' && ch === "'") {
      const m = /^'(?:\\.[^']*|[^'\\])'/.exec(src.slice(i, i + 12))
      if (m) i += m[0].length - 1
      continue
    }
    if (OPENERS[ch]) stack.push(OPENERS[ch])
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.pop() !== ch) throw new Error(`unbalanced '${ch}' at offset ${i}`)
      if (stack.length === 0) return i
    }
  }
  throw new Error(`no closing bracket for offset ${open}`)
}

/**
 * Blank out comments, preserving every offset and newline. String-aware, so
 * `"http://x"` keeps its `//`. Nested block comments (Swift and Kotlin both
 * nest them) are handled.
 */
export function maskComments(src: string, lang: Lang): string {
  const out = src.split('')
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '
  }
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '"') {
      i = parseStringLiteral(src, i, lang).end
      continue
    }
    if (lang === 'kotlin' && ch === "'") {
      const m = /^'(?:\\.[^']*|[^'\\])'/.exec(src.slice(i, i + 12))
      i += m ? m[0].length : 1
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      let j = i
      while (j < src.length && src[j] !== '\n') j++
      blank(i, j)
      i = j
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      let depth = 1
      let j = i + 2
      while (j < src.length && depth > 0) {
        if (src[j] === '/' && src[j + 1] === '*') {
          depth++
          j += 2
        } else if (src[j] === '*' && src[j + 1] === '/') {
          depth--
          j += 2
        } else j++
      }
      blank(i, j)
      i = j
      continue
    }
    i++
  }
  return out.join('')
}

/**
 * Split `src[from, to)` on top-level occurrences of `sep` (a single char),
 * ignoring separators inside strings and nested brackets. Returns the
 * absolute `[start, end)` of every piece.
 */
export function splitTopLevel(src: string, from: number, to: number, sep: string, lang: Lang): [number, number][] {
  const pieces: [number, number][] = []
  let depth = 0
  let begin = from
  for (let i = from; i < to; i++) {
    const ch = src[i]
    if (ch === '"') {
      i = parseStringLiteral(src, i, lang).end - 1
      continue
    }
    if (OPENERS[ch]) depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === sep && depth === 0) {
      pieces.push([begin, i])
      begin = i + 1
    }
  }
  pieces.push([begin, to])
  return pieces
}

/**
 * Offsets of top-level occurrences of `needle` (a literal substring) within
 * `src[from, to)`, outside strings and brackets.
 */
export function findTopLevel(src: string, from: number, to: number, needle: string, lang: Lang): number[] {
  const hits: number[] = []
  let depth = 0
  for (let i = from; i < to; i++) {
    const ch = src[i]
    if (ch === '"') {
      i = parseStringLiteral(src, i, lang).end - 1
      continue
    }
    if (OPENERS[ch]) depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (depth === 0 && src.startsWith(needle, i)) hits.push(i)
  }
  return hits
}

export interface SourceText {
  /** Repo-relative path. */
  file: string
  lang: Lang
  /** Comments blanked, same offsets as the original. */
  text: string
  lineStarts: number[]
}

export function makeSource(file: string, lang: Lang, raw: string): SourceText {
  const lineStarts = [0]
  for (let i = 0; i < raw.length; i++) if (raw[i] === '\n') lineStarts.push(i + 1)
  return { file, lang, text: maskComments(raw, lang), lineStarts }
}

export function lineAt(source: SourceText, offset: number): number {
  let lo = 0
  let hi = source.lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (source.lineStarts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/**
 * Extent of the expression that starts at `from`: runs to the end of the
 * statement — a newline at bracket depth 0 that is not a continuation (the
 * line neither ends with, nor the next begins with, an operator).
 */
export function readExpression(src: string, from: number, lang: Lang): number {
  let depth = 0
  let i = from
  while (i < src.length) {
    const ch = src[i]
    if (ch === '"') {
      i = parseStringLiteral(src, i, lang).end
      continue
    }
    if (OPENERS[ch]) depth++
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return i
      depth--
    } else if (ch === ';' && depth === 0) return i
    else if (ch === '\n' && depth === 0) {
      const before = src.slice(from, i).trimEnd()
      const after = src.slice(i).trimStart()
      const continues =
        /[+?:&|,=]$/.test(before) ||
        /^(?:[+?:.]|&&|\|\||\belse\b|\?:|\?\?)/.test(after)
      if (!continues) return i
    }
    i++
  }
  return src.length
}

export { isIdentChar, isIdentStart }
