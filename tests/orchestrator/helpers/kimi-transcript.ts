import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * The diff-part files a mocked engine was granted (#2726): `invokeVerifierEngine`
 * writes the diff as parts into a private `llamenos-review-diff-*` directory and
 * grants it with `--add-dir`. A faithful mock reads every one, as the real
 * reviewer is required to — the gate measures exactly that from the transcript.
 */
export function grantedDiffParts(argv: readonly string[]): string[] {
  const dirs: string[] = []
  argv.forEach((a, i) => { if (a === '--add-dir' && argv[i + 1] !== undefined) dirs.push(argv[i + 1] as string) })
  const dir = dirs.find((d) => basename(d).startsWith('llamenos-review-diff-'))
  if (dir === undefined) return []
  return readdirSync(dir).filter((f) => f.endsWith('.diff')).sort().map((f) => join(dir, f))
}

function numbered(path: string): string {
  const lines = readFileSync(path, 'utf8').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map((l, i) => `${i + 1}\t${l}`).join('\n')
}

/**
 * The stdout of a kimi review that READ its brief and every diff part, for
 * tests that mock the `kimi` process.
 *
 * `runKimiOnce` verifies from the engine's own transcript that the whole brief
 * (#2726, `brief-coverage.ts`) and every line of every diff part
 * (`review-diff.ts`) were returned to the model, so a mock that emits a bare
 * verdict models a reviewer that never opened them — which the gate refuses,
 * correctly. A faithful mock does what the real engine does: the prompt is
 * `-p @<file>`, the model `Read`s that file and each part, then answers.
 *
 * Call it from the mock while the files still exist (both are deleted in a
 * `finally` once the run returns).
 */
export function kimiTranscript(argv: readonly string[], finalText: string): string {
  const ref = argv[argv.indexOf('-p') + 1]
  if (ref === undefined || !ref.startsWith('@')) throw new Error(`kimiTranscript: no "-p @<file>" in argv: ${argv.join(' ')}`)
  const reads = [ref.slice(1), ...grantedDiffParts(argv)]
  return [
    { role: 'meta', type: 'system.version', version: '2.1.1' },
    ...reads.flatMap((path, i) => [
      { role: 'assistant', tool_calls: [{ type: 'function', id: `tool_${i}`, function: { name: 'Read', arguments: JSON.stringify({ path, max_chars: 10_000_000 }) } }] },
      { role: 'tool', tool_call_id: `tool_${i}`, content: numbered(path) },
    ]),
    { role: 'assistant', content: finalText },
  ].map((e) => JSON.stringify(e)).join('\n')
}

/**
 * The claude `--output-format stream-json` mirror of `kimiTranscript`: a
 * `Read` of every granted diff part (the brief arrives on stdin, so there is
 * no brief file to read), then a `result` event carrying `finalText`. The
 * envelope is the one the installed binary emits (`tool_use` in an assistant
 * message, `tool_result` with `<n>\t<line>` content in a user message).
 */
export function claudeTranscript(argv: readonly string[], finalText: string): string {
  const parts = grantedDiffParts(argv)
  return [
    ...parts.flatMap((path, i) => [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'Read', input: { file_path: path } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: numbered(path) }] } },
    ]),
    { type: 'result', subtype: 'success', num_turns: parts.length + 1, result: finalText },
  ].map((e) => JSON.stringify(e)).join('\n')
}
