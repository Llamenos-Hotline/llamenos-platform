import { readFileSync } from 'node:fs'

/**
 * The stdout of a kimi review that READ its brief, for tests that mock the
 * `kimi` process.
 *
 * `runKimiOnce` verifies from the engine's own transcript that the whole brief
 * was returned to the model (#2726, `brief-coverage.ts`), so a mock that
 * emits a bare verdict models a reviewer that never opened the file — which
 * the gate now refuses, correctly. A faithful mock does what the real engine
 * does: the prompt is `-p @<file>`, the model `Read`s that file, then answers.
 *
 * Call it from the mock while the brief still exists (`runKimiOnce` deletes
 * it in a `finally`). It reads the file named by the `-p @<path>` argv.
 */
export function kimiTranscript(argv: readonly string[], finalText: string): string {
  const ref = argv[argv.indexOf('-p') + 1]
  if (ref === undefined || !ref.startsWith('@')) throw new Error(`kimiTranscript: no "-p @<file>" in argv: ${argv.join(' ')}`)
  const path = ref.slice(1)
  const lines = readFileSync(path, 'utf8').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return [
    { role: 'meta', type: 'system.version', version: '2.1.1' },
    { role: 'assistant', tool_calls: [{ type: 'function', id: 'tool_brief', function: { name: 'Read', arguments: JSON.stringify({ path, max_chars: 10_000_000 }) } }] },
    { role: 'tool', tool_call_id: 'tool_brief', content: lines.map((l, i) => `${i + 1}\t${l}`).join('\n') },
    { role: 'assistant', content: finalText },
  ].map((e) => JSON.stringify(e)).join('\n')
}
