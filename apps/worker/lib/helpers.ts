const E164_REGEX = /^\+\d{7,15}$/

export function isValidE164(phone: string): boolean {
  return E164_REGEX.test(phone)
}


export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}

export function error(message: string, status = 400): Response {
  return Response.json({ error: message }, { status })
}

export function uint8ArrayToBase64URL(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** An IVR prompt's type segment in `/ivr-audio/:promptType/:language` */
export const IVR_PROMPT_TYPE_PATTERN = /^[a-zA-Z_-]+$/
/** An IVR prompt's language segment: a BCP 47 language, optionally with a region */
export const IVR_LANGUAGE_PATTERN = /^[a-z]{2,5}(-[A-Z]{2})?$/

/** The one format every provider plays: 8 kHz mono 16-bit PCM WAV (the PSTN's own rate) */
export const IVR_AUDIO_FORMAT = { sampleRate: 8000, channels: 1, bitsPerSample: 16 } as const

const WAVE_FORMAT_PCM = 1

/**
 * Check, from the bytes alone, that an uploaded IVR prompt is the PCM WAV that
 * providers play (IVR_AUDIO_FORMAT). The declared content type is never
 * trusted: a browser recording is WebM/Opus, which Asterisk and Twilio both
 * accept as a download and then play as silence.
 *
 * Returns null when the file is playable, or why it is not.
 */
export function ivrAudioFormatError(bytes: Uint8Array): string | null {
  const ascii = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  if (bytes.byteLength < 12 || ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE') {
    return 'Not a WAV file'
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let fmt: { format: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null
  let offset = 12
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (body + size > bytes.byteLength) return `Truncated WAV: the ${id.trim()} chunk runs past the end of the file`
    if (id === 'fmt ') {
      if (size < 16) return 'Malformed WAV format chunk'
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      }
    } else if (id === 'data') {
      if (!fmt) return 'Malformed WAV: audio data before the format chunk'
      const { sampleRate, channels, bitsPerSample } = IVR_AUDIO_FORMAT
      if (fmt.format !== WAVE_FORMAT_PCM || fmt.bitsPerSample !== bitsPerSample) {
        return `WAV audio must be ${bitsPerSample}-bit PCM`
      }
      if (fmt.channels !== channels) return 'WAV audio must be mono'
      if (fmt.sampleRate !== sampleRate) return `WAV audio must be sampled at ${sampleRate} Hz, not ${fmt.sampleRate} Hz`
      if (size === 0) return 'WAV file has no audio'
      return null
    }
    // Chunks are word-aligned: an odd-sized chunk is followed by a pad byte.
    offset = body + size + (size % 2)
  }
  return 'Malformed WAV: no audio data'
}

type AudioUrlMapSource =
  | { fetch(req: Request): Promise<Response> }
  | { getIvrAudioList(): Promise<{ recordings: Array<{ promptType: string; language: string }> }> }

export async function buildAudioUrlMap(settings: AudioUrlMapSource, origin: string): Promise<Record<string, string>> {
  let recordings: Array<{ promptType: string; language: string }>
  if ('getIvrAudioList' in settings) {
    const result = await settings.getIvrAudioList()
    recordings = result.recordings
  } else {
    const audioRes = await settings.fetch(new Request('http://do/settings/ivr-audio'))
    const data = await audioRes.json() as { recordings: Array<{ promptType: string; language: string }> }
    recordings = data.recordings
  }
  const map: Record<string, string> = {}
  for (const rec of recordings) {
    map[`${rec.promptType}:${rec.language}`] = `${origin}/api/ivr-audio/${rec.promptType}/${rec.language}`
  }
  return map
}

export function telephonyResponse(response: { contentType: string; body: string }): Response {
  return new Response(response.body, { headers: { 'Content-Type': response.contentType } })
}

export async function checkRateLimit(settings: { checkRateLimit(data: { key: string; maxPerMinute: number }): Promise<{ limited: boolean }> }, key: string, maxPerMinute: number): Promise<boolean> {
  const result = await settings.checkRateLimit({ key, maxPerMinute })
  return result.limited
}
