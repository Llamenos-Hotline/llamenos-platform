import type {
  ProviderRecordingPosture,
  ProviderRetentionStatement,
  ProviderSettingEnforcement,
  ProviderSettingReading,
} from '@protocol/schemas/settings'

// --- Webhook result types (provider-agnostic) ---

export interface WebhookCallInfo {
  callSid: string
  callerNumber: string
  /** The called number (To / hotline number) — used for multi-hub routing */
  calledNumber?: string
  /**
   * True when the provider reports that an automated answerer — a carrier
   * voicemail greeting, an answering machine, a fax — picked up an outbound
   * volunteer leg rather than a person. Set only by providers that deliver
   * machine detection on the answer webhook; absent means "not reported", never
   * "human". A leg flagged here must not claim the call.
   */
  answeredByMachine?: boolean
}

export interface WebhookDigits {
  digits: string
}

export interface WebhookCallStatus {
  status: 'initiated' | 'ringing' | 'answered' | 'completed' | 'busy' | 'no-answer' | 'failed'
}

export interface WebhookQueueResult {
  result: 'leave' | 'queue-full' | 'error' | 'bridged' | 'hangup'
}

export interface WebhookQueueWait {
  queueTime: number
}

export interface WebhookRecordingStatus {
  status: 'completed' | 'failed'
  recordingSid?: string
  callSid?: string
}

/**
 * TelephonyAdapter — abstract interface for telephony providers.
 * All telephony logic goes through this adapter.
 * Twilio is the first implementation; designed for future provider swaps (e.g., SIP trunks).
 */
export interface TelephonyAdapter {
  /**
   * Generate the language selection IVR menu.
   * Plays each supported language option in its native voice, waits for a digit press.
   */
  handleLanguageMenu(params: LanguageMenuParams): Promise<TelephonyResponse>

  /**
   * Generate response for the main call flow (after language is known).
   * Handles rate-limiting rejection, voice CAPTCHA, or enqueue-and-hold.
   */
  handleIncomingCall(params: IncomingCallParams): Promise<TelephonyResponse>

  /**
   * Generate response for a classified CAPTCHA submission — see `CaptchaResponseParams`.
   */
  handleCaptchaResponse(params: CaptchaResponseParams): Promise<TelephonyResponse>

  /**
   * Generate response when a volunteer answers — bridge the call via queue.
   */
  handleCallAnswered(params: CallAnsweredParams): Promise<TelephonyResponse>

  /**
   * Generate voicemail prompt when no volunteer answers.
   * Records caller's message for later transcription.
   */
  handleVoicemail(params: VoicemailParams): Promise<TelephonyResponse>

  /**
   * Generate hold music / wait message for callers in queue.
   * When queueTime exceeds threshold, returns <Leave/> to trigger voicemail.
   */
  handleWaitMusic(
    lang: string,
    audioUrls?: AudioUrlMap,
    queueTime?: number,
    queueTimeout?: number,
    speechUrl?: SpeechUrlBuilder,
  ): Promise<TelephonyResponse>

  /**
   * Reject a banned/blocked caller.
   */
  rejectCall(): TelephonyResponse

  /**
   * Response for a webhook whose call leg must be ended immediately — e.g. a
   * volunteer who picked up after another volunteer already won the call.
   * Unlike rejectCall (a pre-answer rejection of a caller), this terminates a
   * leg that has already been answered.
   */
  hangupResponse(): TelephonyResponse

  /**
   * End/hangup a call by its SID.
   *
   * Resolves once the provider confirms the leg is disconnected (or no longer
   * exists). MUST reject when the provider refuses or is unreachable — callers
   * report the outcome to the volunteer and must not claim a disconnect that
   * did not happen.
   */
  hangupCall(callSid: string): Promise<void>

  /**
   * Initiate parallel outbound calls to volunteers' phones.
   */
  ringVolunteers(params: RingVolunteersParams): Promise<string[]>

  /**
   * Cancel ringing for all volunteers except the one who answered.
   */
  cancelRinging(callSids: string[], exceptSid?: string): Promise<void>

