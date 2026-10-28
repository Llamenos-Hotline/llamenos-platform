/**
 * Public IVR media: what a telephony provider fetches while a caller listens.
 * The provider sends no credentials, so each route serves only a URL this
 * worker signed (lib/ivr-media-url.ts) and minted for a call.
 *
 * Operators listen back to their uploads through the authenticated
 * GET /settings/ivr-audio/:promptType/:language instead.
 */
import { Hono, type Context } from 'hono'
import type { AppEnv } from '../types'
import { IVR_HUB_ID_PATTERN, IVR_LANGUAGE_PATTERN, IVR_PROMPT_TYPE_PATTERN } from '../lib/helpers'
import { verifyIvrMediaPath } from '../lib/ivr-media-url'

const ivrMedia = new Hono<AppEnv>()

/**
 * An operator-uploaded prompt, through the signed, expiring URL
 * buildAudioUrlMap mints (#1325). Every refusal is the same 404, and the
 * signature is checked before the database is: an unsigned request learns
 * nothing — not even whether a prompt exists for a language.
 *
 * The platform default lives at `/ivr-audio/:promptType/:language`; a call in
 * a hub is handed `/ivr-audio/:hubId/:promptType/:language`, which serves the
 * hub's own recording and falls back to the default. The hub is part of the
 * signed path, so a URL minted for one hub cannot be repointed at another.
 */
const uploadedPrompt = (hubSegment: boolean) => async (c: Context<AppEnv>) => {
  const notFound = () => c.json({ error: 'Not found' }, 404)
  const url = new URL(c.req.url)
  if (!verifyIvrMediaPath(c.env.HMAC_SECRET, url.pathname, url.searchParams, { requireExpiry: true })) {
    return notFound()
  }
  const hubId = hubSegment ? c.req.param('hubId') : undefined
  const promptType = c.req.param('promptType') ?? ''
  const language = c.req.param('language') ?? ''
  if (hubSegment && !IVR_HUB_ID_PATTERN.test(hubId ?? '')) return notFound()
  if (!IVR_PROMPT_TYPE_PATTERN.test(promptType) || !IVR_LANGUAGE_PATTERN.test(language)) return notFound()
  const result = await c.get('services').settings.getEffectiveIvrAudio(hubId, promptType, language)
  if (!result) return notFound()
  // Uploads are validated as PCM WAV (ivrAudioFormatError), so the type is true.
  return c.body(Buffer.from(result.audio, 'base64'), 200, { 'Content-Type': 'audio/wav' })
}

ivrMedia.get('/ivr-audio/:promptType/:language', uploadedPrompt(false))
ivrMedia.get('/ivr-audio/:hubId/:promptType/:language', uploadedPrompt(true))

/**
 * Generated speech (#1347): what a self-hosted PBX plays for a prompt no
 * operator uploaded. The URL is signed and names its own content
 * (IvrSpeechService), so it never changes meaning and is cached for good —
 * a change to the text or the engine is a different URL.
 */
const generatedSpeech = async (c: Context<AppEnv>) => {
  const url = new URL(c.req.url)
  const speech = await c.get('services').ivrSpeech.audioFor(url.pathname, url.searchParams)
  if (!speech) return c.json({ error: 'Not found' }, 404)
  return c.body(speech.wav, 200, {
    'Content-Type': 'audio/wav',
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: `"${speech.etag}"`,
  })
}

ivrMedia.get('/ivr-speech/:tag/:locale/:clip', generatedSpeech)
/** A voice CAPTCHA digit, under a keyed name that does not reveal which digit (#1352) */
ivrMedia.get('/ivr-speech/:tag/:locale/digit/:clip', generatedSpeech)

export default ivrMedia
