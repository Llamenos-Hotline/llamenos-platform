/**
 * Where, if anywhere, a clip was heard in a call recording: normalised
 * cross-correlation of the clip against the recording. G.711 and the RTP path
 * change the samples' precision, not their shape, so a clip the caller heard
 * correlates near 1 and anything else — other speech, hold music, silence —
 * far below.
 *
 * A coarse search over 10 ms loudness envelopes finds the candidate position;
 * the exact sample alignment is then searched around it.
 *
 * A call that ends as its last prompt does loses the final packets in flight
 * from the recording, so a clip may run up to TAIL_SLACK past its end.
 */
const FRAME = 80 // 10 ms at 8 kHz
const TAIL_SLACK = 2000 // 250 ms at 8 kHz

function envelope(samples: Int16Array): Float64Array {
  const frames = Math.floor(samples.length / FRAME)
  const out = new Float64Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) sum += samples[i] * samples[i]
    out[f] = Math.sqrt(sum / FRAME)
  }
  return out
}

/** Pearson correlation of `clip` against `signal` starting at `offset`, over what overlaps */
function correlationAt(signal: ArrayLike<number>, clip: ArrayLike<number>, offset: number): number {
  const n = Math.min(clip.length, signal.length - offset)
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0
  for (let i = 0; i < n; i++) {
    const x = signal[offset + i]
    const y = clip[i]
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y
  }
  const cov = sxy - (sx * sy) / n
  const vx = sxx - (sx * sx) / n
  const vy = syy - (sy * sy) / n
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0
}

export interface ClipMatch {
  /** Where the clip starts in the recording, in seconds */
  at: number
  /** Normalised correlation of the samples there: 1 is identical up to gain */
  score: number
}

/** The best alignment of `clip` in `recording` (both 8 kHz), or null when the recording cannot hold it */
export function findClip(recording: Int16Array, clip: Int16Array, sampleRate = 8000): ClipMatch | null {
  const lastOffset = recording.length - clip.length + Math.min(TAIL_SLACK, Math.floor(clip.length / 4))
  if (clip.length === 0 || lastOffset < 0) return null
  const recEnv = envelope(recording)
  const clipEnv = envelope(clip)
  let bestFrame = 0
  let bestEnv = -Infinity
  for (let f = 0; f * FRAME <= lastOffset; f++) {
    const c = correlationAt(recEnv, clipEnv, f)
    if (c > bestEnv) { bestEnv = c; bestFrame = f }
  }
  let best: ClipMatch = { at: 0, score: -Infinity }
  const center = bestFrame * FRAME
  for (let offset = Math.max(0, center - 2 * FRAME); offset <= Math.min(lastOffset, center + 2 * FRAME); offset++) {
    const score = correlationAt(recording, clip, offset)
    if (score > best.score) best = { at: offset / sampleRate, score }
  }
  return best
}

/** The 8 kHz 16-bit samples of a PCM WAV (the data chunk, however the header is laid out) */
export function wavSamples(wav: Uint8Array): Int16Array {
  const ascii = (o: number) => String.fromCharCode(...wav.subarray(o, o + 4))
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  let offset = 12
  while (offset + 8 <= wav.byteLength) {
    const size = view.getUint32(offset + 4, true)
    if (ascii(offset) === 'data') {
      const end = Math.min(wav.byteLength, offset + 8 + size)
      const count = Math.floor((end - offset - 8) / 2)
      return Int16Array.from({ length: count }, (_, i) => view.getInt16(offset + 8 + i * 2, true))
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error('not a WAV: no data chunk')
}
