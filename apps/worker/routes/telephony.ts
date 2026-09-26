import { Hono, type Context, type Next } from 'hono'
import { describeRoute } from 'hono-openapi'
import type { AppEnv } from '../types'
import { getTelephonyFromService, getHubTelephonyFromService } from '../lib/service-factories'
import type { TelephonyAdapter } from '../telephony/adapter'
import type { Services } from '../services'
import type { Env } from '../types'
import { buildAudioUrlMap, telephonyResponse } from '../lib/helpers'
import { hashPhone } from '../lib/crypto'
import { detectLanguageFromPhone, languageFromDigit, DEFAULT_LANGUAGE } from '@shared/languages'
import { audit } from '../services/audit'
import { startParallelRinging } from '../services/ringing'
import { maybeTranscribe, transcribeVoicemail } from '../services/transcription'
import { publishEvent } from '../lib/ws-events'
import { KIND_CALL_UPDATE, KIND_CALL_VOICEMAIL, KIND_PRESENCE_UPDATE } from '@shared/event-kinds'
import { createLogger } from '../lib/logger'
import { backgroundTask } from '../lib/hono-compat'
import { checkWebhookReplay } from '../services/webhook-replay'
import { getDb } from '../db'
import { isIpInCidrs } from '../middleware/webhook-ip-allowlist'
import { webhookAuth } from '../middleware/webhook-auth'

const logger = createLogger('telephony')

const telephony = new Hono<AppEnv>()

// Apply webhook auth middleware to all telephony webhook routes:
// - Content-Type enforcement (form-encoded or JSON depending on provider)
// - IP allowlisting (via TELEPHONY_WEBHOOK_IPS env var)
// Replay protection is deliberately skipped here: it runs exactly once, in
// validateWebhook, AFTER the provider signature check. Running it in both
// places inserted the same nonce twice, so every webhook looked like a replay
// of itself and was swallowed with a 200 "OK" (#1036). Running it before the
// signature check would also let unsigned requests burn nonces.
telephony.use('*', webhookAuth({
  provider: 'telephony',
  allowedContentTypes: ['application/x-www-form-urlencoded', 'application/json'],
  skipReplay: true,
}))

/**
 * Resolve hub-scoped services and telephony adapter from a hub query param.
 */
async function getHubAdapter(env: Env, services: Services, hubId: string | undefined): Promise<TelephonyAdapter | null> {
  if (hubId) {
    return getHubTelephonyFromService(env, services.settings, hubId)
  }
  return getTelephonyFromService(env, services.settings)
}

/**
 * Webhook validation middleware — applied per-route to actual webhook endpoints.
 * NOT a wildcard `use('*')` because authenticated webrtcRoutes are mounted at the
 * same `/telephony` prefix and must not be intercepted by webhook signature checks.
 *
 * W05: Enforces signature validation, IP allowlist (opt-in), and replay protection.
 */
async function validateWebhook(c: Context<AppEnv>, next: Next) {
  const url = new URL(c.req.url)
  logger.debug('Webhook received', { method: c.req.method, path: url.pathname, search: url.search })
  const env = c.env
  const services = c.get('services')

  // For /incoming, we don't know the hub yet — use global adapter for validation
  // For all other routes, hub is in query params
  const hubId = url.searchParams.get('hub') || undefined
  const adapter = await getHubAdapter(env, services, hubId)

  // If no telephony provider is configured, reject with 403 — same as
  // signature validation failure. Never reveal whether telephony is set up.
  if (!adapter) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  // W05-H03: IP allowlist (opt-in via TELEPHONY_WEBHOOK_IPS env var)
  const cidrs = (env as unknown as Record<string, string | undefined>).TELEPHONY_WEBHOOK_IPS
  if (cidrs) {
    const cidrList = cidrs.split(',').map(s => s.trim()).filter(Boolean)
    const clientIp = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
    if (!clientIp || !isIpInCidrs(clientIp, cidrList)) {
      logger.warn('Telephony webhook IP not in allowlist', { clientIp })
      return c.json({ error: 'Forbidden' }, 403)
    }
  }

  // H05: Always validate webhook signatures — no localhost bypass
  const isValid = await adapter.validateWebhook(c.req.raw)
  if (!isValid) {
    logger.error(`Webhook signature FAILED for ${url.pathname}`)
    return c.json({ error: 'Forbidden' }, 403)
  }

  // W05-H02: Replay protection — hash body to detect duplicate deliveries.
  // Returns idempotent 200 for replays (provider retries stop on 2xx).
  const bodyText = await c.req.raw.clone().text()
  const isFirst = await checkWebhookReplay(getDb(), 'telephony', bodyText, 300)
  if (!isFirst) {
    logger.info('Telephony webhook replay detected, returning idempotent 200')
    return c.text('OK', 200)
  }

  await next()
}

