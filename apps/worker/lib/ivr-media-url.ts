/**
 * Signed URLs for the IVR media the worker hands a telephony provider: an
 * operator-uploaded prompt (`/api/ivr-audio/…`) or generated speech
 * (`/api/ivr-speech/…`). The provider fetches them unauthenticated, so the
 * public routes serve only a path the worker signed — one mechanism for both.
 *
 * The MAC covers the pathname and the expiry, never the origin: the same
 * worker is reached as `http://app:3000` by a PBX and by its public host by a
 * cloud provider, and the route verifies against the pathname it received.
 */
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { HMAC_IVR_MEDIA_URL } from '@shared/crypto-labels'
import { timingSafeCompare } from './timing-safe'

/** How long an uploaded prompt's URL is honoured at least (a response's prompts are all fetched well within it) */
export const IVR_AUDIO_URL_TTL_SECONDS = 86_400
/**
 * Expiries are rounded up to this, so every call in the same window is handed
 * the same URL. Asterisk's media cache keys on the URL and never evicts an
 * entry it does not re-fetch — a file plus an astdb row per URL, on a
 * persistent volume — so each new URL is a permanent entry: at most one per
 * prompt per day. Deleting an upload still revokes it at once (the route
 * reads storage); the expiry only bounds how long a leaked URL stays valid.
 */
export const IVR_AUDIO_URL_BUCKET_SECONDS = 86_400

const EXPIRY_PATTERN = /^\d{1,12}$/

function mac(hmacSecret: string, path: string, exp: string): string {
  const input = utf8ToBytes(`${HMAC_IVR_MEDIA_URL}${path}\n${exp}`)
  return bytesToHex(hmac(sha256, hexToBytes(hmacSecret), input))
}

/**
 * Sign a media path. With `expiresAt` (unix seconds) the URL stops verifying
 * after it; without, it verifies for as long as the secret is unchanged —
 * only for content-addressed media, whose URL already names what it serves.
 */
export function signIvrMediaPath(hmacSecret: string, path: string, expiresAt?: number): string {
  const exp = expiresAt === undefined ? '' : String(expiresAt)
  const query = new URLSearchParams()
  if (exp) query.set('exp', exp)
  query.set('sig', mac(hmacSecret, path, exp))
  return `${path}?${query}`
}

/** The expiry for an uploaded prompt's URL minted now: at least the TTL, bucketed */
export function ivrAudioUrlExpiry(nowMs: number = Date.now()): number {
  const earliest = Math.floor(nowMs / 1000) + IVR_AUDIO_URL_TTL_SECONDS
  return Math.ceil(earliest / IVR_AUDIO_URL_BUCKET_SECONDS) * IVR_AUDIO_URL_BUCKET_SECONDS
}

/**
 * True only for a path this worker signed, unexpired. `requireExpiry` refuses
 * a signature minted without one — an uploaded prompt's URL must never be a
 * durable capability.
 */
export function verifyIvrMediaPath(
  hmacSecret: string,
  path: string,
  query: URLSearchParams,
  opts: { requireExpiry: boolean; nowMs?: number },
): boolean {
  const sig = query.get('sig')
  const exp = query.get('exp') ?? ''
  if (!sig || !hmacSecret) return false
  if (exp) {
    if (!EXPIRY_PATTERN.test(exp)) return false
    if (Number(exp) * 1000 <= (opts.nowMs ?? Date.now())) return false
  } else if (opts.requireExpiry) {
    return false
  }
  return timingSafeCompare(sig, mac(hmacSecret, path, exp))
}
