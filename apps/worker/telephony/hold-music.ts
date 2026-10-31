/**
 * The hold track every telephony adapter plays to a queued caller, served from
 * the app's own origin (#2298).
 *
 * It used to be a file in Twilio's S3 bucket, fetched by five adapters — three
 * problems in one URL: a third party saw every call go on hold, hold music
 * depended on a bucket we do not control, and it contradicted the posture that
 * providers hold nothing. Now there is no file at all: the track is synthesised
 * from the constants below, so a fresh checkout has working hold music with no
 * configuration, no account, no asset to license, and nothing in the repo that
 * grows the clone or perturbs the reproducible-build checksums.
 *
 * Deterministic: a pure function of this file — no clock, no RNG, no I/O. Every
 * build of the same source plays the same bytes.
 *
 * Served by `GET /api/ivr-audio/hold-music.wav` (routes/ivr-media.ts), unsigned:
 * it is the same public track for every call, so the URL names nothing a
 * caller, hub or call could be probed for.
 */
import { writePcm16Wav } from '../services/ivr-speech/audio'
import { IVR_AUDIO_FORMAT } from '../lib/helpers'
import type { AudioUrlMap } from './adapter'

/** Reserved key in the AudioUrlMap: a prompt key is `promptType:language`, so this can never be one */
export const HOLD_MUSIC_AUDIO_KEY = 'holdMusic'

/**
 * The path the IVR media router registers, relative to the `/api` mount. The
 * router spells it as a literal, because the API route-table guard
 * (scripts/api-schema-binding) reads only literal paths; hold-music.test.ts
 * fetches HOLD_MUSIC_PATH through that router, so the two cannot drift.
 */
export const HOLD_MUSIC_ROUTE = '/ivr-audio/hold-music.wav'

/** Where a provider fetches the track from */
export const HOLD_MUSIC_PATH = `/api${HOLD_MUSIC_ROUTE}`

/** The AudioUrlMap entry for the hold track on the origin a provider reached us on */
export function holdMusicEntry(origin: string): AudioUrlMap {
  return { [HOLD_MUSIC_AUDIO_KEY]: `${origin}${HOLD_MUSIC_PATH}` }
}

/** The hold track URL for this call, or undefined when the caller built the map without it */
export function holdMusicUrl(audioUrls: AudioUrlMap | undefined): string | undefined {
  return audioUrls?.[HOLD_MUSIC_AUDIO_KEY]
}

// --- The tune: four slow seventh chords arpeggiated over a soft bass ---------

const BEATS_PER_CHORD = 4
const SECONDS_PER_BEAT = 1
/** MIDI note numbers, root-position voicings: Cmaj7 – Am7 – Fmaj7 – G6 */
const CHORDS: ReadonlyArray<{ bass: number; tones: readonly [number, number, number, number] }> = [
  { bass: 36, tones: [60, 64, 67, 71] },
  { bass: 33, tones: [57, 60, 64, 67] },
  { bass: 29, tones: [53, 57, 60, 64] },
  { bass: 31, tones: [55, 59, 62, 64] },
]
/** Which chord tone each half-beat plays */
const ARPEGGIO = [0, 1, 2, 3, 2, 1, 2, 1] as const

const NOTE_SECONDS = 2.4
/** Quiet enough to sit under the wait message, loud enough to be heard on a handset */
const PEAK = 0.3

const midiToHz = (midi: number) => 440 * 2 ** ((midi - 69) / 12)

/** Seconds in one pass of the tune; the WAV loops seamlessly at this length */
export const HOLD_MUSIC_SECONDS = CHORDS.length * BEATS_PER_CHORD * SECONDS_PER_BEAT

function synthesise(): Int16Array {
  const rate = IVR_AUDIO_FORMAT.sampleRate
  const total = HOLD_MUSIC_SECONDS * rate
  const mix = new Float64Array(total)

  /** Add a decaying tone starting at `startSample`; its tail wraps to the start so the loop has no seam */
  const note = (hz: number, startSample: number, amplitude: number, seconds: number) => {
    const length = Math.floor(seconds * rate)
    for (let i = 0; i < length; i++) {
      const t = i / rate
      const attack = Math.min(1, t / 0.02)
      const decay = Math.exp(-t * 2.2)
      const tail = Math.min(1, (length - i) / (0.05 * rate))
      const phase = 2 * Math.PI * hz * t
      const voice = Math.sin(phase) + 0.25 * Math.sin(2 * phase) + 0.08 * Math.sin(3 * phase)
      mix[(startSample + i) % total] += amplitude * attack * decay * tail * voice
    }
  }

  CHORDS.forEach((chord, index) => {
    const chordStart = index * BEATS_PER_CHORD * SECONDS_PER_BEAT * rate
    note(midiToHz(chord.bass), chordStart, 0.5, BEATS_PER_CHORD * SECONDS_PER_BEAT + 1)
    ARPEGGIO.forEach((tone, step) => {
      const start = chordStart + Math.round((step * SECONDS_PER_BEAT * rate) / 2)
      note(midiToHz(chord.tones[tone]), start, 0.45, NOTE_SECONDS)
    })
  })

  let peak = 0
  for (const v of mix) peak = Math.max(peak, Math.abs(v))
  const gain = (PEAK * 32767) / peak
  return Int16Array.from(mix, (v) => Math.round(v * gain))
}

let cached: Uint8Array<ArrayBuffer> | undefined

/** The hold track as a canonical 8 kHz mono 16-bit PCM WAV — the format every adapter's provider plays */
export function holdMusicWav(): Uint8Array<ArrayBuffer> {
  cached ??= writePcm16Wav({ sampleRate: IVR_AUDIO_FORMAT.sampleRate, samples: synthesise() })
  return cached
}
