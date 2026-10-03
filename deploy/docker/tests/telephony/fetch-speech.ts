/**
 * Fetch, from the running app, the generated speech it serves for a prompt —
 * through the same signed URL the worker hands the PBX — and print it as
 * base64 WAV. The URL names the engine build, so the version is read from the
 * app container's own espeak-ng. The worker is Bun code, and the prompt texts
 * come from the locale files, so asterisk-call.e2e.ts runs this with bun (as
 * it does fetch-recording.ts).
 *
 *   bun fetch-speech.ts <locale> prompt:<key>   a voice prompt (the greeting names the hotline)
 *   bun fetch-speech.ts <locale> menu:<digit>   the language menu's option for <locale>
 */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IvrSpeechService } from '../../../../apps/worker/services/ivr-speech'
import { EspeakNgEngine } from '../../../../apps/worker/services/ivr-speech/espeak'
import { writePcm16Wav } from '../../../../apps/worker/services/ivr-speech/audio'
import { IVR_PROMPTS, getPrompt, resolveIvrPrompt } from '../../../../packages/shared/voice-prompts'

const [locale, spec] = process.argv.slice(2)
if (!locale || !spec) throw new Error('usage: bun fetch-speech.ts <locale> prompt:<key>|menu:<digit>')
/** The hub's name as the app is configured with it (docker-compose.carrier.yml) */
const HOTLINE_NAME = 'Llámenos (E2E)'
const [kind, arg] = spec.split(':')
const text =
  kind === 'menu' ? resolveIvrPrompt(IVR_PROMPTS[locale], arg)
  : kind === 'prompt' ? getPrompt(arg, locale).replace('{name}', HOTLINE_NAME)
  : ''
if (!text) throw new Error(`no text for ${locale} ${spec}`)

const app = process.env.E2E_APP_CONTAINER ?? 'll-telephony-e2e-app-1'
const origin = process.env.TEST_HUB_URL ?? 'http://127.0.0.1:3931'
const secret = process.env.HMAC_SECRET
if (!secret) throw new Error('HMAC_SECRET (the app\'s) is required')

// espeak-ng as the app runs it: in the app container.
const dir = mkdtempSync(join(tmpdir(), 'espeak-in-app-'))
const espeak = join(dir, 'espeak-ng')
writeFileSync(espeak, `#!/bin/sh\nexec docker exec -i ${app} espeak-ng "$@"\n`)
chmodSync(espeak, 0o755)

/** Only the URL is minted here — the audio compared is what the app serves — so the local clip is a stub */
class RemoteVersionEngine extends EspeakNgEngine {
  override async synthesize(): Promise<Uint8Array> {
    return writePcm16Wav({ sampleRate: 8000, samples: new Int16Array(8) })
  }
}

const build = await new IvrSpeechService(secret, new RemoteVersionEngine(espeak)).urlBuilder(origin)
const url = build(text, locale)
const res = await fetch(url)
if (!res.ok) throw new Error(`GET ${new URL(url).pathname} → ${res.status}`)
console.log(JSON.stringify({ text, path: new URL(url).pathname, wav: Buffer.from(await res.arrayBuffer()).toString('base64') }))
