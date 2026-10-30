/**
 * Step definitions for voice-captcha.feature (B-CAPTCHA, #2345).
 *
 * Every call here is a REAL Twilio-signed webhook through the full middleware
 * stack: signature check, replay protection, the route, the adapter. The hub
 * comes from the incident steps (its own hub per scenario, with members holding
 * one permission each), so what the spam holder sees is asserted through the
 * same permission-filtered GET a client uses.
 *
 * The CAPTCHA digits are read the way a caller hears them: out of the `<Say>`
 * in the challenge TwiML. Nothing reads the server's stored answer.
 */
import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, type APIRequestContext } from '@playwright/test'
import { Given, When, Then, getState, setState } from './fixtures'
import { apiGet, apiPatch } from '../../api-helpers'
import { TestDB } from '../../db-helpers'

const BASE_URL = process.env.TEST_HUB_URL || 'http://localhost:3000'

/**
 * What an English-speaking caller hears: the `voice.*` strings straight from the
 * catalogue (the adapters read the same keys through @shared/voice-prompts,
 * whose JSON imports the step loader cannot take).
 */
const EN_VOICE = (JSON.parse(readFileSync(resolve(process.cwd(), 'packages/i18n/locales/en.json'), 'utf8')) as {
  voice: Record<string, string>
}).voice
function getPrompt(key: 'rateLimited' | 'captchaRetry' | 'captchaRepeatHint', _lang: 'en'): string {
  const text = EN_VOICE[key]
  if (!text) throw new Error(`en.json has no voice.${key}`)
  return text
}
const KEY = 'voice_captcha'
const INCIDENT_KEY = 'hub_incidents'
/** Anything that looks like a phone number (spec §5.4 trap). */
const NUMBER_SHAPED = /\+?\d{7,}/

interface Reply {
  status: number
  contentType: string
  body: string
}

interface CaptchaState {
  authToken: string
  /** One caller per scenario: a fictional 555-01xx-style number. */
  callerNumber: string
  /** Every call SID this scenario used — none may appear in an incident. */
  callSids: string[]
  replies: Reply[]
  /** The live CAPTCHA call, once challenged. */
  call?: { callSid: string; digits: string; round: number }
}

function st(world: Record<string, unknown>): CaptchaState {
  const s = getState<CaptchaState | undefined>(world, KEY)
  if (!s) throw new Error('Run "the server accepts Twilio-signed calls for the incident hub" first')
  return s
}

function hubId(world: Record<string, unknown>): string {
  const s = getState<{ hubId: string; holders: Record<string, { seedHex: string }> } | undefined>(world, INCIDENT_KEY)
  if (!s) throw new Error('Run "an isolated hub for incident scenarios" first')
  return s.hubId
}

function spamHolderSeed(world: Record<string, unknown>): string {
  const s = getState<{ holders: Record<string, { seedHex: string }> }>(world, INCIDENT_KEY)
  const m = s.holders['settings:manage-spam']
  if (!m) throw new Error('No "settings:manage-spam" holder in this scenario')
  return m.seedHex
}

// Twilio's documented signature: base64(HMAC-SHA1(authToken, url + sorted key+value pairs)).
function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((acc, key) => acc + key + params[key], url)
  return createHmac('sha1', authToken).update(data).digest('base64')
}