  /**
   * Validate that a webhook request is authentic (from the telephony provider).
   */
  validateWebhook(request: Request): Promise<boolean>

  /**
   * The request material this provider's signature authenticates, as the key
   * replay protection records. A replay repeats it exactly; two genuinely
   * separate events differ in it — even when their bodies are byte-identical,
   * as Twilio's and Plivo's are for two CAPTCHA timeouts on one call.
   *
   * Never include anything the signature does not cover: an attacker could
   * vary it to make a captured request look new.
   */
  webhookReplayKey(request: Request): Promise<string>

  /**
   * Whether a webhook names OUR provider account in the part of the request the
   * provider itself fills in (e.g. Twilio's `AccountSid`). Used only to
   * classify a request whose signature already failed (#2330): the identifier
   * is public, so it is evidence of attribution, never of authenticity.
   *
   * Optional, and absent where the provider puts no account identifier in its
   * webhooks. A missing method reads as "no": such requests are `unattributed`,
   * which the alert rules still cover through the inbound-traffic backstop.
   * Must be cheap and must not read an unbounded body.
   */
  webhookNamesOwnAccount?(request: Request): Promise<boolean>

  /**
   * Get call recording/audio for transcription by call SID.
   */
  getCallRecording(callSid: string): Promise<ArrayBuffer | null>

  /**
   * Get recording audio directly by recording SID.
   *
   * `recordingSid` is the handle `parseRecordingWebhook` returned — opaque to
   * business logic; each adapter decides what it encodes.
   */
  getRecordingAudio(recordingSid: string): Promise<ArrayBuffer | null>

  /**
   * Delete a recording AT THE PROVIDER (#2297). Caller audio on a provider's
   * disk is outside the E2EE boundary and outside GDPR erasure, so every
   * recording the provider makes for us is fetched and then deleted there.
   *
   * `recordingSid` is the handle `parseRecordingWebhook` returned.
   *
   * Resolves only once the provider confirms the recording is gone, or reports
   * it no longer exists (a 404 — deleted earlier, or expired). MUST reject in
   * every other case — refused, unreachable, unauthorised, unsupported. A
   * silent no-op here reads to every caller as "deleted", which is worse than
   * an error: the caller stops tracking audio the provider still holds.
   */
  deleteRecording(recordingSid: string): Promise<void>

  /**
   * A stable identifier of the provider ACCOUNT this adapter talks to (an
   * account SID, auth id, account id, application or connection id, bridge
   * URL). A recording is bound to the account that made it: deleting through a
   * different account would get a 404 for a handle it never issued and report
   * "already deleted" while the audio stays where it was.
   *
   * NEVER a credential (API key, token, secret): it is stored, as a SHA-256
   * fingerprint, and a fast hash of a secret is a stored password hash.
   */
  providerAccountId(): string

  /**
   * Read, with this hub's provider credentials, whether the provider is
   * recording or transcribing calls on its own — anything this server did not
   * request (#1505). Each reading is evidence-backed: a setting this probe
   * could not read is reported `unknown` with the reason, never `off`.
   *
   * MUST NOT throw for a provider-side failure: an unreadable setting is a
   * reading (`unknown`), not an error.
   */
  probeRecordingPosture(context: RecordingPostureContext): Promise<ProviderRecordingPosture>

  /**
   * Turn OFF, with this hub's provider credentials, every provider-side
   * recording and transcription setting the provider's API lets us change
   * (#2309) — the write companion of `probeRecordingPosture`. Returns one
   * entry per setting touched or considered: `disabled`/`already-off` with
   * evidence, `not-settable` with the reason the API offers no write, or
   * `failed` with the provider's answer. Never `disabled` without the
   * provider's acceptance; the caller re-probes afterwards.
   *
   * MUST NOT throw for a provider-side failure: a refused write is a `failed`
   * entry, not an error.
   */
  enforceRecordingPosture(): Promise<ProviderSettingEnforcement[]>

  /**
   * What this provider keeps about a call beyond its recordings — call
   * detail records, logs, message bodies — and which of it this server
   * deletes (#2309). Static, from the provider's documentation: anything this
   * server cannot remove is NAMED in `retained`, never left out.
   */
  providerRetention(): ProviderRetentionStatement

