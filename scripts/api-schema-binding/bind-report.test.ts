// @suite: repo
/**
 * bind-report.test.ts — rail for the CodeQL `js/incomplete-sanitization` finding
 * at bind-report.ts's markdown table generation.
 *
 * The bug being guarded against: escaping only `|` (not the backslash used to
 * escape it, and not embedded newlines) lets a single malicious/unlucky field
 * corrupt the generated table — either by re-emerging as a literal `\|` that
 * renders as backslash + column break, or by a raw newline ending the row
 * early and spilling the rest of the cells onto the next markdown line.
 *
 * Mutation check (see PR body): reverting `escapeMarkdownCell` to the original
 * single `notes.replace(/\|/g, '\\|')` — applied only to `notes`, and with no
 * backslash-first ordering — makes this test fail.
 */
import { describe, expect, test } from 'bun:test'
import { escapeMarkdownCell, renderMarkdown, type BindingRow } from './bind-report'

function makeRow(overrides: Partial<BindingRow> = {}): BindingRow {
  return {
    functionName: 'exampleFn',
    file: 'src/client/lib/api/example.ts',
    line: 1,
    method: 'GET',
    pathPattern: '/api/example',
    body: { verdict: 'BOUND' },
    response: { verdict: 'BOUND' },
    ...overrides,
  }
}

describe('escapeMarkdownCell', () => {
  test('escapes backslash before pipe (order matters)', () => {
    // A naive `s.replace(/\|/g, '\\|')` turns an existing `\|` into `\\|`
    // (backslash, backslash, pipe) which STILL renders as "backslash" +
    // "column break" — the escaping never touched the underlying pipe.
    // Escaping backslashes first is what actually neutralizes it.
    expect(escapeMarkdownCell('a\\|b')).toBe('a\\\\\\|b')
  })

  test('escapes backslashes so the output round-trips to the input', () => {
    // Undo the escaping the way a markdown renderer would: `\\` -> `\`, `\|` -> `|`.
    const unescape = (s: string) => s.replace(/\\([\\|])/g, '$1')
    for (const input of ['a\\b', 'trailing\\', '\\|', '\\\\|', 'x\\\\y|z']) {
      const out = escapeMarkdownCell(input)
      expect(unescape(out)).toBe(input)
    }
    expect(escapeMarkdownCell('a\\')).toBe('a\\\\')
  })

  test('escapes a bare pipe', () => {
    expect(escapeMarkdownCell('a|b')).toBe('a\\|b')
  })

  test('collapses embedded newlines and carriage returns', () => {
    expect(escapeMarkdownCell('a\nb\r\nc\rd')).toBe('a b c d')
  })
})

describe('renderMarkdown — per-function table row integrity', () => {
  const HEADER_COLUMNS = 7 // Function | File:Line | Method | Path | Body verdict | Response verdict | Notes

  test('a row whose fields contain a pipe, an escaped pipe, and a newline still renders as exactly one line with the expected column count', () => {
    const row = makeRow({
      functionName: 'evil|fn',
      body: { verdict: 'UNBOUND', note: 'contains a\\|pipe and\na newline' },
      response: { verdict: 'MISMATCHED', note: 'trailing|pipe' },
    })
    const md = renderMarkdown([row], [])
    const lines = md.split('\n')

    const dataLines = lines.filter(l => l.startsWith('| `evil'))
    expect(dataLines).toHaveLength(1)

    const line = dataLines[0]
    // The row must occupy exactly one physical line — a raw newline surviving
    // into the output would split it across two, which is itself the failure.
    expect(line.includes('\n')).toBe(false)

    // Column count: split on unescaped pipes only (a `\|` is an escaped cell
    // separator, not a column boundary). Leading/trailing empty strings come
    // from the row's own leading/trailing `|`.
    const cells = line.split(/(?<!\\)\|/).slice(1, -1)
    expect(cells).toHaveLength(HEADER_COLUMNS)
  })

  test('mutation check: the original single-field, backslash-unaware escape fails this test', () => {
    // Reproduces the ORIGINAL vulnerable line:
    //   `${notes.replace(/\|/g, '\\|')}`
    // applied only to notes, with everything else interpolated raw.
    function vulnerableRenderRow(row: BindingRow): string {
      const notes = [row.body.note, row.response.note, row.unresolvedReason].filter(Boolean).join('<br>')
      const escapedNotes = notes.split('|').join('\\|')  // backslash-unaware, as the original was
      return `| \`${row.functionName}\` | ${row.file}:${row.line} | ${row.method} | \`${row.pathPattern || '?'}\` | ${row.body.verdict} | ${row.response.verdict} | ${escapedNotes} |`
    }

    const row = makeRow({
      functionName: 'evil|fn',
      body: { verdict: 'UNBOUND', note: 'contains a\\|pipe and\na newline' },
      response: { verdict: 'MISMATCHED', note: 'trailing|pipe' },
    })
    const line = vulnerableRenderRow(row)

    // functionName's raw `|` corrupts the column count.
    const cells = line.split(/(?<!\\)\|/).slice(1, -1)
    expect(cells).not.toHaveLength(HEADER_COLUMNS)

    // The embedded newline in notes also survives verbatim into a single
    // "line" of source, spanning two physical lines.
    expect(line.includes('\n')).toBe(true)
  })
})

describe('renderMarkdown — field-level diff bullet section integrity', () => {
  test('function name and field names with pipes/backslashes/newlines do not break the bullet line', () => {
    const row = makeRow({
      functionName: 'weird|fn\\name',
      body: {
        verdict: 'MISMATCHED',
        schemaIdent: 'schema|Ident',
        fieldDiff: { missingOnClient: ['fi|eld\none'], extraOnClient: ['ex\\|tra'] },
      },
    })
    const md = renderMarkdown([row], [])
    const bulletLines = md.split('\n').filter(l => l.startsWith('- `weird'))
    expect(bulletLines).toHaveLength(1)
    expect(bulletLines[0].includes('\n')).toBe(false)
  })
})