// --- Step 1: Incoming call -> hub lookup -> ban check -> language menu ---
telephony.post('/incoming',
  validateWebhook,
  describeRoute({
    tags: ['Telephony Webhooks'],
    summary: 'Incoming call — provider webhook (step 1)',
    description: 'Receives incoming call from telephony provider, resolves hub, checks ban list, returns TwiML language menu.',
    responses: {
      200: { description: 'TwiML response (application/xml)' },
      403: { description: 'Webhook signature invalid' },
    },
  }),
  async (c) => {
  const services = c.get('services')
  const globalAdapter = (await getTelephonyFromService(c.env, services.settings))!
  const { callSid, callerNumber, calledNumber } = await globalAdapter.parseIncomingWebhook(c.req.raw)
  logger.info('Incoming call', { callSid, callerLast4: callerNumber.slice(-4), calledNumber: calledNumber || 'unknown' })

  // Look up which hub owns the called phone number
  let hubId: string | undefined
  if (calledNumber) {
    try {
      const { hub } = await services.settings.getHubByPhone(calledNumber)
      hubId = hub.id
      logger.info('Resolved hub for incoming call', { hubId, calledNumber })
    } catch {
      // No hub found for this number
    }
  }

  // Use hub-scoped adapter for all subsequent operations
  const adapter = hubId ? ((await getHubTelephonyFromService(c.env, services.settings, hubId)) ?? globalAdapter) : globalAdapter

  const banned = await services.records.checkBan(hashPhone(callerNumber, c.env.HMAC_SECRET), hubId)
  if (banned) {
    return telephonyResponse(adapter.rejectCall())
  }

  const { enabledLanguages } = await services.settings.getIvrLanguages(hubId)

  const response = await adapter.handleLanguageMenu({
    callSid,
    callerNumber,
    hotlineName: c.env.HOTLINE_NAME || 'Llamenos',
    enabledLanguages,
    hubId,
  })
  return telephonyResponse(response)
})

