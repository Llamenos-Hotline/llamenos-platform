import { Hono, type Context, type Next } from 'hono'
import { describeRoute } from 'hono-openapi'
import type { AppEnv } from '../types'
import { getTelephonyFromService, getHubTelephonyFromService } from '../lib/service-factories'
import type { SpeechUrlBuilder, TelephonyAdapter, TelephonyResponse } from '../telephony/adapter'
import { SipBridgeAdapter } from '../telephony/sip-bridge-adapter'
import type { Services } from '../services'
import type { Env } from '../types'
import { buildAudioUrlMap, telephonyResponse } from '../lib/helpers'
import { holdMusicEntry } from '../telephony/hold-music'
import { banHashes, callerRateLimitDigest, getClientIp, sealCallerNumber } from '../lib/crypto'
import { detectLanguageFromPhone, languageFromDigit, DEFAULT_LANGUAGE } from '@shared/languages'
import { audit } from '../services/audit'
import { ServiceError } from '../services/settings'
import { startParallelRinging, cancelLosingLegs } from '../services/ringing'
import { processCallRecording } from '../services/call-recordings'
import { processVoicemailRecording } from '../services/voicemail'
import { publishEvent } from '../lib/ws-events'
import { KIND_CALL_UPDATE, KIND_CALL_VOICEMAIL, KIND_PRESENCE_UPDATE } from '@shared/event-kinds'
import { createLogger } from '../lib/logger'
import { incCounter } from './metrics'
import { backgroundTask } from '../lib/hono-compat'
import { checkWebhookReplay } from '../services/webhook-replay'
import { getDb } from '../db'
import { isIpInCidrs } from '../middleware/webhook-ip-allowlist'
import { webhookAuth } from '../middleware/webhook-auth'
import type { IncidentKind } from '../services/incidents-categories'
import type { OverLimitAction } from '@protocol/schemas/settings'
import { recordTelephonyWebhookRejection } from '../telephony/webhook-rejection'
import { bodyWithinLimit, providerAuthMonitor } from '../services/provider-auth'
import { refuseIfChannelDisabled } from '../messaging/channel-guard'

const logger = createLogger('telephony')

/**
 * What a provider fetches during this call, from the origin it reached us on:
 * operator-uploaded prompts as signed URLs, plus the worker's own hold track
 * (#2298) — so no adapter ever has to name a media host.
 */
async function audioUrlsFor(c: Context<AppEnv>, hubId: string | undefined) {
  const origin = new URL(c.req.url).origin
  return {
    ...(await buildAudioUrlMap(c.get('services').settings, origin, c.env.HMAC_SECRET, hubId)),
    ...holdMusicEntry(origin),
  }
}

/**
 * Generated speech, for a provider with no speech engine of its own (the
 * self-hosted PBXs); cloud providers speak prompts themselves.
 */
async function speechUrlFor(c: Context<AppEnv>, adapter: TelephonyAdapter): Promise<SpeechUrlBuilder | undefined> {
  if (!(adapter instanceof SipBridgeAdapter)) return undefined
  return c.get('services').ivrSpeech.urlBuilder(new URL(c.req.url).origin)
}

/**
 * Where a caller who failed or timed out of the voice CAPTCHA goes: voicemail,
 * never a silent drop (#2302, operator ruling). It goes through the same
 * switch as an over-limit caller, so changing it is this one line.
 */
const CAPTCHA_FAILED_ACTION: OverLimitAction = 'voicemail'

/** The `spam` incident kind each over-limit action is counted under. */
const OVER_LIMIT_INCIDENT_KIND = {
  reject: 'reject',
  message: 'over_limit_message',
  voicemail: 'over_limit_voicemail',
} as const satisfies Record<OverLimitAction, IncidentKind<'spam'>>

/**
 * Tell the hub's `settings:manage-spam` holders that an automatic defence
 * acted (rule V: a refusal nobody can see is a silent drop). Counts only — the
 * signal carries a hub and a kind, never the caller's number or the call SID.
 *
 * A failure here must not cost the caller their response, so it is logged
 * loudly rather than thrown; a call with no hub has nobody to tell.
 */
