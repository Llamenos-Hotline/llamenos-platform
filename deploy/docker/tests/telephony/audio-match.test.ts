/**
 * The instrument asterisk-call.e2e.ts uses to prove what a caller heard: it
 * must find a clip that was played, through a phone codec, and must NOT find
 * one that was not — or a green run would prove nothing.
 */
import { describe, expect, it } from 'vitest'
import { findClip } from './audio-match'

/** A noise-like "utterance": deterministic, speech-band, with a syllable-rate envelope */
function utterance(seed: number, seconds: number): Int16Array {
  let state = seed
  const random = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
  let lowpassed = 0
  return Int16Array.from({ length: Math.round(8000 * seconds) }, (_, i) => {
    lowpassed = 0.6 * lowpassed + 0.4 * random()
    const syllables = 0.5 + 0.5 * Math.sin((2 * Math.PI * 4 * i) / 8000)
    return Math.round(12000 * lowpassed * syllables)
  })
}

/** G.711 µ-law round trip: what the call path does to every sample */
function mulaw(samples: Int16Array): Int16Array {
  return Int16Array.from(samples, (s) => {
    const sign = s < 0 ? -1 : 1
    const magnitude = Math.min(Math.abs(s), 32635) / 32768
    const encoded = Math.log(1 + 255 * magnitude) / Math.log(256)
    const quantised = Math.round(encoded * 127) / 127
    return Math.round(sign * ((Math.pow(256, quantised) - 1) / 255) * 32768)
  })
}

function callRecording(parts: Array<Int16Array | number>): Int16Array {
  const chunks = parts.map((p) => (typeof p === 'number' ? new Int16Array(Math.round(8000 * p)) : p))
  const out = new Int16Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.length }
  return mulaw(out)
}

describe('findClip', () => {
  const greeting = utterance(1, 2.5)
  const hold = utterance(2, 3)
  const other = utterance(3, 2.5)

  it('finds each clip that was played, where it was played, through µ-law', () => {
    const recording = callRecording([0.7, greeting, 0.3, hold, 1.2])
    const g = findClip(recording, greeting)!
    const h = findClip(recording, hold)!
    expect(g.score).toBeGreaterThan(0.95)
    expect(h.score).toBeGreaterThan(0.95)
    expect(g.at).toBeCloseTo(0.7, 2)
    expect(h.at).toBeCloseTo(0.7 + 2.5 + 0.3, 2)
  })

  it('does not find a clip that was not played, in speech or in silence', () => {
    expect(findClip(callRecording([0.7, greeting, 0.3, hold, 1.2]), other)!.score).toBeLessThan(0.3)
    expect(findClip(callRecording([6]), greeting)!.score).toBeLessThan(0.3)
  })

  it('finds the last prompt of a call that hung up as it ended, its final packets unrecorded', () => {
    const recording = callRecording([0.4, greeting, hold]).subarray(0, Math.round(8000 * (0.4 + 2.5 + 3 - 0.04)))
    const h = findClip(recording, hold)!
    expect(h.score).toBeGreaterThan(0.95)
    expect(h.at).toBeCloseTo(0.4 + 2.5, 2)
    // …but a clip mostly cut off is not "heard".
    expect(findClip(recording.subarray(0, Math.round(8000 * 4)), hold)!.score).toBeLessThan(0.5)
  })

  it('has nothing to find in a recording shorter than the clip', () => {
    expect(findClip(new Int16Array(100), greeting)).toBeNull()
  })
})