// --- Step 2: Language selected -> spam check -> greeting + hold/captcha ---
telephony.post('/language-selected',
  validateWebhook,
  describeRoute({
    tags: ['Telephony Webhooks'],
    summary: 'Language digit collected — provider webhook (step 2)',
    description: 'Receives DTMF digit from language menu gather. Applies spam/captcha checks and returns TwiML greeting or hold.',
    responses: {
      200: { description: 'TwiML response (application/xml)' },
      403: { description: 'Webhook signature invalid' },
    },
  }),
  async (c) => {
  const url = new URL(c.req.url)
  const hubId = url.searchParams.get('hub') || undefined
  const services = c.get('services')
  const adapter = (await getHubAdapter(c.env, services, hubId))!
  const { callSid, callerNumber, digits } = await adapter.parseLanguageWebhook(c.req.raw)
  const isAuto = url.searchParams.get('auto') === '1'

  // Get hub's ordered language list for digit-to-language mapping
  const { enabledLanguages: hubLanguages } = await services.settings.getIvrLanguages(hubId)

  let callerLanguage: string
  const forceLang = url.searchParams.get('forceLang')
  if (forceLang) {
    callerLanguage = forceLang
  } else if (isAuto) {
    callerLanguage = detectLanguageFromPhone(callerNumber)
  } else {
    callerLanguage = languageFromDigit(digits, hubLanguages) ?? detectLanguageFromPhone(callerNumber)
  }

  // Spam settings and the per-caller rate-limit window are per hub: a caller
  // dialling hub A must not consume hub B's budget, and each hub's toggles
  // apply only to its own calls.
  const spamSettings = await services.settings.getSpamSettings(hubId)

  let rateLimited = false
  if (spamSettings.rateLimitEnabled) {
    const rlResult = await services.settings.checkRateLimit({
      key: `phone:${hubId ? `${hubId}:` : ''}${hashPhone(callerNumber, c.env.HMAC_SECRET)}`,
      maxPerMinute: spamSettings.maxCallsPerMinute,
    })
    rateLimited = rlResult.limited
  }

  // Generate CAPTCHA digits server-side with CSPRNG and store them
  let captchaDigits: string | undefined
  if (spamSettings.voiceCaptchaEnabled && !rateLimited) {
    const buf = new Uint8Array(2)
    crypto.getRandomValues(buf)
    captchaDigits = String(1000 + (((buf[0] << 8) | buf[1]) % 9000))
    // Store expected digits server-side (not in callback URL)
    await services.settings.storeCaptcha({ callSid, expected: captchaDigits })
  }

  const audioUrls = await buildAudioUrlMap(services.settings, new URL(c.req.url).origin)
  const response = await adapter.handleIncomingCall({
    callSid,
    callerNumber,
    voiceCaptchaEnabled: spamSettings.voiceCaptchaEnabled,
    rateLimited,
    callerLanguage,
    hotlineName: c.env.HOTLINE_NAME || 'Llamenos',
    audioUrls,
    captchaDigits,
    hubId,
  })

  if (!rateLimited && !spamSettings.voiceCaptchaEnabled) {
    const origin = new URL(c.req.url).origin
    logger.info('Starting parallel ringing', { callSid, origin, hubId: hubId || 'global' })
    backgroundTask(c,startParallelRinging(callSid, callerNumber, origin, c.env, services, hubId ?? ''))
  }

  return telephonyResponse(response)
})

// --- Step 3: CAPTCHA response ---
telephony.post('/captcha',
  validateWebhook,
  describeRoute({
    tags: ['Telephony Webhooks'],
    summary: 'CAPTCHA digit response — provider webhook (step 3)',
    description: 'Receives DTMF digit from voice CAPTCHA gather. Validates against server-stored expected digits, returns TwiML.',
    responses: {
      200: { description: 'TwiML response (application/xml)' },
      403: { description: 'Webhook signature invalid' },
    },
  }),
  async (c) => {
  const url = new URL(c.req.url)
  const hubId = url.searchParams.get('hub') || undefined
  const services = c.get('services')
  const adapter = (await getHubAdapter(c.env, services, hubId))!
  const { digits, callerNumber } = await adapter.parseCaptchaWebhook(c.req.raw)
  const callSid = url.searchParams.get('callSid') || ''
  const callerLang = url.searchParams.get('lang') || DEFAULT_LANGUAGE

  // Look up expected digits from server-side storage (not URL params)
  const { match, expected } = await services.settings.verifyCaptcha({ callSid, digits })

  const response = await adapter.handleCaptchaResponse({ callSid, digits, expectedDigits: expected, callerLanguage: callerLang, hubId })

  if (match) {
    const origin = new URL(c.req.url).origin
    backgroundTask(c,startParallelRinging(callSid, callerNumber, origin, c.env, services, hubId ?? ''))
  }

  return telephonyResponse(response)
})

