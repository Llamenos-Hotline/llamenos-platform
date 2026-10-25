import { describe, expect, it } from 'vitest'
import { callReadiness } from './call-readiness'

describe('callReadiness', () => {
  it.each([
    // [onShift (scheduled), clockedIn, onBreak, expected]
    [true, true, false, 'ready'],
    // #2108: scheduled but never clocked in must NOT read as ready — the server rings nobody.
    [true, false, false, 'not-clocked-in'],
    [false, true, false, 'unscheduled'],
    [false, false, false, 'off-shift'],
    // Break outranks everything: an on-break volunteer is never rung.
    [true, true, true, 'on-break'],
    [true, false, true, 'on-break'],
    [false, true, true, 'on-break'],
    [false, false, true, 'on-break'],
  ] as const)('onShift=%s clockedIn=%s onBreak=%s → %s', (onShift, clockedIn, onBreak, expected) => {
    expect(callReadiness({ onShift, clockedIn }, onBreak)).toBe(expected)
  })

  it('reports ready only for the single combination the server rings', () => {
    const ready = [true, false].flatMap(onShift =>
      [true, false].flatMap(clockedIn =>
        [true, false].map(onBreak => ({ onShift, clockedIn, onBreak })),
      ),
    ).filter(c => callReadiness(c, c.onBreak) === 'ready')
    expect(ready).toEqual([{ onShift: true, clockedIn: true, onBreak: false }])
  })
})
