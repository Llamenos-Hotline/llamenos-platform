/**
 * Generated IVR speech for providers that cannot speak for themselves (#1347).
 *
 * Twilio, Telnyx, Plivo and the other cloud providers speak a prompt's text
 * with their own engines. The self-hosted PBXs have none, so for them the
 * adapter turns every spoken prompt into a `play` of a signed URL that names
 * the text and locale; when the PBX fetches it, the worker synthesises it
 * offline (espeak-ng), converts it to the 8 kHz PCM WAV every prompt is served
 * as, and caches it. An operator's upload is still looked up first and always
 * wins — generated speech only fills the gaps.
 *
 * The URL is content-addressed and needs no server-side state, so any worker
 * replica can serve it, a restart loses nothing, and a change to the prompt
 * text (or the engine) is a new URL — nothing goes stale in the PBX's media
 * cache. The signature restricts synthesis to text the worker itself chose;
 * without it this would be an open speech-synthesis endpoint.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { signIvrMediaPath, verifyIvrMediaPath } from '../../lib/ivr-media-url'
import type { SpeechUrlBuilder } from '../../telephony/adapter'
import { createLogger } from '../../lib/logger'
import { toIvrWav } from './audio'
import { EspeakNgEngine, type SpeechEngine } from './espeak'
import { ESPEAK_NG_VOICES, espeakVoiceFor } from './voices'

export { GENERATED_SPEECH_LOCALES, SPEECH_FALLBACK_LANGUAGE, speechLanguageFor } from './voices'
export type { SpeechEngine } from './espeak'

const logger = createLogger('ivr-speech')

export const IVR_SPEECH_PATH_PREFIX = '/api/ivr-speech'

/** Bump when the audio pipeline changes what the same text sounds like, so PBX caches refetch */
const AUDIO_PIPELINE_REVISION = 1
/** Longest prompt text accepted, in UTF-8 bytes — several times the longest shipped prompt */
const MAX_TEXT_BYTES = 2048
const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024

const base64UrlEncode = (text: string) => Buffer.from(text, 'utf8').toString('base64url')
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const TAG_PATTERN = /^[0-9a-f]{12}$/

/** Content hash of a clip: the cache key, and the ETag it is served with */
function clipKey(tag: string, locale: string, text: string): string {
  return bytesToHex(sha256(utf8ToBytes(`${tag}\n${locale}\n${text}`)))
}

export interface GeneratedSpeech {
  wav: Uint8Array<ArrayBuffer>
  /** Content hash — stable for the same text, locale and engine */
  etag: string
}

export class IvrSpeechService {
  private readonly cache = new Map<string, Uint8Array<ArrayBuffer>>()
  private cachedBytes = 0
  private readonly inFlight = new Map<string, Promise<Uint8Array<ArrayBuffer>>>()

  constructor(
    private readonly hmacSecret: string,
    private readonly engine: SpeechEngine = new EspeakNgEngine(),
    private readonly cacheBytes: number = DEFAULT_CACHE_BYTES,
  ) {}

  /** Short hash naming the engine build, the voices and the pipeline: part of every URL */
  private async engineTag(): Promise<string> {
    let version: string
    try {
      version = await this.engine.version()
    } catch (err) {
      // Every generated prompt is about to be silence: say so where an operator looks.
      logger.error('No speech engine: self-hosted callers will hear no generated prompts', err)
      version = 'unavailable'
    }
    const identity = `${version}\n${JSON.stringify(ESPEAK_NG_VOICES)}\n${AUDIO_PIPELINE_REVISION}`
    return bytesToHex(sha256(utf8ToBytes(identity))).slice(0, 12)
  }

  /**
   * A builder of speech URLs rooted at `origin` — the origin the provider
   * reached this worker on, which is the one it can fetch from.
   */
  async urlBuilder(origin: string): Promise<SpeechUrlBuilder> {
    const tag = await this.engineTag()
    return (text, locale) => {
      const voice = espeakVoiceFor(locale)
      if (!voice) {
        throw new Error(`Generated speech has no voice for '${locale}' — resolve it with speechLanguageFor() first`)
      }
      // Synthesise now: the PBX fetches the clip as soon as the webhook is
      // answered, and it plays nothing while it waits — dead air for the caller.
      this.synthesizeCached(clipKey(tag, locale, text), text, voice).catch((err) => {
        logger.error('Generated speech failed: this prompt will be silent', { locale, err })
      })
      const path = `${IVR_SPEECH_PATH_PREFIX}/${tag}/${locale}/${base64UrlEncode(text)}.wav`
      return `${origin}${signIvrMediaPath(this.hmacSecret, path)}`
    }
  }

  /**
   * The audio for a speech URL's path and query, or null when the URL is not
   * one this worker minted (or names nothing speakable). Throws when the
   * engine fails on a URL that is valid.
   */
  async audioFor(pathname: string, query: URLSearchParams): Promise<GeneratedSpeech | null> {
    // Verify before anything else is done with the request.
    if (!verifyIvrMediaPath(this.hmacSecret, pathname, query, { requireExpiry: false })) return null
    const match = new RegExp(`^${IVR_SPEECH_PATH_PREFIX}/([^/]+)/([^/]+)/([^/]+)\\.wav$`).exec(pathname)
    if (!match) return null
    const [, tag, locale, encoded] = match
    const voice = espeakVoiceFor(locale)
    if (!TAG_PATTERN.test(tag) || !voice || !BASE64URL_PATTERN.test(encoded)) return null
    const text = Buffer.from(encoded, 'base64url').toString('utf8')
    if (!text.trim() || Buffer.byteLength(text) > MAX_TEXT_BYTES) return null

    // A replica on another engine build still serves an older tag's URL: the
    // tag only makes the PBX refetch after an upgrade, it never refuses one.
    const etag = clipKey(tag, locale, text)
    const wav = await this.synthesizeCached(etag, text, voice)
    return { wav, etag }
  }

  private async synthesizeCached(key: string, text: string, voice: string): Promise<Uint8Array<ArrayBuffer>> {
    const hit = this.cache.get(key)
    if (hit) {
      // Refresh recency: the Map's insertion order is the eviction order.
      this.cache.delete(key)
      this.cache.set(key, hit)
      return hit
    }
    const pending = this.inFlight.get(key)
    if (pending) return pending
    const synthesis = this.engine
      .synthesize(text, voice)
      .then(toIvrWav)
      .then((wav) => {
        this.remember(key, wav)
        return wav
      })
      .finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, synthesis)
    return synthesis
  }

  private remember(key: string, wav: Uint8Array<ArrayBuffer>): void {
    if (wav.byteLength > this.cacheBytes) return
    this.cache.set(key, wav)
    this.cachedBytes += wav.byteLength
    for (const [oldest, audio] of this.cache) {
      if (this.cachedBytes <= this.cacheBytes) break
      this.cache.delete(oldest)
      this.cachedBytes -= audio.byteLength
    }
  }
}