// --- Step 4: User answered -> bridge via queue ---
telephony.post('/user-answer',
  validateWebhook,
  describeRoute({
    tags: ['Telephony Webhooks'],
    summary: 'Volunteer answered — provider webhook (step 4)',
    description: 'Provider calls this when a volunteer picks up. Resolves opaque call token, bridges caller ↔ volunteer, returns TwiML.',
    responses: {
      200: { description: 'TwiML response (application/xml)' },
      403: { description: 'Invalid or expired call token' },
    },
  }),
  async (c) => {
  const url = new URL(c.req.url)
  const services = c.get('services')

  // CRIT-W2: Resolve volunteer pubkey from the opaque call token and claim the
  // answer. Single-use is enforced by the atomic ringing → in-progress
  // transition on the call row, NOT by deleting the token: the provider also
  // sends this token to /call-status, and the answered leg's later status
  // callbacks (completed) still need it to find their call.
  // CRIT-W1: Hub resolved from DB call record via token, not from URL param
  const callToken = url.searchParams.get('callToken') || ''
  const tokenData = callToken ? await services.calls.answerCallWithToken(callToken) : null
  if (!tokenData) {
    logger.warn('user-answer: invalid, expired or already-used call token', { callToken: callToken.slice(0, 8) })
    return c.json({ error: 'Forbidden' }, 403)
  }
  const { callSid: parentCallSid, volunteerPubkey: pubkey, hubId } = tokenData
  const adapter = (await getHubAdapter(c.env, services, hubId || undefined))!

  // Publish call answered event + presence update
  publishEvent(c.env, KIND_CALL_UPDATE, {
    type: 'call:update',
    callId: parentCallSid,
    status: 'in-progress',
  }, hubId ?? '')

  publishEvent(c.env, KIND_PRESENCE_UPDATE, {
    type: 'presence:summary',
    callId: parentCallSid,
  }, hubId ?? '')

  const [, activeCallsForAnswer] = await Promise.all([
    services.identity.getUser(pubkey).catch(() => ({} as { name?: string })),
    services.calls.getActiveCalls(hubId ?? ''),
  ])
  const callRecord = activeCallsForAnswer.find(call => call.callId === parentCallSid)
  await audit(services.audit, 'callAnswered', pubkey, {
    callerLast4: callRecord?.callerLast4 || '',
  }, undefined, hubId || null)

  const origin = new URL(c.req.url).origin
  const response = await adapter.handleCallAnswered({ parentCallSid, callbackUrl: origin, userPubkey: pubkey, hubId })
  return telephonyResponse(response)
})

