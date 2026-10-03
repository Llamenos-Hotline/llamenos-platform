/**
 * Fetch a call's recording the way the worker does — through AsteriskAdapter
 * (SipBridgeAdapter.getCallRecording → signed GET to the bridge) — and print
 * what came back. The worker is Bun code, so asterisk-call.e2e.ts runs this
 * with bun rather than importing the adapter into Playwright's Node runtime.
 *
 *   bun fetch-recording.ts <callSid>
 */
import { AsteriskAdapter } from '../../../../apps/worker/telephony/asterisk'

const callSid = process.argv[2]
if (!callSid) throw new Error('usage: bun fetch-recording.ts <callSid>')

const adapter = new AsteriskAdapter(
  process.env.E2E_ARI_REST_URL ?? 'http://127.0.0.1:8088/ari',
  process.env.ARI_USERNAME ?? 'llamenos',
  process.env.ARI_PASSWORD ?? '',
  '',
  process.env.E2E_BRIDGE_URL ?? 'http://127.0.0.1:3200',
  process.env.BRIDGE_SECRET ?? '',
)
const audio = await adapter.getCallRecording(callSid)
const bytes = audio ? new Uint8Array(audio) : null
console.log(JSON.stringify(bytes ? { byteLength: bytes.byteLength, magic: new TextDecoder().decode(bytes.slice(0, 4)) } : null))
