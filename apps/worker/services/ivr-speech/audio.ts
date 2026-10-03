/**
 * PCM plumbing for generated IVR speech: read what a speech engine writes,
 * bring it to the one format every provider plays (IVR_AUDIO_FORMAT — 8 kHz
 * mono 16-bit PCM WAV), and write that as a canonical 44-byte-header WAV.
 *
 * The engine's own WAV container is never passed through. espeak-ng writes to
 * a pipe at 22.05 kHz with placeholder chunk sizes it cannot seek back to fix;
 * Asterisk's format_wav refuses both the rate and a streaming-size header.
 */
import { IVR_AUDIO_FORMAT } from '../../lib/helpers'

export interface Pcm16 {
  sampleRate: number
  samples: Int16Array
}

const ascii = (bytes: Uint8Array, offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))

/**
 * Read mono 16-bit PCM from a WAV an engine wrote. A `data` chunk whose size
 * runs past the end of the input (a streaming header) is read to the end.
 */
export function readPcm16Wav(bytes: Uint8Array): Pcm16 {
  if (bytes.byteLength < 12 || ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WAVE') {
    throw new Error('Speech engine output is not a WAV file')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let sampleRate: number | null = null
  let offset = 12
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      const format = view.getUint16(body, true)
      const channels = view.getUint16(body + 2, true)
      const bitsPerSample = view.getUint16(body + 14, true)
      if (format !== 1 || channels !== 1 || bitsPerSample !== 16) {
        throw new Error(`Speech engine output is not mono 16-bit PCM (format ${format}, ${channels} ch, ${bitsPerSample} bit)`)
      }
      sampleRate = view.getUint32(body + 4, true)
    } else if (id === 'data') {
      if (sampleRate === null) throw new Error('Speech engine output has audio before its format chunk')
      const end = Math.min(bytes.byteLength, body + size)
      const count = Math.floor((end - body) / 2)
      const samples = new Int16Array(count)
      for (let i = 0; i < count; i++) samples[i] = view.getInt16(body + i * 2, true)
      return { sampleRate, samples }
    }
    offset = body + size + (size % 2)
  }
  throw new Error('Speech engine output has no audio data')
}

/** Zero crossings of the interpolation kernel on each side of a sample */
const KERNEL_ZERO_CROSSINGS = 16
/** Pass band as a fraction of the lower Nyquist rate — the rest is the filter's transition band */
const PASS_BAND = 0.9

function sinc(x: number): number {
  if (x === 0) return 1
  const px = Math.PI * x
  return Math.sin(px) / px
}

function blackman(x: number, halfWidth: number): number {
  const n = (x + halfWidth) / (2 * halfWidth)
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * n) + 0.08 * Math.cos(4 * Math.PI * n)
}

/**
 * Band-limited resampling (windowed-sinc interpolation). Downsampling low-passes
 * below the new Nyquist rate first, so speech sibilants above 4 kHz do not fold
 * back into the telephone band as hiss.
 */
export function resample(input: Pcm16, toRate: number): Pcm16 {
  const { sampleRate: fromRate, samples } = input
  if (fromRate === toRate) return { sampleRate: toRate, samples: samples.slice() }
  const step = fromRate / toRate
  const cutoff = Math.min(1, toRate / fromRate) * PASS_BAND
  const halfWidth = KERNEL_ZERO_CROSSINGS / cutoff
  const outLength = Math.floor(samples.length / step)
  const out = new Int16Array(outLength)
  for (let n = 0; n < outLength; n++) {
    const t = n * step
    const first = Math.max(0, Math.ceil(t - halfWidth))
    const last = Math.min(samples.length - 1, Math.floor(t + halfWidth))
    let sum = 0
    for (let k = first; k <= last; k++) {
      const x = t - k
      sum += samples[k] * cutoff * sinc(cutoff * x) * blackman(x, halfWidth)
    }
    out[n] = Math.max(-32768, Math.min(32767, Math.round(sum)))
  }
  return { sampleRate: toRate, samples: out }
}

/** Target peak after normalisation: loud on a phone line, with headroom for the codec */
const TARGET_PEAK = Math.round(32767 * 0.7)

/** Scale to a consistent peak level so every locale's prompts are equally loud */
export function normalizePeak(input: Pcm16): Pcm16 {
  let peak = 0
  for (const s of input.samples) peak = Math.max(peak, Math.abs(s))
  if (peak === 0) return input
  const gain = TARGET_PEAK / peak
  const samples = Int16Array.from(input.samples, (s) => Math.round(s * gain))
  return { sampleRate: input.sampleRate, samples }
}

/** A canonical PCM WAV: RIFF, a 16-byte fmt chunk, then data — nothing else */
export function writePcm16Wav(pcm: Pcm16): Uint8Array<ArrayBuffer> {
  const dataBytes = pcm.samples.length * 2
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i)
  }
  const channels = 1
  const bitsPerSample = 16
  const blockAlign = (channels * bitsPerSample) / 8
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, pcm.sampleRate, true)
  view.setUint32(28, pcm.sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < pcm.samples.length; i++) view.setInt16(44 + i * 2, pcm.samples[i], true)
  return bytes
}

/** Engine output → the 8 kHz mono 16-bit WAV that IVR prompts are served as */
export function toIvrWav(engineWav: Uint8Array): Uint8Array<ArrayBuffer> {
  const pcm = readPcm16Wav(engineWav)
  if (pcm.samples.length === 0) throw new Error('Speech engine produced no audio')
  return writePcm16Wav(normalizePeak(resample(pcm, IVR_AUDIO_FORMAT.sampleRate)))
}