  /**
   * Delete the provider's own log record of one call leg — its call detail
   * record, which names the caller's or a rung volunteer's number (#2309).
   * Present ONLY on adapters whose provider documents such a deletion; an
   * adapter without it says so in `providerRetention().retained`, and the
   * server does not track its call legs.
   *
   * Same contract as `deleteRecording`: resolves on confirmed deletion or a
   * 404, rejects in every other case (including a call still in progress).
   */
  deleteCallLog?(callSid: string): Promise<void>

  // --- Webhook parsing (provider-specific field names → agnostic types) ---

  /** Parse incoming call webhook (CallSid, From) */
  parseIncomingWebhook(request: Request): Promise<WebhookCallInfo>

  /** Parse language selection webhook (CallSid, From, Digits) */
  parseLanguageWebhook(request: Request): Promise<WebhookCallInfo & WebhookDigits>

  /** Parse CAPTCHA response webhook (Digits, From) */
  parseCaptchaWebhook(request: Request): Promise<WebhookDigits & { callerNumber: string }>

  /** Parse call status callback (CallStatus) */
  parseCallStatusWebhook(request: Request): Promise<WebhookCallStatus>

  /** Parse queue wait webhook (QueueTime) */
  parseQueueWaitWebhook(request: Request): Promise<WebhookQueueWait>

  /** Parse queue exit webhook (QueueResult) */
  parseQueueExitWebhook(request: Request): Promise<WebhookQueueResult>

  /** Parse recording status webhook (RecordingStatus) */
  parseRecordingWebhook(request: Request): Promise<WebhookRecordingStatus>

  // --- Additional response methods ---

  /** Thank the caller after voicemail recording and hang up */
  handleVoicemailComplete(lang: string, speechUrl?: SpeechUrlBuilder): TelephonyResponse

  /** Return an empty/no-op response */
  emptyResponse(): TelephonyResponse
}

export interface LanguageMenuParams {
  callSid: string
  callerNumber: string
  hotlineName: string
  enabledLanguages: string[]
  /** Hub ID for multi-hub routing — appended to callback URLs as &hub= */
  hubId?: string
  speechUrl?: SpeechUrlBuilder
}

export interface IncomingCallParams {
  callSid: string
  callerNumber: string
  voiceCaptchaEnabled: boolean
  /**
   * Render the over-limit `message` outcome: the greeting, then the
   * `rateLimited` prompt (the hub's upload if any, else spoken), nothing
   * recorded, then hang up. Set only by the route's over-limit switch.
   */
  rateLimited: boolean
  callerLanguage: string
  hotlineName: string
  /**
   * Whether this hub records answered calls (`callSettings.recordCalls`).
   * When true the greeting MUST disclose it to the caller before they can be
   * connected — see #1505. Required, not optional: a legal notice that a call
   * site can forget to pass is a notice that will eventually go missing.
   *
   * This is the same value the route passes as `CallAnsweredParams.recordCall`,
   * read once per call, so the notice and the recording cannot disagree.
   */
  callRecordingEnabled: boolean
  audioUrls?: AudioUrlMap
  /** Pre-generated CAPTCHA digits (generated server-side with CSPRNG) */
  captchaDigits?: string
  /** Hub ID for multi-hub routing — appended to callback URLs as &hub= */
  hubId?: string
  speechUrl?: SpeechUrlBuilder
}

/**
 * How to answer one CAPTCHA submission. The server has already classified it
 * (`submitCaptcha`, a constant-time compare): an adapter renders the outcome
 * and never sees or compares the expected answer itself.
 *
 * - `pass`: thank the caller and queue them for a volunteer.
 * - `retry`: say `captchaRetry`, then challenge again with the same digits.
 * - `repeat`: the caller pressed star — challenge again with the same digits.
 *
 * A challenge always offers the star hint (`captchaRepeatHint`), and its
 * no-input timeout always reaches `/api/telephony/captcha` with no digits, so
 * the server can count it and give the caller their second attempt.
 * Terminal failures (`fail`, `timeout`) never reach an adapter here: the route
 * hands them to the same over-limit switch every refused caller goes through.
 */
