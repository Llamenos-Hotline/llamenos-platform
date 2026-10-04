/**
 * Contract: the worker's AsteriskAdapter and the sip-bridge CommandHandler
 * speak the same language.
 *
 * They are two programs written against two hand-kept vocabularies, and they
 * drifted completely: every command the worker sent was silently dropped by the
 * bridge, and most webhook fields the bridge sent were never read by the worker.
 * Each side's own unit tests stayed green throughout. This test runs the REAL
 * adapter against the REAL command handler, through every step of a call, with
 * a fake worker that does exactly what apps/worker/routes/telephony.ts does with
 * each webhook: parse it with the adapter, hand the adapter's answer back.
 *
 * It lives here, not in sip-bridge/, because this is the suite CI runs
 * (vitest.unit.config.ts includes deploy/docker/tests/**).
 */
import '@worker/__tests__/mocks/llamenos-crypto-ffi'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { AsteriskAdapter } from '@worker/telephony/asterisk'
import type { TelephonyResponse } from '@worker/telephony/adapter'
import { fakeSpeech, spoken } from '@worker/__tests__/helpers/fake-speech'
import { CommandHandler } from '../../../../sip-bridge/src/command-handler'
import type { BridgeClient, BridgeEvent } from '../../../../sip-bridge/src/bridge-client'
import type { WebhookSender } from '../../../../sip-bridge/src/webhook-sender'
import { CALLBACK_PATHS, WORKER_PATHS, type BridgeCommand, type BridgeConfig, type WebhookPayload } from '../../../../sip-bridge/src/types'
import { logger } from '../../../../sip-bridge/src/logger'

vi.mock('@worker/lib/service-factories')
vi.mock('@worker/services/webhook-replay', () => ({ checkWebhookReplay: vi.fn().mockResolvedValue(true) }))
vi.mock('@worker/db', () => ({ getDb: vi.fn().mockReturnValue({}) }))

const HUB = 'hub-1'
const CALLER = '1790000000.1'
const BRIDGE_URL = 'http://bridge:3000'
const adapter = new AsteriskAdapter('http://asterisk:8088', 'llamenos', 'pw', '+15550100', BRIDGE_URL, 'bridge-secret')

// ---- a PBX that just records what the bridge asked of it ----

function fakePbx() {
  const calls: Array<{ method: string; args: unknown[] }> = []
  let seq = 0
  const record = (method: string, result?: () => unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args })
      return result?.()
    }
  const client = new Proxy({} as BridgeClient, {
    get: (_, method: string) => {
      if (method === 'originate') return record(method, () => ({ id: `leg-${++seq}` }))
      if (method === 'playMedia') return record(method, () => `pb-${++seq}`)
      if (method === 'bridge') return record(method, () => 'bridge-1')
      return record(method)
    },
  })
  return { client, of: (method: string) => calls.filter((c) => c.method === method).map((c) => c.args) }
}

// ---- a worker that does what routes/telephony.ts does with each webhook ----

interface Received {
  path: string
  query: Record<string, string>
  payload: WebhookPayload
}