async function signalSpam(services: Services, hubId: string | undefined, kind: IncidentKind<'spam'>): Promise<void> {
  if (!hubId) {
    logger.warn('Spam defence acted on a call that resolved to no hub — no incident to raise', { kind })
    return
  }
  try {
    await services.incidents.signal(hubId, 'spam', kind)
  } catch (err) {
    logger.error('Spam incident signal failed — this defence is not visible to the hub', { hubId, kind, err })
  }
}

interface RefusedCall {
  callSid: string
  callerNumber: string
  callerLanguage: string
  hubId: string | undefined
}

/**
 * The one code path for a caller the spam defences will not put through to a
 * volunteer: over the per-number limit (the hub's `overLimitAction`), or out
 * of CAPTCHA attempts (`CAPTCHA_FAILED_ACTION`).
 *
 * - `reject`: refuse the call unanswered.
 * - `message`: the greeting and the `rateLimited` prompt — the hub's upload
 *   when there is one, else spoken — then hang up. Nothing is recorded.
 * - `voicemail`: offer voicemail. The call is registered first, exactly as
 *   ringing registers a call that may time out into voicemail, because the
 *   voicemail callback attaches the message to that record.
 */
async function refuseLiveCall(
  c: Context<AppEnv>,
  adapter: TelephonyAdapter,
  action: OverLimitAction,
  call: RefusedCall,
): Promise<TelephonyResponse> {
  const services = c.get('services')
  switch (action) {
    case 'reject':
      return adapter.rejectCall()
    case 'message':
      return adapter.handleIncomingCall({
        callSid: call.callSid,
        callerNumber: call.callerNumber,
        voiceCaptchaEnabled: false,
        rateLimited: true,
        callerLanguage: call.callerLanguage,
        hotlineName: c.env.HOTLINE_NAME || 'Llamenos',
        // Hung up before anyone could answer, so never recorded.
        callRecordingEnabled: false,
        audioUrls: await audioUrlsFor(c, call.hubId),
        speechUrl: await speechUrlFor(c, adapter),
        hubId: call.hubId,
      })
    case 'voicemail': {
      await services.calls.addCall(call.hubId ?? '', {
        callId: call.callSid,
        callerNumberSealed: sealCallerNumber(call.callerNumber, call.callSid, c.env.SERVER_KEK),
        callerLast4: call.callerNumber.slice(-4),
        status: 'ringing',
      })
      const callSettings = await services.settings.getCallSettings(call.hubId)
      return adapter.handleVoicemail({
        callSid: call.callSid,
        callerLanguage: call.callerLanguage,
        callbackUrl: new URL(c.req.url).origin,
        audioUrls: await audioUrlsFor(c, call.hubId),
        speechUrl: await speechUrlFor(c, adapter),
        maxRecordingSeconds: callSettings.voicemailMaxSeconds,
        hubId: call.hubId,
      })
    }
  }
}

const telephony = new Hono<AppEnv>()