export type CaptchaResponseParams = {
  callSid: string
  callerLanguage: string
  /** Hub ID for multi-hub routing — appended to callback URLs as &hub= */
  hubId?: string
  audioUrls?: AudioUrlMap
  speechUrl?: SpeechUrlBuilder
} & (
  | { outcome: 'pass' }
  | {
      outcome: 'retry' | 'repeat'
      digitsToSpeak: string
      /**
       * Which challenge this is (the first is 0), carried as `&round=` on the
       * gather's callback URL. Twilio and Plivo post byte-identical bodies for
       * two identical submissions — two timeouts, the same wrong answer — and
       * replay protection keys on the URL and the body, so without it the
       * second would be dropped as a replay of the first.
       */
      round: number
    }
)

export interface CallAnsweredParams {
  /** The incoming call SID, used as the queue name to bridge caller → volunteer */
  parentCallSid: string
  /**
   * Whether to record this call at the telephony provider
   * (`callSettings.recordCalls`, default false — #1505).
   *
   * Required, not optional: provider-side recording writes crisis-call audio to
   * a third party's disk, so no adapter and no call site may fall into it by
   * omission. When false, the adapter MUST emit no recording directive at all.
   *
   * Does not apply to voicemail: `handleVoicemail`'s record step is
   * caller-initiated and stays unconditional.
   */
  recordCall: boolean
  /** Origin URL for recording status callbacks */
  callbackUrl: string
  /**
   * User pubkey — kept for audit trail in the route layer.
   * CRIT-W2: Recording callback URL no longer embeds pubkey; hub is resolved from DB (CRIT-W1).
   */
  userPubkey: string
  /** Hub ID — no longer embedded in recording callback URL (CRIT-W1); resolved from DB instead */
  hubId?: string
}

export interface VoicemailParams {
  callSid: string
  callerLanguage: string
  callbackUrl: string
  audioUrls?: AudioUrlMap
  maxRecordingSeconds?: number
  /** Hub ID for multi-hub routing — appended to callback URLs as &hub= */
  hubId?: string
  speechUrl?: SpeechUrlBuilder
}

export interface RingVolunteersParams {
  callSid: string
  callerNumber: string
  /**
   * CRIT-W2: callToken replaces pubkey in callback URLs.
   * Each volunteer gets a unique opaque single-use token that is resolved to their pubkey server-side.
   */
  volunteers: Array<{ phone: string; callToken: string }>
  /**
   * Volunteers whose in-app SIP endpoint is registered and reachable on the
   * PBX we run: one more parallel leg each, dialled as an INVITE to their AOR
   * instead of an outbound call to a phone number. Same first-pickup-wins
   * registry and the same `cancelRinging`, so whichever leg answers cancels
   * the rest — including a volunteer's own other leg.
   *
   * Only the self-hosted registrar can produce these (see
   * `listReachableVolunteerEndpoints`): reachability is read from our own
   * PBX, and no vendor has a per-volunteer AOR to dial. Adapters for vendor
   * providers therefore never receive a non-empty list.
   */
  appTargets?: Array<{ sipAor: string; callToken: string }>
  callbackUrl: string
  /**
   * Hub ID — no longer embedded in callback URLs as ?hub= (CRIT-W1).
   * Retained for adapter internals (e.g. Asterisk bridge selection).
   */
  hubId?: string
}

export interface TelephonyResponse {
  contentType: string
  body: string
  status?: number
}

/** Map of "promptType:language" -> audio URL for custom recordings */
export type AudioUrlMap = Record<string, string>

/**
 * URLs of speech in `locale` from the worker's own speech engine
 * (IvrSpeechService) — for the self-hosted PBXs, which cannot speak a prompt
 * themselves. Cloud providers speak with their own engines and ignore it.
 */
export interface SpeechUrlBuilder {
  /**
   * `text` spoken. The text can be read back out of the URL, which the PBX
   * fetches through the request log and keys its media cache on — so only
   * text any caller hears by dialling in.
   */
  (text: string, locale: string): string
  /**
   * One digit of a voice CAPTCHA spoken. The URL does not reveal the digit
   * (#1352): the challenge is the answer, and must not be readable from a log.
   */
  captchaDigit(digit: string, locale: string): string
}

