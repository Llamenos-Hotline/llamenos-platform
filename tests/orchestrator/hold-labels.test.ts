import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  AGENT_PROPOSED_LABEL, BLOCKED_LABEL, DISPATCH_LABEL, HOLD_LABELS, NEEDS_HUMAN_LABEL, VETO_LABELS,
  holdsOn, isContradicted,
} from '../../orchestrator/src/hold-labels.js'
import { LANES } from '../../orchestrator/src/config.js'
import { judge } from '../../orchestrator/src/select.js'
import type { WorkItem } from '../../orchestrator/src/source.js'

/**
 * #1815: `needs-human` used to mean both "an agent proposed this, say yes or
 * no" and "a person must act", and nothing told them apart. These tests pin
 * the split: each state has its own label, each label says what it asks,
 * each label vetoes, and no fleet code path can move an issue from one state
 * to the other as a side effect of a label edit.
 */

const SRC = join(import.meta.dirname, '..', '..', 'orchestrator', 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sourceFiles(p)
    return name.endsWith('.ts') ? [p] : []
  })
}

/** Strips comments so a doc comment naming a label never satisfies, or
 *  trips, a check meant for code. Not a parser — enough for this tree, whose
 *  string literals do not contain comment markers next to label writes. */
function code(p: string): string {
  return readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Every label-write call in the source, as the text from the call to its
 *  closing paren (multi-line calls included — a line-scoped matcher misses
 *  them). */
function labelWrites(src: string): string[] {
  const out: string[] = []
  const re = /(--add-label|--remove-label|addLabel\(|removeLabel\(|labelIssue\(|add-labels|\/labels)/g
  for (let m = re.exec(src); m !== null; m = re.exec(src)) out.push(src.slice(m.index, m.index + 160))
  return out
}

const item = (labels: string[]): WorkItem => ({ id: '1', title: 't', body: 'x'.repeat(250), url: 'u', labels })

describe('hold labels (#1815)', () => {
  it('give each state its own label', () => {
    expect(AGENT_PROPOSED_LABEL).not.toBe(NEEDS_HUMAN_LABEL)
    expect(new Set(VETO_LABELS).size).toBe(VETO_LABELS.length)
    expect(VETO_LABELS).toEqual(expect.arrayContaining([AGENT_PROPOSED_LABEL, NEEDS_HUMAN_LABEL, BLOCKED_LABEL]))
    expect(VETO_LABELS).not.toContain(DISPATCH_LABEL)
  })

  it('each says what it asks, short enough to be its GitHub label description', () => {
    for (const h of HOLD_LABELS) {
      expect(h.asks.length, h.name).toBeGreaterThan(0)
      expect(h.asks.length, `${h.name}: GitHub caps descriptions at 100 chars`).toBeLessThanOrEqual(100)
    }
    // A proposal is answerable: the description names both answers.
    const proposed = HOLD_LABELS.find((h) => h.name === AGENT_PROPOSED_LABEL)?.asks ?? ''
    expect(proposed).toContain(DISPATCH_LABEL)
    expect(proposed).toMatch(/close/i)
    // `blocked` asks nobody to act — it is not a synonym for needs-human.
    expect(HOLD_LABELS.find((h) => h.name === BLOCKED_LABEL)?.asks).toMatch(/nobody needs to act/i)
  })

  it('each vetoes in every dispatch lane, even alongside agent-dispatchable', () => {
    for (const lane of LANES) {
      for (const hold of VETO_LABELS) {
        const labels = [DISPATCH_LABEL, `lane:${lane.id}`, hold]
        expect(judge(item(labels), labels, lane), `${lane.id} / ${hold}`).toEqual({ ok: false, reason: 'vetoed' })
      }
    }
  })

  it('#3029 regression: removing agent-dispatchable leaves an issue held by nothing a human must do', () => {
    // The labels #3029 carried, minus agent-dispatchable. No hold appears from
    // the removal: holdsOn is a pure read of what is there.
    const before = [DISPATCH_LABEL, 'lane:desktop', 'bug']
    const after = before.filter((l) => l !== DISPATCH_LABEL)
    expect(holdsOn(before)).toEqual([])
    expect(holdsOn(after)).toEqual([])
    expect(isContradicted(after)).toBe(false)
    // It is merely unclaimable (no require label) — not human-gated.
    for (const lane of LANES) expect(judge(item(after), after, lane)).toEqual({ ok: false, reason: 'missing-require-label' })
  })

  it('#2925 shape: dispatchable AND held is reported as a contradiction', () => {
    expect(isContradicted([DISPATCH_LABEL, NEEDS_HUMAN_LABEL])).toBe(true)
    expect(isContradicted([DISPATCH_LABEL, AGENT_PROPOSED_LABEL])).toBe(true)
    expect(isContradicted([DISPATCH_LABEL])).toBe(false)
    expect(isContradicted([NEEDS_HUMAN_LABEL])).toBe(false)
  })
})

describe('no fleet code path moves an issue between states (#1815)', () => {
  const files = sourceFiles(SRC)
  const writesIn = files.map((p) => ({ file: relative(SRC, p), writes: labelWrites(code(p)) }))

  it('the scan sees the label writes it is meant to police', () => {
    // A tripwire that matches nothing proves nothing.
    expect(writesIn.find((w) => w.file === 'worktree.ts')?.writes.length).toBeGreaterThan(0)
    expect(writesIn.find((w) => w.file === 'sink.ts')?.writes.length).toBeGreaterThan(0)
  })

  it('never writes agent-dispatchable — adding it IS dispatching, and only a human may', () => {
    for (const { file, writes } of writesIn) {
      for (const w of writes) {
        expect(w, file).not.toContain('DISPATCH_LABEL')
        expect(w, file).not.toContain('agent-dispatchable')
        expect(w, file).not.toContain('requireLabel')
      }
    }
  })

  it('never removes agent-proposed — an agent must not clear its own proposal', () => {
    for (const { file, writes } of writesIn) {
      for (const w of writes) {
        expect(w, file).not.toContain('AGENT_PROPOSED_LABEL')
        expect(w, file).not.toContain('agent-proposed')
      }
    }
  })

  it('writes needs-human only from settle(), whose input is the act a person must take', () => {
    const writers = writesIn
      .filter(({ writes }) => writes.some((w) => w.includes('NEEDS_HUMAN_LABEL') || w.includes('needs-human')))
      .map((w) => w.file)
    expect(writers).toEqual(['worktree.ts'])
    // And the literal lives in exactly one place, so no other module can
    // spell it into an argv the scan above does not recognise.
    const literal = files.filter((p) => /['"`]needs-human['"`]/.test(code(p))).map((p) => relative(SRC, p))
    expect(literal).toEqual(['hold-labels.ts'])
  })
})