// --- Step 5: Call status callback ---
telephony.post('/call-status',
  validateWebhook,
  describeRoute({
    tags: ['Telephony Webhooks'],
    summary: 'Call status callback — provider webhook (step 5)',
    description: 'Receives call status updates (completed, no-answer, busy, failed) from telephony provider. Updates call records and publishes Nostr events.',
    responses: {
      200: { description: 'OK — status recorded' },
      403: { description: 'Webhook signature invalid' },
    },
  }),
  async (c) => {
  const url = new URL(c.req.url)
  const services = c.get('services')

  // CRIT-W2: Resolve volunteer pubkey from opaque call token. Read-only — the
  // provider sends pre-answer status events (initiated/ringing) to this route
  // with the same token /user-answer needs, so a status callback must never
  // consume it. The token lives until the call ends.
  // CRIT-W1: Hub resolved from DB call record, not from URL param
  const callToken = url.searchParams.get('callToken') || ''
  const tokenData = callToken ? await services.calls.resolveCallToken(callToken) : null
  const parentCallSid = tokenData?.callSid || url.searchParams.get('parentCallSid') || ''
  const pubkey = tokenData?.volunteerPubkey || ''
  const hubId = tokenData?.hubId || (await services.calls.getHubIdForCall(parentCallSid)) || undefined
  const adapter = (await getHubAdapter(c.env, services, hubId))!
  const { status: callStatus } = await adapter.parseCallStatusWebhook(c.req.raw)

  logger.info('Call status update', { status: callStatus, parentCallSid, hubId: hubId || 'global' })

  if (callStatus === 'completed' || callStatus === 'busy' || callStatus === 'no-answer' || callStatus === 'failed') {
    if (callStatus === 'completed') {
      const preCalls = await services.calls.getActiveCalls(hubId ?? '')
      const preCall = preCalls.find(call => call.callId === parentCallSid)
      logger.debug('Ending call', { parentCallSid, foundInActive: !!preCall })

      // A leg's `completed` only ends the call when that leg is the one that
      // answered it. Other volunteers' legs (cancelled once someone picked up)
      // carry the same call SID but must not end the bridged call.
      if (tokenData && preCall && preCall.answeredBy !== pubkey) {
        logger.debug('Ignoring completed status from a leg that did not answer the call', { parentCallSid })
        return telephonyResponse(adapter.emptyResponse())
      }

      try {
        await services.calls.endCall(hubId ?? '', parentCallSid)
        logger.debug('Call end result', { parentCallSid, status: 200 })

        // Publish call completed event
        publishEvent(c.env, KIND_CALL_UPDATE, {
          type: 'call:update',
          callId: parentCallSid,
          status: 'completed',
        }, hubId ?? '')

        const duration = preCall
          ? Math.floor((Date.now() - new Date(preCall.startedAt).getTime()) / 1000)
          : undefined
        await audit(services.audit, 'callEnded', pubkey, {
          callerLast4: preCall?.callerLast4 || '',
          duration,
        }, undefined, hubId ?? null)
      } catch {
        logger.debug('Call end result', { parentCallSid, status: 404 })
        // Already ended by /call-recording
      }
    }
  }

  return telephonyResponse(adapter.emptyResponse())
})

// --- Step 6: Wait music for queued callers ---
telephony.all('/wait-music', validateWebhook, async (c) => {
  const url = new URL(c.req.url)
  const hubId = url.searchParams.get('hub') || undefined
  const services = c.get('services')
  const adapter = (await getHubAdapter(c.env, services, hubId))!
  const lang = url.searchParams.get('lang') || DEFAULT_LANGUAGE
  const queueTime = c.req.method === 'POST'
    ? (await adapter.parseQueueWaitWebhook(c.req.raw)).queueTime
    : 0
  const audioUrls = await buildAudioUrlMap(services.settings, new URL(c.req.url).origin)
  const callSettings = await services.settings.getCallSettings(hubId)
  const response = await adapter.handleWaitMusic(lang, audioUrls, queueTime, callSettings.queueTimeoutSeconds)
  return telephonyResponse(response)
})

// --- Step 7: Queue exit -> voicemail if no one answered ---
telephony.post('/queue-exit', validateWebhook, async (c) => {
  const url = new URL(c.req.url)
  const hubId = url.searchParams.get('hub') || undefined
  const services = c.get('services')
  const adapter = (await getHubAdapter(c.env, services, hubId))!
  const { result: queueResult } = await adapter.parseQueueExitWebhook(c.req.raw)
  const callSid = url.searchParams.get('callSid') || ''
  const lang = url.searchParams.get('lang') || DEFAULT_LANGUAGE

  if (queueResult === 'hangup') {
    // Caller hung up while in queue — end the call as unanswered
    try { await services.calls.endCall(hubId ?? '', callSid) } catch { /* already ended */ }
    await audit(services.audit, 'callMissed', 'system', { callSid }, undefined, hubId ?? null)
    return telephonyResponse(adapter.emptyResponse())
  }

  if (queueResult === 'leave' || queueResult === 'queue-full' || queueResult === 'error') {
    const audioUrls = await buildAudioUrlMap(services.settings, new URL(c.req.url).origin)
    const origin = new URL(c.req.url).origin
    const callSettings = await services.settings.getCallSettings(hubId)
    const response = await adapter.handleVoicemail({
      callSid,
      callerLanguage: lang,
      callbackUrl: origin,
      audioUrls,
      maxRecordingSeconds: callSettings.voicemailMaxSeconds,
      hubId,
    })
    return telephonyResponse(response)
  }

  return telephonyResponse(adapter.emptyResponse())
})