/** What the recording-posture probe needs to know from this server. */
export interface RecordingPostureContext {
  /**
   * Of these recording handles (in the form `parseRecordingWebhook` returns),
   * the ones this server requested and still tracks as held at the provider —
   * across every hub, since hubs may share one provider account.
   */
  trackedRecordings(handles: string[]): Promise<Set<string>>
}

/**
 * Thrown by `deleteRecording` when the provider did not confirm the deletion.
 * Carries the provider's own status so the refusal can be recorded verbatim.
 */
export class ProviderRecordingDeleteError extends Error {
  constructor(
    public readonly provider: string,
    public readonly status: number | null,
    detail: string,
  ) {
    super(`${provider} recording deletion failed${status !== null ? `: ${status}` : ''}${detail ? ` ${detail.slice(0, 200)}` : ''}`)
    this.name = 'ProviderRecordingDeleteError'
  }
}

/**
 * Shared post-condition for `TelephonyAdapter.deleteRecording` REST
 * implementations: a 2xx means the provider deleted it, a 404 means it is
 * already gone. Anything else throws — the recording must stay tracked.
 */
export async function assertRecordingDeleted(res: Response, provider: string): Promise<void> {
  if (res.ok || res.status === 404) return
  const detail = await res.text().catch(() => '')
  throw new ProviderRecordingDeleteError(provider, res.status, detail)
}

/**
 * Thrown by `deleteCallLog` when the provider did not confirm the deletion.
 */
export class ProviderCallLogDeleteError extends Error {
  constructor(
    public readonly provider: string,
    public readonly status: number | null,
    detail: string,
  ) {
    super(`${provider} call log deletion failed${status !== null ? `: ${status}` : ''}${detail ? ` ${detail.slice(0, 200)}` : ''}`)
    this.name = 'ProviderCallLogDeleteError'
  }
}

/** Post-condition for `deleteCallLog`: 2xx deleted, 404 already gone, anything else throws. */
export async function assertCallLogDeleted(res: Response, provider: string): Promise<void> {
  if (res.ok || res.status === 404) return
  const detail = await res.text().catch(() => '')
  throw new ProviderCallLogDeleteError(provider, res.status, detail)
}

/** A provider-side write that failed, as an enforcement entry. */
export function enforcementFailed(
  setting: ProviderSettingEnforcement['setting'],
  target: string,
  provider: string,
  cause: Response | unknown,
): ProviderSettingEnforcement {
  const why = cause instanceof Response
    ? `${provider} answered ${cause.status}`
    : `${provider} could not be reached (${cause instanceof Error ? cause.message : String(cause)})`
  return { setting, target, outcome: 'failed', reason: `could not turn off ${target}: ${why}` }
}

/**
 * A recording younger than this may simply not have reached our webhook yet,
 * so the inventory check cannot tell "requested, callback in flight" from
 * "never requested". It is left out of the comparison and said so.
 */
export const RECORDING_IN_FLIGHT_MS = 15 * 60 * 1000

/** A provider-side read that failed, as a reading: `unknown`, with why. */
export function unreadable(provider: string, what: string, cause: Response | unknown): Extract<ProviderSettingReading, { state: 'unknown' }> {
  const why = cause instanceof Response
    ? `${provider} answered ${cause.status}`
    : `${provider} could not be reached (${cause instanceof Error ? cause.message : String(cause)})`
  return { state: 'unknown', reason: `could not read ${what}: ${why}` }
}

/**
 * Compare what the provider holds with what this server requested. Anything
 * the provider holds that this server did not ask for means the provider is
 * recording (or transcribing) on its own.
 */