function webhookRequest(path: string, payload: WebhookPayload, query: Record<string, string>): Request {
  const qs = new URLSearchParams(query).toString()
  return new Request(`http://worker:3000${path}${qs ? `?${qs}` : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

function commandsOf(response: TelephonyResponse): BridgeCommand[] {
  expect(response.contentType).toBe('application/json')
  return (JSON.parse(response.body) as { commands: BridgeCommand[] }).commands
}

interface WorkerScript {
  enabledLanguages: string[]
  captchaDigits?: string
  queueTimeoutSeconds?: number
}

function fakeWorker(script: WorkerScript) {
  const received: Received[] = []
  /** What the worker concluded from each webhook, via the adapter's own parsers */
  const parsed: Record<string, unknown[]> = {}
  const note = (key: string, value: unknown) => {
    parsed[key] = [...(parsed[key] ?? []), value]
  }

  const routes: Record<string, (req: Request, q: Record<string, string>) => Promise<TelephonyResponse>> = {
    [WORKER_PATHS.incoming]: async (req) => {
      const info = await adapter.parseIncomingWebhook(req)
      note('incoming', info)
      return adapter.handleLanguageMenu({ ...info, hotlineName: 'Llámenos', enabledLanguages: script.enabledLanguages, hubId: HUB, speechUrl: fakeSpeech })
    },
    [CALLBACK_PATHS.language_selected]: async (req, q) => {
      const info = await adapter.parseLanguageWebhook(req)
      note('language-selected', info)
      const callerLanguage = q.forceLang ?? (info.digits === '2' ? 'es' : 'en')
      return adapter.handleIncomingCall({
        callSid: info.callSid,
        callerNumber: info.callerNumber,
        voiceCaptchaEnabled: script.captchaDigits !== undefined,
        captchaDigits: script.captchaDigits,
        rateLimited: false,
        callerLanguage,
        hotlineName: 'Llámenos',
        hubId: q.hub,
        speechUrl: fakeSpeech,
      })
    },
    [CALLBACK_PATHS.captcha_response]: async (req, q) => {
      const { digits } = await adapter.parseCaptchaWebhook(req)
      note('captcha', digits)
      return adapter.handleCaptchaResponse({ callSid: q.callSid, digits, expectedDigits: script.captchaDigits ?? '', callerLanguage: q.lang, hubId: q.hub, speechUrl: fakeSpeech })
    },
    [CALLBACK_PATHS.wait_music]: async (req, q) => {
      const { queueTime } = await adapter.parseQueueWaitWebhook(req)
      note('wait-music', queueTime)
      return adapter.handleWaitMusic(q.lang, undefined, queueTime, script.queueTimeoutSeconds ?? 90, fakeSpeech)
    },
    [CALLBACK_PATHS.queue_exit]: async (req, q) => {
      const { result } = await adapter.parseQueueExitWebhook(req)
      note('queue-exit', result)
      if (result === 'hangup' || result === 'bridged') return adapter.emptyResponse()
      return adapter.handleVoicemail({ callSid: q.callSid, callerLanguage: q.lang, callbackUrl: 'http://worker:3000', hubId: q.hub, speechUrl: fakeSpeech })
    },
    [WORKER_PATHS.userAnswer]: async (_req, q) => {
      note('user-answer', q.callToken)
      // The worker resolves the token to the parent call it was minted for.
      return adapter.handleCallAnswered({ parentCallSid: CALLER, callbackUrl: 'http://worker:3000', userPubkey: 'pk', hubId: HUB })
    },
    [WORKER_PATHS.callStatus]: async (req, q) => {
      note('call-status', { ...(await adapter.parseCallStatusWebhook(req)), callToken: q.callToken })
      return adapter.emptyResponse()
    },
    [WORKER_PATHS.callRecording]: async (req, q) => {
      note('call-recording', { ...(await adapter.parseRecordingWebhook(req)), parentCallSid: q.parentCallSid })
      return adapter.emptyResponse()
    },
    [CALLBACK_PATHS.recording_complete]: async (req) => {
      note('voicemail-recording', await adapter.parseRecordingWebhook(req))
      return adapter.emptyResponse()
    },
    [WORKER_PATHS.voicemailComplete]: async (_req, q) => {
      note('voicemail-complete', q.lang)
      return adapter.handleVoicemailComplete(q.lang, fakeSpeech)
    },
  }

  const webhook = {
    sendWebhookForCommands: async (path: string, payload: WebhookPayload, query: Record<string, string> = {}) => {
      received.push({ path, query, payload })
      const route = routes[path]
      if (!route) throw new Error(`the bridge posted to ${path}, which is not a worker telephony route`)
      return commandsOf(await route(webhookRequest(path, payload, query), query))
    },
  } as unknown as WebhookSender

  return { webhook, received, parsed, to: (path: string) => received.filter((r) => r.path === path) }
}

const bridgeConfig: BridgeConfig = {
  pbxType: 'asterisk',
  ariUrl: '',
  ariRestUrl: '',
  ariUsername: '',
  ariPassword: '',
  eslHost: '',
  eslPort: 8021,
  eslPassword: '',
  kamailioJsonrpcUrl: '',
  workerWebhookUrl: 'http://worker:3000',
  bridgeSecret: 'bridge-secret',
  bridgePort: 3000,
  bridgeHost: '0.0.0.0',
  stasisApp: 'llamenos',
  connectionTimeoutMs: 300_000,
}

const ts = '2026-09-29T00:00:00.000Z'
const incoming: BridgeEvent = { type: 'channel_create', channelId: CALLER, callerNumber: '+15557770001', calledNumber: '+15550100', args: [], timestamp: ts }
const dtmf = (digit: string): BridgeEvent => ({ type: 'dtmf_received', channelId: CALLER, digit, durationMs: 100, timestamp: ts })
const hangup = (channelId: string, cause = 16): BridgeEvent => ({ type: 'channel_hangup', channelId, cause, causeText: '', timestamp: ts })

describe('AsteriskAdapter ⇄ sip-bridge CommandHandler', () => {
  let pbx: ReturnType<typeof fakePbx>
  let handler: CommandHandler | undefined
  let unknownCommands: unknown[]

  beforeEach(() => {
    vi.useFakeTimers()
    pbx = fakePbx()
    unknownCommands = []
    const error = logger.error.bind(logger)
    vi.spyOn(logger, 'error').mockImplementation((tag: string, message: string, ...rest: unknown[]) => {
      if (message.startsWith('Unknown command action')) unknownCommands.push(message)
      error(tag, message, ...rest)
    })
  })

  afterEach(() => {
    handler?.dispose()
    vi.useRealTimers()
    vi.restoreAllMocks()
    // No command the adapter emitted was one the bridge does not understand.
    expect(unknownCommands).toEqual([])
  })

  it('every path the bridge posts to is a telephony route the worker serves', async () => {
    const { default: telephony } = await import('@worker/routes/telephony')
    const app = new Hono().route('/api/telephony', telephony)
    const served = new Set(app.routes.map((r) => r.path))
    for (const path of [...Object.values(CALLBACK_PATHS), ...Object.values(WORKER_PATHS)]) {
      expect(served, path).toContain(path)
    }
  })

  it('an answered call: menu, captcha, queue, ring, answer, bridge, hang up, recording', async () => {
    const worker = fakeWorker({ enabledLanguages: ['en', 'es'], captchaDigits: '4837' })
    handler = new CommandHandler(pbx.client, worker.webhook, bridgeConfig)

    await handler.handleEvent(incoming)
    expect(worker.parsed.incoming).toEqual([{ callSid: CALLER, callerNumber: '+15557770001', calledNumber: '+15550100' }])
    // The menu is heard: each option played as generated speech, in its own language.
    const menu = pbx.of('playMedia').map(([, media]) => spoken(String(media).replace(/^sound:/, '')))
    expect(menu.map((m) => m?.locale)).toEqual(['en', 'es'])

    // Language menu: the caller presses 2 (Spanish). The hub rides along to the next route.
    await handler.handleEvent(dtmf('2'))
    expect(worker.to(CALLBACK_PATHS.language_selected)[0].query).toEqual({ hub: HUB })
    expect(worker.parsed['language-selected']).toEqual([{ callSid: CALLER, callerNumber: '+15557770001', digits: '2' }])

    // Voice captcha: four digits, posted with the call's context.
    for (const d of '4837') await handler.handleEvent(dtmf(d))
    expect(worker.to(CALLBACK_PATHS.captcha_response)[0].query).toEqual({ callSid: CALLER, lang: 'es', hub: HUB })
    expect(worker.parsed.captcha).toEqual(['4837'])

    // Passed: the caller is queued on hold, and wait-music is polled with their language.
    expect(pbx.of('startMoh')).toEqual([[CALLER]])
    expect(worker.to(CALLBACK_PATHS.wait_music)[0].query).toEqual({ callSid: CALLER, lang: 'es', hub: HUB })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(worker.parsed['wait-music']).toEqual([0, 10])

    // The worker rings volunteers: what the adapter POSTs to /ring is what the bridge reads.
    const ringBody = await captureRingRequest()
    const legs = await handler.ringVolunteers(ringBody)
    expect(pbx.of('originate')).toEqual([
      [{ endpoint: 'PJSIP/+15550200@trunk', callerId: '+15557770001', timeout: 30, appArgs: `dialed,${CALLER},token-a` }],
      [{ endpoint: 'PJSIP/+15550201@trunk', callerId: '+15557770001', timeout: 30, appArgs: `dialed,${CALLER},token-b` }],
    ])

    // Volunteer A picks up: the answer carries A's token, and the worker's answer bridges them.
    await handler.handleEvent({ type: 'channel_create', channelId: legs[0], callerNumber: '', calledNumber: 's', args: ['dialed', CALLER, 'token-a'], timestamp: ts })
    expect(worker.parsed['user-answer']).toEqual(['token-a'])
    expect(pbx.of('bridge')).toEqual([[CALLER, legs[0], { type: 'mixing', record: false }]])
    expect(pbx.of('hangup')).toEqual([[legs[1]]])
    expect(pbx.of('recordBridge')).toHaveLength(1)

    // Volunteer A hangs up: the worker reads a completed leg for A's token…
    await handler.handleEvent(hangup(legs[0]))
    expect(worker.parsed['call-status']).toEqual([{ status: 'completed', callToken: 'token-a' }])

    // …and the recording's outcome as completed, for the parent call.
    await handler.handleEvent({ type: 'recording_complete', channelId: 'bridge-1', recordingName: `call-${CALLER}`, timestamp: ts })
    expect(worker.parsed['call-recording']).toEqual([
      { status: 'completed', recordingSid: `call-${CALLER}`, callSid: CALLER, parentCallSid: CALLER },
    ])
  })

  it('an unanswered leg is read by the worker with the status its hangup cause means', async () => {
    const worker = fakeWorker({ enabledLanguages: ['en'] })
    handler = new CommandHandler(pbx.client, worker.webhook, bridgeConfig)
    await handler.handleEvent(incoming)
    const [busy, noAnswer] = await handler.ringVolunteers(await captureRingRequest())

    await handler.handleEvent(hangup(busy, 17))
    await handler.handleEvent(hangup(noAnswer, 19))

    expect(worker.parsed['call-status']).toEqual([
      { status: 'busy', callToken: 'token-a' },
      { status: 'no-answer', callToken: 'token-b' },
    ])
  })

  it('nobody answers: the queue times out to voicemail, which is reported and closed', async () => {
    const worker = fakeWorker({ enabledLanguages: ['es'], queueTimeoutSeconds: 30 })
    handler = new CommandHandler(pbx.client, worker.webhook, bridgeConfig)

    // Single-language hotline: no menu input, straight to the queue.
    await handler.handleEvent(incoming)
    expect(worker.to(CALLBACK_PATHS.language_selected)[0].query).toEqual({ auto: '1', forceLang: 'es', hub: HUB })

    await vi.advanceTimersByTimeAsync(30_000)
    expect(worker.parsed['queue-exit']).toEqual(['leave'])
    expect(pbx.of('recordChannel')).toEqual([
      [CALLER, { name: `voicemail-${CALLER}`, format: 'wav', maxDurationSeconds: 120, beep: true, terminateOn: '#' }],
    ])

    await handler.handleEvent({ type: 'recording_complete', channelId: CALLER, recordingName: `voicemail-${CALLER}`, timestamp: ts })
    expect(worker.to(CALLBACK_PATHS.recording_complete)[0].query).toEqual({ callSid: CALLER, lang: 'es', hub: HUB })
    expect(worker.parsed['voicemail-recording']).toEqual([{ status: 'completed', recordingSid: `voicemail-${CALLER}`, callSid: CALLER }])
    expect(worker.parsed['voicemail-complete']).toEqual(['es'])
    // The thank-you is heard to the end: the call ends once every prompt has played.
    expect(pbx.of('hangup')).not.toContainEqual([CALLER])
    const played = pbx.of('playMedia').length
    for (let n = 1; n <= played; n++) {
      await handler.handleEvent({ type: 'playback_finished', channelId: CALLER, playbackId: `pb-${n}`, failed: false, media: '', timestamp: ts })
    }
    expect(pbx.of('hangup')).toContainEqual([CALLER])
  })

  it('a caller hanging up in the queue is read by the worker as a hangup', async () => {
    const worker = fakeWorker({ enabledLanguages: ['es'] })
    handler = new CommandHandler(pbx.client, worker.webhook, bridgeConfig)
    await handler.handleEvent(incoming)

    await handler.handleEvent(hangup(CALLER))

    expect(worker.parsed['queue-exit']).toEqual(['hangup'])
    expect(worker.to(CALLBACK_PATHS.queue_exit)[0].query).toEqual({ callSid: CALLER, lang: 'es', hub: HUB })
  })
})

/** What AsteriskAdapter.ringVolunteers sends to the bridge's /ring endpoint */
async function captureRingRequest() {
  let body: unknown
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    expect(String(input)).toBe(`${BRIDGE_URL}/ring`)
    body = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ ok: true, channelIds: [] }), { headers: { 'Content-Type': 'application/json' } })
  })
  await adapter.ringVolunteers({
    callSid: CALLER,
    callerNumber: '+15557770001',
    volunteers: [
      { phone: '+15550200', callToken: 'token-a' },
      { phone: '+15550201', callToken: 'token-b' },
    ],
    callbackUrl: 'http://worker:3000',
    hubId: HUB,
  })
  fetchSpy.mockRestore()
  return body as Parameters<CommandHandler['ringVolunteers']>[0]
}