// --- Step 8: Voicemail recording complete ---
telephony.post('/voicemail-complete', validateWebhook, async (c) => {
  const url = new URL(c.req.url)
  const hubId = url.searchParams.get('hub') || undefined
  const services = c.get('services')
  const adapter = (await getHubAdapter(c.env, services, hubId))!
  const lang = url.searchParams.get('lang') || DEFAULT_LANGUAGE
  return telephonyResponse(adapter.handleVoicemailComplete(lang))
})

// --- Step 9: Call recording status callback (bridged call recording) ---
telephony.post('/call-recording', validateWebhook, async (c) => {
  const url = new URL(c.req.url)
  const services = c.get('services')

  // CRIT-W1: Hub resolved from DB call record, not from URL param
  // CRIT-W2: Pubkey resolved from active call record (answeredBy), not URL param
  const parentCallSid = url.searchParams.get('parentCallSid') || ''
  const hubId = (await services.calls.getHubIdForCall(parentCallSid)) || undefined
  const adapter = (await getHubAdapter(c.env, services, hubId))!
  const { status: recordingStatus, recordingSid } = await adapter.parseRecordingWebhook(c.req.raw)

  if (recordingStatus === 'completed' && parentCallSid) {
    // Get call info before ending (for audit); also resolves pubkey via answeredBy
    const activeCallsList = await services.calls.getActiveCalls(hubId ?? '')
    const callRecord = activeCallsList.find(call => call.callId === parentCallSid)
    const pubkey = callRecord?.answeredBy ?? ''

    // Recording completed means the bridge ended — end the call
    // (safety net in case /call-status doesn't fire)
    try {
      await services.calls.endCall(hubId ?? '', parentCallSid)
      logger.info('Call recording completed', { parentCallSid, endStatus: 200 })

      if (pubkey) {
        await audit(services.audit, 'callEnded', pubkey, {
          callerLast4: callRecord?.callerLast4 || '',
        }, undefined, hubId ?? null)
      }
    } catch {
      logger.info('Call recording completed', { parentCallSid, endStatus: 404 })
    }

    if (recordingSid) {
      backgroundTask(c,
        maybeTranscribe(parentCallSid, recordingSid, pubkey, c.env, services)
      )
    }
  }

  return telephonyResponse(adapter.emptyResponse())
})

// --- Step 10: Voicemail recording status callback ---
telephony.post('/voicemail-recording', validateWebhook, async (c) => {
  const url = new URL(c.req.url)
  const hubId = url.searchParams.get('hub') || undefined
  const services = c.get('services')
  const adapter = (await getHubAdapter(c.env, services, hubId))!
  const { status: recordingStatus } = await adapter.parseRecordingWebhook(c.req.raw)
  const callSid = url.searchParams.get('callSid') || ''

  if (recordingStatus === 'completed') {
    await services.calls.markVoicemail(hubId ?? '', callSid)

    // Publish voicemail event
    publishEvent(c.env, KIND_CALL_VOICEMAIL, {
      type: 'voicemail:new',
      callId: callSid,
    }, hubId ?? '')

    await audit(services.audit, 'voicemailReceived', 'system', { callSid }, { request: c.req.raw, hmacSecret: c.env.HMAC_SECRET }, hubId ?? null)

    backgroundTask(c,transcribeVoicemail(callSid, c.env, services))
  }

  return telephonyResponse(adapter.emptyResponse())
})

export default telephony