export async function inventoryReading(params: {
  provider: string
  /** What is being inventoried, e.g. "recordings", "transcriptions". */
  what: string
  /** Where it was read from, for the evidence string. */
  source: string
  listed: Array<{ handle: string; createdAt?: Date | null }>
  context: RecordingPostureContext
  now?: number
}): Promise<ProviderSettingReading> {
  const now = params.now ?? Date.now()
  const settled = params.listed.filter(r => !r.createdAt || now - r.createdAt.getTime() >= RECORDING_IN_FLIGHT_MS)
  const inFlight = params.listed.length - settled.length
  const tracked = settled.length > 0 ? await params.context.trackedRecordings(settled.map(r => r.handle)) : new Set<string>()
  const unrequested = settled.filter(r => !tracked.has(r.handle))
  const recent = inFlight > 0 ? ` (${inFlight} younger than ${RECORDING_IN_FLIGHT_MS / 60000} min not judged)` : ''
  if (unrequested.length > 0) {
    return {
      state: 'on',
      evidence: `${params.source}: ${params.provider} holds ${unrequested.length} ${params.what} this server never requested${recent}`,
    }
  }
  return {
    state: 'off',
    evidence: `${params.source}: ${settled.length} ${params.what} listed, none this server did not request${recent}`,
  }
}

/**
 * Fold several readings of one setting: any `on` wins; otherwise any `unknown`
 * makes the whole `unknown` — one unreadable check means the setting was not
 * fully read, so it cannot be reported `off`.
 */
export function combineReadings(readings: ProviderSettingReading[]): ProviderSettingReading {
  const on = readings.filter((r): r is Extract<ProviderSettingReading, { state: 'on' }> => r.state === 'on')
  if (on.length > 0) return { state: 'on', evidence: on.map(r => r.evidence).join('; ') }
  const unknown = readings.filter((r): r is Extract<ProviderSettingReading, { state: 'unknown' }> => r.state === 'unknown')
  if (unknown.length > 0 || readings.length === 0) {
    return { state: 'unknown', reason: unknown.length > 0 ? unknown.map(r => r.reason).join('; ') : 'nothing was read' }
  }
  return {
    state: 'off',
    evidence: readings.map(r => (r as Extract<ProviderSettingReading, { state: 'off' }>).evidence).join('; '),
  }
}

/**
 * Shared post-condition for `TelephonyAdapter.hangupCall` REST implementations:
 * a 2xx means the provider ended the leg, a 404 means the leg is already gone
 * (the caller hung up first) — both are a disconnected call. Anything else is a
 * failure the caller must see.
 */
export async function assertHangupResponse(res: Response, provider: string): Promise<void> {
  if (res.ok || res.status === 404) return
  const detail = await res.text().catch(() => '')
  throw new Error(`${provider} hangup failed: ${res.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`)
}

/**
 * Thrown by `ringVolunteers` when EVERY per-volunteer dial attempt failed — a total
 * provider outage, not a partial one. Distinguishing "all legs failed" from "some legs
 * failed" matters: a partial failure (some volunteers unreachable, others rung fine) is
 * normal and must not trip the circuit breaker or retry the whole batch (the volunteers
 * who WERE reached must not be re-dialled). A total failure means the provider is down
 * and the caller — services/ringing.ts — must retry, trip the breaker on repeated
 * failure, and report the ring as failed rather than claiming success (#1136).
 */
export class AllDialsFailedError extends Error {
  constructor(public readonly attempted: number) {
    super(`All ${attempted} dial attempt(s) failed`)
    this.name = 'AllDialsFailedError'
  }
}

/**
 * Collect the call/leg SIDs from a `Promise.allSettled` of per-volunteer dial attempts.
 * Each individual failure is logged (so a specific bad number is diagnosable), but this
 * only throws when NONE of the attempts succeeded. A partial failure returns whatever
 * did succeed — ringing fewer legs than requested is not the same event as ringing none
 * (#1136).
 */
export function collectRingResults(
  results: PromiseSettledResult<string>[],
  provider: string,
  logFailure: (message: string, err: unknown) => void,
): string[] {
  const sids: string[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') {
      sids.push(result.value)
    } else {
      logFailure(`${provider}: failed to dial a volunteer`, result.reason)
    }
  }
  if (sids.length === 0 && results.length > 0) {
    throw new AllDialsFailedError(results.length)
  }
  return sids
}