/** POST a Twilio-signed webhook to `pathAndQuery` (relative to /api/telephony). */
async function postSigned(
  request: APIRequestContext,
  authToken: string,
  pathAndQuery: string,
  params: Record<string, string>,
): Promise<Reply> {
  const path = `/api/telephony${pathAndQuery}`
  // The server signs over WEBHOOK_BASE_URL when configured, else the request's own origin.
  const signedOrigin = process.env.WEBHOOK_BASE_URL ? new URL(process.env.WEBHOOK_BASE_URL).origin : BASE_URL
  const res = await request.post(`${BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': twilioSignature(authToken, signedOrigin + path, params),
    },
    data: new URLSearchParams(params).toString(),
  })
  return { status: res.status(), contentType: res.headers()['content-type'] ?? '', body: await res.text() }
}

function expectTwiml(reply: Reply | undefined): Reply {
  expect(reply, 'a webhook reply').toBeDefined()
  expect(reply!.status).toBe(200)
  expect(reply!.contentType).toContain('xml')
  // 'OK' is the replay acknowledgement: the webhook never reached the route.
  expect(reply!.body).not.toBe('OK')
  return reply!
}

/** A caller dials in, in English. */
async function callIn(request: APIRequestContext, world: Record<string, unknown>): Promise<{ callSid: string; reply: Reply }> {
  const s = st(world)
  const callSid = `CA${randomUUID().replace(/-/g, '')}`
  s.callSids.push(callSid)
  // forceLang is the route's own single-language path: the hub's menu order
  // decides which digit means English, so the caller does not guess a digit.
  const reply = await postSigned(request, s.authToken, `/language-selected?forceLang=en&hub=${encodeURIComponent(hubId(world))}`, {
    CallSid: callSid,
    From: s.callerNumber,
    Digits: '1',
  })
  s.replies.push(reply)
  return { callSid, reply }
}

/** The digits a caller hears in a challenge, and the round its callback carries. */
function challengeOf(reply: Reply): { digits: string; round: number } {
  const spoken = reply.body.match(/>(\d), (\d), (\d), (\d)\.</)
  expect(spoken, `a CAPTCHA challenge speaking four digits:\n${reply.body}`).not.toBeNull()
  const round = reply.body.match(/round=(\d+)/)
  expect(round, 'the challenge callback carries its round').not.toBeNull()
  return { digits: spoken!.slice(1, 5).join(''), round: Number(round![1]) }
}

async function submit(request: APIRequestContext, world: Record<string, unknown>, digits: string | null): Promise<Reply> {
  const s = st(world)
  const call = s.call
  if (!call) throw new Error('No caller has been challenged in this scenario')
  const query = `/captcha?callSid=${call.callSid}&lang=en&round=${call.round}&hub=${encodeURIComponent(hubId(world))}`
  // A Twilio timeout is the <Redirect> after the Gather: no Digits param at all.
  const params: Record<string, string> = { CallSid: call.callSid, From: s.callerNumber }
  if (digits !== null) params.Digits = digits
  const reply = expectTwiml(await postSigned(request, s.authToken, query, params))
  s.replies.push(reply)
  if (reply.body.includes('<Gather')) s.call = { ...call, ...challengeOf(reply) }
  return reply
}

const lastReply = (world: Record<string, unknown>): Reply => expectTwiml(st(world).replies.at(-1))

async function patchSpam(request: APIRequestContext, world: Record<string, unknown>, body: Record<string, unknown>) {
  const { status, data } = await apiPatch(request, `/hubs/${hubId(world)}/settings/spam`, body)
  expect(status, `PATCH spam settings: ${JSON.stringify(data)}`).toBe(200)
  return data as Record<string, unknown>
}

// ── Setup ──────────────────────────────────────────────────────────

Given('the server accepts Twilio-signed calls for the incident hub', async ({ world }) => {
  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (!authToken || !process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_PHONE_NUMBER) {
    // Fail loudly: a signed-webhook scenario that runs without a signed webhook proves nothing.
    throw new Error(
      '@signed-webhooks scenarios need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER ' +
      'set to the SAME values in the backend server and in this test process.',
    )
  }
  const suffix = String(Math.floor(Math.random() * 10_000)).padStart(4, '0')
  setState<CaptchaState>(world, KEY, { authToken, callerNumber: `+1555555${suffix}`, callSids: [], replies: [] })
})

Given('the incident hub allows {int} calls a minute from one number', async ({ request, world }, max: number) => {
  await patchSpam(request, world, { rateLimitEnabled: true, maxCallsPerMinute: max })
})

Given('the incident hub\'s over-limit action is {string}', async ({ request, world }, action: string) => {
  await patchSpam(request, world, { overLimitAction: action })
})

Given('the incident hub has the voice CAPTCHA on', async ({ request, world }) => {
  await patchSpam(request, world, { voiceCaptchaEnabled: true })
})

When('the incident hub\'s voice CAPTCHA is switched off', async ({ request, world }) => {
  await patchSpam(request, world, { voiceCaptchaEnabled: false })
})

Then('the incident hub\'s over-limit action is still {string}', async ({ request, world }, action: string) => {
  const { status, data } = await apiGet<{ overLimitAction: string }>(request, `/hubs/${hubId(world)}/settings/spam`)
  expect(status).toBe(200)
  expect(data.overLimitAction).toBe(action)
})

// ── Over the limit ─────────────────────────────────────────────────

When('{int} calls from one number reach the incident hub within one minute', async ({ request, world }, count: number) => {
  // The per-number window is the server's in-memory digest key, which rotates on
  // every wall-clock minute (CALLER_RATE_KEY_EPOCH_MS) — by design nothing
  // per-number outlives it. Starting a burst a second before the boundary would
  // split it across two windows, so start it inside the minute with room to spare.
  const intoMinute = Date.now() % 60_000
  if (intoMinute > 45_000) await new Promise((r) => setTimeout(r, 60_000 - intoMinute + 1_000))
  for (let i = 0; i < count; i++) {
    const { reply } = await callIn(request, world)
    expectTwiml(reply)
  }
})

Then('the first {int} calls are put through to the queue', async ({ world }, count: number) => {
  const replies = st(world).replies.slice(0, count)
  expect(replies).toHaveLength(count)
  for (const reply of replies) {
    expect(expectTwiml(reply).body).toContain('<Enqueue')
    expect(reply.body).not.toContain(getPrompt('rateLimited', 'en'))
  }
})

Then('the last call hears the rate-limited message and is hung up with nothing recorded', async ({ world }) => {
  const { body } = lastReply(world)
  // The existing, translated `rateLimited` prompt via the adapter's say-or-play path.
  expect(body).toContain(getPrompt('rateLimited', 'en'))
  expect(body).toContain('<Hangup/>')
  for (const verb of ['<Record', '<Enqueue', '<Gather', '<Dial', 'record=']) expect(body).not.toContain(verb)
})

Then('the last call is offered voicemail', async ({ world }) => {
  const { body } = lastReply(world)
  expect(body).toContain('<Record')
  expect(body).not.toContain('<Enqueue')
})

Then('the open spam incident holds nothing that identifies the caller', async ({ request, world }) => {
  const s = st(world)
  const { status, data } = await apiGet<{ incidents: Array<{ id: string; category: string }> }>(
    request,
    `/hubs/${hubId(world)}/incidents?open=true`,
    spamHolderSeed(world),
  )
  expect(status).toBe(200)
  const incident = data.incidents.find((i) => i.category === 'spam')
  expect(incident, 'an open spam incident').toBeDefined()

  // The stored row itself, not just what the API chose to return.
  const row = await TestDB.getRow('hub_incidents', incident!.id)
  expect(row, 'the hub_incidents row').not.toBeNull()
  const whole = JSON.stringify(row)
  const digits = s.callerNumber.replace(/\D/g, '')
  expect(whole).not.toContain(digits)
  expect(whole).not.toContain(digits.slice(-7))
  for (const callSid of s.callSids) expect(whole).not.toContain(callSid)
  // Random identifiers aside, nothing in the row is number-shaped.
  const { id: _id, hub_id: _hub, ...rest } = row as Record<string, unknown>
  expect(JSON.stringify(rest)).not.toMatch(NUMBER_SHAPED)
})

// ── CAPTCHA ────────────────────────────────────────────────────────

When('a caller reaches the incident hub and is challenged', async ({ request, world }) => {
  const { callSid, reply } = await callIn(request, world)
  expect(expectTwiml(reply).body).toContain('<Gather')
  expect(reply.body).toContain(getPrompt('captchaRepeatHint', 'en'))
  st(world).call = { callSid, ...challengeOf(reply) }
})

When('the caller enters the wrong digits', async ({ request, world }) => {
  const right = st(world).call!.digits
  await submit(request, world, right === '0000' ? '1111' : '0000')
})

When('the caller enters the right digits', async ({ request, world }) => {
  await submit(request, world, st(world).call!.digits)
})

When('the caller presses star', async ({ request, world }) => {
  await submit(request, world, '*')
})

When('the caller enters nothing', async ({ request, world }) => {
  await submit(request, world, null)
})

Then('the caller hears the retry prompt and the same digits again', async ({ world }) => {
  const s = st(world)
  const { body } = lastReply(world)
  expect(body).toContain(getPrompt('captchaRetry', 'en'))
  expect(challengeOf(lastReply(world)).digits).toBe(s.call!.digits)
  expect(body).not.toContain('<Enqueue')
})

Then('the caller hears the same digits again without the retry prompt', async ({ world }) => {
  const s = st(world)
  const { body } = lastReply(world)
  expect(body).not.toContain(getPrompt('captchaRetry', 'en'))
  expect(challengeOf(lastReply(world)).digits).toBe(s.call!.digits)
})

Then('the caller is queued for a volunteer', async ({ world }) => {
  const { body } = lastReply(world)
  expect(body).toContain('<Enqueue')
  expect(body).toContain(st(world).call!.callSid)
})

Then('the caller is offered voicemail', async ({ world }) => {
  const { body } = lastReply(world)
  expect(body).toContain('<Record')
  expect(body).not.toContain('<Enqueue')
  expect(body).not.toContain('<Gather')
})