// Apply webhook auth middleware to all telephony webhook routes:
// - Content-Type enforcement (form-encoded or JSON depending on provider)
// The IP allowlist (TELEPHONY_WEBHOOK_IPS) is NOT applied here: validateWebhook
// applies it, because a refused source's signature is still evaluated to
// classify the refusal (#2330) — every route below goes through it.
// Replay protection is deliberately skipped here: it runs exactly once, in
// validateWebhook, AFTER the provider signature check. Running it in both
// places inserted the same nonce twice, so every webhook looked like a replay
// of itself and was swallowed with a 200 "OK" (#1036). Running it before the
// signature check would also let unsigned requests burn nonces.
telephony.use('*', webhookAuth({
  provider: 'telephony',
  allowedContentTypes: ['application/x-www-form-urlencoded', 'application/json'],
  skipReplay: true,
  skipIpAllowlist: true,
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

/** Every refusal reads the same — never reveal which check refused, or whether telephony is set up. */
function forbidden(c: Context<AppEnv>) {
  return c.json({ error: 'Forbidden' }, 403)
}

/** How a refused webhook is classified; each is a `provider-auth` incident kind. */
type ProviderAuthRejection =
  | 'ip_rejected'
  | 'signature_invalid'
  | 'own_account_signature_invalid'
  | 'provider_allowlist_stale'

/** Rejections an outsider can produce at will: `record`, escalated only by the traffic discriminator. */
const UNATTRIBUTED_REJECTIONS: ReadonlySet<ProviderAuthRejection> = new Set(['ip_rejected', 'signature_invalid'])

/**
 * The hub a refused webhook is about, determined before authentication: the
 * one its URL names (`?hub=`, or the call `/call-recording` refers to), or —
 * for `/incoming`, whose URL names none — the hub owning the number it was
 * placed to. Only a body already known to be within the limit is parsed.
 * Undefined when nothing resolves to an existing hub: that refusal is then the
 * instance-level counter's to report, and no hub is invented for it.
 */
async function rejectionHub(
  c: Context<AppEnv>,
  adapter: TelephonyAdapter,
  hubId: string | undefined,
  bodyBounded: boolean,
): Promise<string | undefined> {
  const services = c.get('services')
  try {
    if (hubId) {
      const { hub } = await services.settings.getHub(hubId)
      return hub.id
    }
    if (!bodyBounded || !new URL(c.req.url).pathname.endsWith('/incoming')) return undefined
    const { calledNumber } = await adapter.parseIncomingWebhook(c.req.raw)
    if (!calledNumber) return undefined
    const { hub } = await services.settings.getHubByPhone(calledNumber)
    return hub.id
  } catch {
    return undefined
  }
}

/**
 * Make a refused webhook visible to the hub's `provider-auth` holders (#2330,
 * rule V). The incident carries the kind and a count — never the source
 * address, the number or the provider's call id. An unattributed refusal
 * while the hub's accepted traffic has stopped also signals `traffic_stopped`.
 * Never throws: the request is refused whether or not this is recorded.
 */
async function signalProviderAuthRejection(
  c: Context<AppEnv>,
  adapter: TelephonyAdapter,
  hubId: string | undefined,
  kind: ProviderAuthRejection,
  bodyBounded: boolean,
): Promise<void> {
  try {
    const target = await rejectionHub(c, adapter, hubId, bodyBounded)
    if (!target) return
    const incidents = c.get('services').incidents
    if (providerAuthMonitor.admitSignal(target, kind)) {
      await incidents.signal(target, 'provider-auth', kind)
    }
    if (
      UNATTRIBUTED_REJECTIONS.has(kind)
      && providerAuthMonitor.trafficStopped(target)
      && providerAuthMonitor.admitSignal(target, 'traffic_stopped')
    ) {
      await incidents.signal(target, 'provider-auth', 'traffic_stopped')
    }
  } catch (err) {
    logger.error('Could not record a provider-auth incident', { kind, error: err })
  }
}

/**
 * Webhook validation middleware — applied per-route to actual webhook endpoints.
 * NOT a wildcard `use('*')` because authenticated webrtcRoutes are mounted at the
 * same `/telephony` prefix and must not be intercepted by webhook signature checks.
 *
 * W05: Enforces signature validation, IP allowlist (opt-in), and replay protection.
 *
 * #2330: every refusal is classified and, when its hub resolves, made visible
 * as a `provider-auth` incident (services/provider-auth.ts explains the
 * attribution rules). The pre-auth work is bounded: a body over
 * WEBHOOK_BODY_LIMIT_BYTES is refused unread and unhashed, and a source the
 * allowlist refuses is hashed at most once a minute per /24 or /48.
 */
async function validateWebhook(c: Context<AppEnv>, next: Next) {
  const url = new URL(c.req.url)
  logger.debug('Webhook received', { method: c.req.method, path: url.pathname, search: url.search })
  const env = c.env
  const services = c.get('services')

  // For /incoming, we don't know the hub yet — use global adapter for validation
  // For all other routes, hub is in query params — except /call-recording,
  // whose callback carries none (CRIT-W1: its handler resolves the hub from the
  // call record). Its signature is checked with THAT hub's adapter, so the
  // credentials that vouch for the callback are the ones its recording is then
  // fetched and deleted through — and a hub with its own provider account is
  // not refused, which would leave its recordings at the provider, untracked
  // (#2309). A `?hub=` on /call-recording is ignored, never preferred: the
  // handler acts with the call's hub's adapter, so validating with any other
  // hub's credentials would let one hub's account vouch for another hub's call.
  const hubId = url.pathname.endsWith('/call-recording')
    ? (await services.calls.getHubIdForCall(url.searchParams.get('parentCallSid') || '')) || undefined
    : url.searchParams.get('hub') || undefined
  const adapter = await getHubAdapter(env, services, hubId)

  // If no telephony provider is configured, reject with 403 — same as
  // signature validation failure. Never reveal whether telephony is set up.
  if (!adapter) return forbidden(c)

  // W05-H03: IP allowlist (opt-in via TELEPHONY_WEBHOOK_IPS env var).
  // `null` = no allowlist configured: there is no provider-IP evidence, so no
  // refusal can be attributed to our provider by IP (#2330 amendment 2).
  const cidrs = (env as unknown as Record<string, string | undefined>).TELEPHONY_WEBHOOK_IPS
  const cidrList = cidrs ? cidrs.split(',').map(s => s.trim()).filter(Boolean) : []
  const sourceIp = getClientIp(c.req.raw)
  const ipAllowed = cidrList.length > 0 ? !!sourceIp && isIpInCidrs(sourceIp, cidrList) : null

  if (ipAllowed === false) {
    // Refused whatever happens next. The signature is evaluated only to name
    // the cause — a VALID one means the allowlist is stale — and never changes
    // the answer. A source already refused this minute is refused unread.
    logger.warn('Telephony webhook IP not in allowlist')
    if (!providerAuthMonitor.admit(sourceIp, 'ip')) return forbidden(c)
    const bounded = await bodyWithinLimit(c.req.raw)
    const signedByUs = bounded && await adapter.validateWebhook(c.req.raw)
    await signalProviderAuthRejection(c, adapter, hubId, signedByUs ? 'provider_allowlist_stale' : 'ip_rejected', bounded)
    return forbidden(c)
  }

  // From here the source is allowed (or no allowlist is configured) and the
  // signature IS the authentication — damping can gate only the counting.
  if (!(await bodyWithinLimit(c.req.raw))) {
    logger.warn(`Webhook body over the limit for ${url.pathname}`)
    if (providerAuthMonitor.admit(sourceIp, 'signature_invalid')) {
      await signalProviderAuthRejection(c, adapter, hubId, 'signature_invalid', false)
    }
    return forbidden(c)
  }

  // H05: Always validate webhook signatures — no localhost bypass
  const isValid = await adapter.validateWebhook(c.req.raw)
  if (!isValid) {
    logger.error(`Webhook signature FAILED for ${url.pathname}`)
    // Notify-level only as a conjunction: provider egress IP (allowlisted)
    // AND our account id (provider-populated) AND the bad signature.
    const ownAccount = ipAllowed === true && (await adapter.webhookNamesOwnAccount?.(c.req.raw)) === true
    const kind = ownAccount ? 'own_account_signature_invalid' : 'signature_invalid'
    if (providerAuthMonitor.admit(sourceIp, kind)) {
      await signalProviderAuthRejection(c, adapter, hubId, kind, true)
    }
    return forbidden(c)
  }
  if (hubId) providerAuthMonitor.recordAccepted(hubId)

  // W05-H02: Replay protection — hash body to detect duplicate deliveries.
  // Returns idempotent 200 for replays (provider retries stop on 2xx).
  // Keyed on exactly what the provider's signature authenticates, never more:
  // Twilio and Plivo send byte-identical bodies for two genuinely separate
  // events on one call (two CAPTCHA timeouts, the same wrong answer twice),
  // told apart by Twilio's signed URL (its `round`) and Plivo's signed nonce.
  // Anything unsigned in the key would let a captured request be replayed with
  // that part changed.
  const isFirst = await checkWebhookReplay(getDb(), 'telephony', await adapter.webhookReplayKey(c.req.raw), 300)
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
  logger.info('Incoming call', { callSid })

  // Look up which hub owns the called phone number
  let hubId: string | undefined
  if (calledNumber) {
    try {
      const { hub } = await services.settings.getHubByPhone(calledNumber)
      hubId = hub.id
      logger.info('Resolved hub for incoming call', { hubId })
      // `/incoming` names no hub in its URL, so its accepted traffic is
      // attributed here (the provider-auth traffic discriminator, #2330).
      providerAuthMonitor.recordAccepted(hubId)
    } catch {
      // No hub found for this number
    }
  }

  // Use hub-scoped adapter for all subsequent operations
  const adapter = hubId ? ((await getHubTelephonyFromService(c.env, services.settings, hubId)) ?? globalAdapter) : globalAdapter

  // #2309: the provider now keeps a log record of this call, naming the
  // caller's number. Where its API can delete one, it is tracked from the first
  // webhook — banned calls included — and deleted once the call has ended.
  if (adapter.deleteCallLog) {
    await services.providerRecordings.track({ hubId: hubId ?? '', callId: callSid, recordingSid: callSid, kind: 'call-log', adapter })
  }

  // The hub's own voice switch (#2384). Refused before anything rings or is
  // greeted; the caller's network is told the call was rejected (no answer, no
  // charge), and the refusal is signalled to the hub's incident panel. Calls
  // already in progress are not touched: only this first webhook decides.
  if (await refuseIfChannelDisabled(services, hubId, 'voice')) {
    return telephonyResponse(adapter.rejectCall())
  }

  const banned = await services.records.checkBan(banHashes(callerNumber, hubId, c.env.BAN_HASH_KEY), hubId)
  if (banned) {
    await signalSpam(services, hubId, 'ban_match')
    return telephonyResponse(adapter.rejectCall())
  }

  const { enabledLanguages } = await services.settings.getIvrLanguages(hubId)

  const response = await adapter.handleLanguageMenu({
    callSid,
    callerNumber,
    hotlineName: c.env.HOTLINE_NAME || 'Llamenos',
    enabledLanguages,
    hubId,
    speechUrl: await speechUrlFor(c, adapter),
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

  // Bans are enforced when the call is answered (/incoming), but a ban can be added
  // while the caller is still in the language menu. Re-check before greeting or
  // queueing so a newly banned caller never reaches a volunteer.
  if (await services.records.checkBan(banHashes(callerNumber, hubId, c.env.BAN_HASH_KEY), hubId)) {
    await signalSpam(services, hubId, 'ban_match')
    return telephonyResponse(adapter.rejectCall())
  }

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
      key: `phone:${hubId ? `${hubId}:` : ''}${callerRateLimitDigest(callerNumber)}`,
      maxPerMinute: spamSettings.maxCallsPerMinute,
    })
    rateLimited = rlResult.limited
  }

  // Over the per-number limit: the hub's over-limit action, and an incident
  // so the people responsible see it happening. The per-minute verdict comes
  // from the rotating in-memory digest key above; nothing per-number is kept.
  if (rateLimited) {
    const action = spamSettings.overLimitAction
    incCounter('llamenos_call_over_limit_total', { action })
    await signalSpam(services, hubId, OVER_LIMIT_INCIDENT_KIND[action])
    return telephonyResponse(await refuseLiveCall(c, adapter, action, { callSid, callerNumber, callerLanguage, hubId }))
  }

  // Generate CAPTCHA digits server-side with CSPRNG and store them
  let captchaDigits: string | undefined
  if (spamSettings.voiceCaptchaEnabled) {
    const buf = new Uint8Array(2)
    crypto.getRandomValues(buf)
    captchaDigits = String(1000 + (((buf[0] << 8) | buf[1]) % 9000))
    // Store expected digits server-side (not in callback URL)
    await services.settings.storeCaptcha({ callSid, expected: captchaDigits })
  }

  // #1505: whether this hub records answered calls. Read here so the greeting can
  // disclose it to the caller BEFORE they are connected — the same setting is read
  // again at /user-answer to decide whether to actually record, so a caller can
  // never be recorded on a call where they were not told.
  const { recordCalls } = await services.settings.getCallSettings(hubId)

  const audioUrls = await audioUrlsFor(c, hubId)
  const response = await adapter.handleIncomingCall({
    callSid,
    callerNumber,
    voiceCaptchaEnabled: spamSettings.voiceCaptchaEnabled,
    rateLimited: false,
    callerLanguage,
    hotlineName: c.env.HOTLINE_NAME || 'Llamenos',
    callRecordingEnabled: recordCalls === true,
    audioUrls,
    speechUrl: await speechUrlFor(c, adapter),
    captchaDigits,
    hubId,
  })

  if (!spamSettings.voiceCaptchaEnabled) {
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
    description: 'Receives the digits (none on a timeout) from the voice CAPTCHA gather. Classifies them against the server-stored challenge as pass, retry, repeat (star), fail or timeout; a pass is queued for a volunteer, retry and repeat challenge again, fail and timeout go to voicemail.',
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

  // A ban added while the caller was in the menu / CAPTCHA must still take effect.
  if (await services.records.checkBan(banHashes(callerNumber, hubId, c.env.BAN_HASH_KEY), hubId)) {
    await signalSpam(services, hubId, 'ban_match')
    return telephonyResponse(adapter.rejectCall())
  }

  // Classified server-side against the stored challenge (constant-time); the
  // adapter only renders the outcome. No digits = the gather timed out.
  const result = await services.settings.submitCaptcha({ callSid, digits })
  incCounter('llamenos_voice_captcha_total', { outcome: result.outcome })
  const speechUrl = await speechUrlFor(c, adapter)

  switch (result.outcome) {
    case 'pass': {
      // Ringing starts on a pass and on nothing else.
      const origin = new URL(c.req.url).origin
      backgroundTask(c, startParallelRinging(callSid, callerNumber, origin, c.env, services, hubId ?? ''))
      return telephonyResponse(await adapter.handleCaptchaResponse({
        outcome: 'pass', callSid, callerLanguage: callerLang, hubId, audioUrls: await audioUrlsFor(c, hubId), speechUrl,
      }))
    }
    case 'retry':
    case 'repeat':
      return telephonyResponse(await adapter.handleCaptchaResponse({
        outcome: result.outcome,
        digitsToSpeak: result.digitsToSpeak,
        round: result.round,
        callSid,
        callerLanguage: callerLang,
        hubId,
        audioUrls: await audioUrlsFor(c, hubId),
        speechUrl,
      }))
    case 'fail':
    case 'timeout':
      await signalSpam(services, hubId, result.outcome)
      return telephonyResponse(await refuseLiveCall(c, adapter, CAPTCHA_FAILED_ACTION, {
        callSid, callerNumber, callerLanguage: callerLang, hubId,
      }))
  }
})

// --- Step 4: User answered -> bridge via queue ---
telephony.post('/user-answer',
  validateWebhook,
  describeRoute({
    tags: ['Telephony Webhooks'],
    summary: 'Volunteer answered — provider webhook (step 4)',
    description: 'Provider calls this when a volunteer picks up. Resolves opaque call token, bridges caller ↔ volunteer, returns TwiML. A leg that did not win the call — machine-answered, lost the race, bad or expired token — gets TwiML that hangs it up.',
    responses: {
      200: { description: 'TwiML response (application/xml): the bridge, or a hang-up for a leg that did not win' },
    },
  }),
  async (c) => {
  const url = new URL(c.req.url)
  const services = c.get('services')

  // CRIT-W1: Hub resolved from the DB call record via the opaque token, not
  // from a URL param. This lookup is read-only: it only picks the adapter for
  // the hub. The answer is claimed below, and only for a leg that earned it.
  const callToken = url.searchParams.get('callToken') || ''
  const legToken = callToken ? await services.calls.resolveCallToken(callToken) : null
  const adapter = (await getHubAdapter(c.env, services, legToken?.hubId || undefined))!

  // Whoever picks up this leg is a live phone call, not an API client: every
  // refusal below answers with TwiML that ends the leg, never a JSON error the
  // provider would read out to them as "an application error has occurred".
  const refuseLeg = () => telephonyResponse(adapter.hangupResponse())

  const legInfo = await adapter.parseIncomingWebhook(c.req.raw.clone()).catch(() => undefined)

  // A carrier voicemail greeting, an answering machine or a fax "answers" a leg
  // just as a person does — and is usually the first to, when a volunteer's
  // phone is off or out of coverage. It must never claim the call: bridging the
  // caller into it records them on a mailbox outside E2EE, retention and
  // erasure, and cancels every volunteer who really is ringing. End this leg
  // and leave the call ringing for the others.
  if (legInfo?.answeredByMachine) {
    logger.warn('user-answer: leg answered by a machine — not claiming the call', {
      legSid: legInfo.callSid,
      parentCallSid: legToken?.callSid,
    })
    incCounter('llamenos_ring_leg_machine_answer_total')
    return refuseLeg()
  }

  // CRIT-W2: Claim the answer. Single-use is enforced by the atomic
  // ringing → in-progress transition on the call row, NOT by deleting the
  // token: the provider also sends this token to /call-status, and the
  // answered leg's later status callbacks (completed) still need it to find
  // their call.
  const tokenData = callToken ? await services.calls.answerCallWithToken(callToken) : null
  if (!tokenData) {
    // Invalid or expired token, another volunteer already won, or the caller is gone.
    logger.warn('user-answer: invalid, expired or already-used call token — hanging up the leg', { callToken: callToken.slice(0, 8) })
    return refuseLeg()
  }
  const { callSid: parentCallSid, volunteerPubkey: pubkey, hubId } = tokenData

  // Stop every other phone still ringing for this call. The winner's own leg
  // SID is needed so it is not cancelled with the losers; if the provider's
  // webhook does not yield one we cancel nothing (losers then ring out, but can
  // no longer win).
  const winnerLegSid = legInfo?.callSid
  if (winnerLegSid) {
    await cancelLosingLegs(c.env, services, hubId ?? '', parentCallSid, winnerLegSid)
  } else {
    logger.warn('user-answer: winner leg SID not in webhook — not cancelling other legs', { parentCallSid })
  }

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

  const origin = new URL(c.req.url).origin
  // #1505: provider-side recording is opt-in per hub and OFF by default. The
  // caller was told in the greeting (/language-selected reads the same setting),
  // so recording here without disclosure is not reachable.
  const { recordCalls } = await services.settings.getCallSettings(hubId || undefined)
  const response = await adapter.handleCallAnswered({
    parentCallSid,
    callbackUrl: origin,
    userPubkey: pubkey,
    hubId,
    recordCall: recordCalls === true,
  })

  // The audit log is the accountability record: it says a volunteer answered
  // only once the bridge instruction exists, never before it. Anything above
  // that throws leaves the call un-audited instead of audited-but-unbridged.
  await audit(services.audit, 'callAnswered', pubkey, {
    callerLast4: callRecord?.callerLast4 || '',
  }, undefined, hubId || null)

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
  const audioUrls = await audioUrlsFor(c, hubId)
  const callSettings = await services.settings.getCallSettings(hubId)
  const response = await adapter.handleWaitMusic(
    lang,
    audioUrls,
    queueTime,
    callSettings.queueTimeoutSeconds,
    await speechUrlFor(c, adapter),
  )
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
    try {
      await services.calls.endCall(hubId ?? '', callSid)
    } catch (err) {
      // 404 = already ended. Anything else is a real failure and must not be swallowed.
      if (err instanceof ServiceError && err.status === 404) {
        logger.warn('Queue hangup for a call with no active record', { callSid, hubId: hubId || 'global' })
      } else {
        throw err
      }
    }
    await audit(services.audit, 'callMissed', 'system', { callSid }, undefined, hubId ?? null)
    return telephonyResponse(adapter.emptyResponse())
  }

  if (queueResult === 'leave' || queueResult === 'queue-full' || queueResult === 'error') {
    const audioUrls = await audioUrlsFor(c, hubId)
    const origin = new URL(c.req.url).origin
    const callSettings = await services.settings.getCallSettings(hubId)
    const response = await adapter.handleVoicemail({
      callSid,
      callerLanguage: lang,
      callbackUrl: origin,
      audioUrls,
      speechUrl: await speechUrlFor(c, adapter),
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
  return telephonyResponse(adapter.handleVoicemailComplete(lang, await speechUrlFor(c, adapter)))
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
  const { status: recordingStatus, recordingSid, callSid: webhookCallSid } = await adapter.parseRecordingWebhook(c.req.raw)

  if (recordingStatus === 'completed') {
    // #2297/#2309: the provider now holds this call's audio. It is tracked
    // until the provider confirms deleting it — once our own sealed copy is
    // made (below), or by the call record's retention purge or a hub shred —
    // tracked first, before anything below can throw. Without a handle it is tracked
    // as unaddressable residue: the audio exists either way, and an untracked
    // recording is indistinguishable from one that was never made.
    const callId = parentCallSid || webhookCallSid || ''
    if (recordingSid) {
      await services.providerRecordings.track({ hubId: hubId ?? '', callId, recordingSid, kind: 'call', adapter })
    } else {
      await services.providerRecordings.trackUnaddressable({ hubId: hubId ?? '', callId, kind: 'call', adapter })
    }
  }

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
      // #2309: tracked above, before anything could throw. Now copied into our
      // own sealed storage (the playback source), deleted at the provider, and
      // transcribed from our copy. A copy or deletion failure is kept on the
      // ledger and retried by the sweep.
      backgroundTask(c, processCallRecording({
        env: c.env,
        services,
        adapter,
        hubId: hubId ?? '',
        callSid: parentCallSid,
        recordingSid,
        answeredBy: pubkey,
      }).then((outcome) => {
        if (outcome.providerCopy === 'kept') {
          logger.error('Call recording left at the provider: will be retried', { parentCallSid, error: outcome.error })
        }
      }))
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
  const { status: recordingStatus, recordingSid } = await adapter.parseRecordingWebhook(c.req.raw)
  const callSid = url.searchParams.get('callSid') || ''

  if (recordingStatus === 'completed') {
    // #2297: tracked before anything else — markVoicemail below throws for an
    // unknown call, and the provider holds the audio regardless. Tracked
    // synchronously so the handle survives even if the background task does
    // not; the sweep worker finishes a deletion that failed here. Without a
    // handle the recording cannot be fetched or deleted, so it is tracked as
    // unaddressable residue rather than lost.
    if (recordingSid) {
      await services.providerRecordings.track({ hubId: hubId ?? '', callId: callSid, recordingSid, kind: 'voicemail', adapter })
    } else {
      await services.providerRecordings.trackUnaddressable({ hubId: hubId ?? '', callId: callSid, kind: 'voicemail', adapter })
    }

    // Throws 404 if there is no call record at all — that would mean a message was left
    // for a call the hotline never recorded, which must be loud, not silent (#1043).
    await services.calls.markVoicemail(hubId ?? '', callSid)

    // The caller has left a message and is done: close the call so it lands in history as
    // `unanswered` with hasVoicemail=true. (No-op if the caller's leg already ended it.)
    try {
      await services.calls.endCall(hubId ?? '', callSid)
    } catch (err) {
      if (!(err instanceof ServiceError && err.status === 404)) throw err
    }

    // Publish voicemail event
    publishEvent(c.env, KIND_CALL_VOICEMAIL, {
      type: 'voicemail:new',
      callId: callSid,
    }, hubId ?? '')

    await audit(services.audit, 'voicemailReceived', 'system', { callSid }, { request: c.req.raw, hmacSecret: c.env.HMAC_SECRET }, hubId ?? null)

    if (recordingSid) {
      // #2297: fetch, transcribe if enabled, then delete the provider's copy.
      backgroundTask(c, processVoicemailRecording({
        env: c.env,
        services,
        adapter,
        hubId: hubId ?? '',
        callSid,
        recordingSid,
      }).then((outcome) => {
        if (outcome.recordingDeletion === 'failed') {
          logger.error('Voicemail left at the provider: deletion failed, will be retried', { callSid, error: outcome.error })
        }
      }))
    }
  }

  return telephonyResponse(adapter.emptyResponse())
})

export default telephony
