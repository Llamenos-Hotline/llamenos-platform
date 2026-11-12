/**
 * MockTelephonyAdapter — a TelephonyAdapter that talks to no provider.
 *
 * Exists so a test instance with no PSTN number can still exercise the
 * product's core loop (ring → answer → note) end to end. It is selected per hub
 * exactly like the real providers (a `provider_configs` row with type `mock`),
 * and it is driven through the REAL routing path — the same ban check, shift /
 * ring-group resolution and `call:ring` event the webhook flow uses.
 *
 * SAFETY: constructing it is refused unless this host may serve the
 * `/api/test-*` surface at all — `devSurfacesEnabled` (lib/dev-surfaces.ts):
 * `ENVIRONMENT` on the `development`/`staging` allowlist with `production`
 * refused first and unconditionally, `DEV_ROUTES_ENABLED=true`, and a
 * 32-character `DEV_RESET_SECRET` on anything but `development`.
 *
 * Until #1604 the gate was `DEMO_MODE=true` plus
 * `DEMO_MODE_CONFIRM=DESTROY_ALL_DATA` on a `development|staging|demo`
 * environment. Demo mode is gone — there is no demo product, only the secure
 * hosted shape and the self-hosted one — and the mock is a TEST affordance, not
 * part of either. `devSurfacesEnabled` is where a test affordance belongs: it is
 * the same declaration ("this host is a test target") that already opens the
 * destructive reset, it refuses `production` ahead of any flag, and unlike
 * `DEMO_MODE` it is not satisfiable by one environment variable alone.
 *
 * This is a HOST-level predicate with no per-request secret: these are ordinary
 * admin-authenticated hub routes (`routes/simulated-telephony.ts`), not
 * `/api/test-*`, so the authority they grant is already bounded by
 * `settings:manage-telephony` on the caller. What `devSurfacesEnabled` decides
 * is only whether the mock provider is selectable here at all.
 *
 * Inbound webhooks are accepted only when the admin who selected the mock also
 * gave it a webhook signing secret (`authToken`, the role Twilio's auth token
 * plays): each one must carry `X-Mock-Signature`, an HMAC-SHA256 of the signed
 * URL and the raw body under that secret. That is what lets a test act as the
 * provider and drive the REAL webhook chain — /incoming → /language-selected →
 * /user-answer → /call-status → /queue-exit — through the same signature
 * middleware and handlers a real provider's webhooks take (#1052). Without a
 * secret `validateWebhook` is false, as it always was: calls are then injected
 * only by the admin-only simulated-telephony routes, and no unauthenticated
 * request can conjure one either way.
 *
 * What the mock "provider" was asked to do — which legs it dialled, the callback
 * URLs it would have fetched for each, which legs it was told to cancel and which
 * calls to hang up — is kept in a bounded process-wide trace (`mockCallTrace`),
 * because the adapter itself is rebuilt on every resolve. A test reads it through
 * the admin-only `/simulated-telephony/calls/:callId/provider-trace` route: it is
 * the provider-side half of first-pickup-wins, which no server table records.
 */
import { createHmac } from 'node:crypto'
import { devSurfacesRefusal, type DevSurfacesEnv } from '../lib/dev-surfaces'
import { timingSafeCompare } from '../lib/timing-safe'
import { buildWebhookUrl } from '../lib/webhook-url'
import type {
  TelephonyAdapter,
  TelephonyResponse,
  LanguageMenuParams,
  IncomingCallParams,
  CaptchaResponseParams,
  CallAnsweredParams,
  VoicemailParams,
  RingVolunteersParams,
  AudioUrlMap,
  WebhookCallInfo,
  WebhookDigits,
  WebhookCallStatus,
  WebhookQueueResult,
  WebhookQueueWait,
  WebhookRecordingStatus,
  RecordingPostureContext,
} from './adapter'
import { ProviderRecordingDeleteError } from './adapter'
import type {
  ProviderRecordingPosture,
  ProviderRetentionStatement,
  ProviderSettingEnforcement,
} from '@protocol/schemas/settings'

/** Value stored in `provider_configs.provider_type` when a hub uses the mock. */
export const MOCK_PROVIDER_TYPE = 'mock'

/**
 * A recording handle with this prefix is one the mock REFUSES to delete — it
 * stands in for a provider that refuses or cannot be reached, so the
 * fail-loud deletion path can be driven end to end.
 */
export const MOCK_UNDELETABLE_RECORDING_PREFIX = 'mock-undeletable-'

/**
 * Undeletable handles whose provider has since "recovered". A refusal that never
 * lifts leaves a hub that cannot be deleted — correctly, since #2364 refuses to
 * destroy the credentials while the provider still holds caller audio — so a
 * test that drives a refusal needs the provider to come back before it tears the
 * hub down. Process-wide because the adapter is rebuilt on every resolve.
 */
const recoveredRecordings = new Set<string>()

/** The simulated provider stops refusing this handle; its next deletion succeeds. */
export function recoverMockRecording(recordingSid: string): void {
  recoveredRecordings.add(recordingSid)
}

/** Prefix of every call SID minted by the mock — lets routes refuse to touch real calls. */
export const MOCK_CALL_SID_PREFIX = 'mock-call-'

export type MockTelephonyEnv = DevSurfacesEnv

export class MockTelephonyRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`MockTelephonyAdapter refused: ${reason}`)
    this.name = 'MockTelephonyRefusedError'
  }
}

/** True when a stored provider config selects the mock. */
export function isMockProviderConfig(config: { type: string }): boolean {
  return config.type === MOCK_PROVIDER_TYPE
}

/**
 * Returns why the mock may not be used on this host, or null when it may.
 *
 * One delegation, not a second copy of the rules: `devSurfacesRefusal` already
 * refuses `production` first and unconditionally, refuses anything not on the
 * allowlist, demands the explicit flag, and demands a 32-character secret on
 * every reachable host.
 */
export function mockTelephonyRefusalReason(env: MockTelephonyEnv): string | null {
  return devSurfacesRefusal(env)
}

export function isMockTelephonyAllowed(env: MockTelephonyEnv): boolean {
  return mockTelephonyRefusalReason(env) === null
}

/** Throws MockTelephonyRefusedError unless the mock may be used in this environment. */
export function assertMockTelephonyAllowed(env: MockTelephonyEnv): void {
  const reason = mockTelephonyRefusalReason(env)
  if (reason) throw new MockTelephonyRefusedError(reason)
}

/** Header carrying a mock-provider webhook's signature (hex HMAC-SHA256). */
export const MOCK_SIGNATURE_HEADER = 'X-Mock-Signature'

/**
 * The string a mock-provider webhook signs: the signed URL (query included),
 * a newline, then the raw body. Exported so the signer and the verifier are one
 * definition.
 */
export function mockSigningInput(url: string, body: string): string {
  return `${url}\n${body}`
}

/** Hex HMAC-SHA256 of `mockSigningInput(url, body)` under the hub's mock webhook secret. */
export function mockWebhookSignature(secret: string, url: string, body: string): string {
  return createHmac('sha256', secret).update(mockSigningInput(url, body)).digest('hex')
}

/** One leg the mock "dialled" for a call — what a real provider would hold for it. */
export interface MockDialledLeg {
  legSid: string
  /** The volunteer number the leg was placed to. */
  to: string
  /** The URL the provider fetches when the leg is answered (carries the leg's call token). */
  answerUrl: string
  /** The URL the provider posts the leg's status events to. */
  statusUrl: string
}

/** Everything the mock provider was asked to do for one parent call. */
export interface MockCallTrace {
  hubId: string
  callSid: string
  legs: MockDialledLeg[]
  /** Leg SIDs the server told the provider to stop ringing, in order. */
  cancelledLegSids: string[]
  /** Whether the server told the provider to hang the parent call up. */
  hungUp: boolean
}

const MAX_TRACED_CALLS = 200
const callTraces = new Map<string, MockCallTrace>()

function traceFor(callSid: string, hubId: string): MockCallTrace {
  let trace = callTraces.get(callSid)
  if (!trace) {
    trace = { hubId, callSid, legs: [], cancelledLegSids: [], hungUp: false }
    callTraces.set(callSid, trace)
    if (callTraces.size > MAX_TRACED_CALLS) {
      const oldest = callTraces.keys().next().value
      if (oldest !== undefined) callTraces.delete(oldest)
    }
  }
  return trace
}

/** What the mock provider was asked to do for this call, if it was asked anything. */
export function mockCallTrace(callSid: string): MockCallTrace | undefined {
  return callTraces.get(callSid)
}

/** Every provider-facing action the mock performed (bounded; for inspection in tests). */
export type MockTelephonyAction =
  | { type: 'ring'; callSid: string; legs: number }
  | { type: 'hangup'; callSid: string }
  | { type: 'cancel-ringing'; callSids: string[]; exceptSid?: string }
  | { type: 'delete-recording'; recordingSid: string }

const MAX_RECORDED_ACTIONS = 100

function mockResponse(action: string, extra: Record<string, unknown> = {}): TelephonyResponse {
  return { contentType: 'application/json', body: JSON.stringify({ mock: true, action, ...extra }) }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.clone().json()
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export class MockTelephonyAdapter implements TelephonyAdapter {
  readonly actions: MockTelephonyAction[] = []

  /**
   * @param env   Environment gate — construction throws MockTelephonyRefusedError when the mock is not allowed.
   * @param phoneNumber The (fictional) hotline number this mock answers for.
   * @param webhookSecret The secret inbound webhooks are signed with; none means none are accepted.
   * @param webhookBaseUrl The public origin webhooks are signed over (WEBHOOK_BASE_URL), as for real providers.
   */
  constructor(
    env: MockTelephonyEnv,
    readonly phoneNumber: string,
    private readonly webhookSecret = '',
    private readonly webhookBaseUrl = '',
  ) {
    assertMockTelephonyAllowed(env)
  }

  /** The signed URL and raw body of an inbound webhook. */
  private async signedParts(request: Request): Promise<{ url: string; body: string }> {
    return { url: buildWebhookUrl(request, this.webhookBaseUrl).toString(), body: await request.clone().text() }
  }

  private record(action: MockTelephonyAction): void {
    this.actions.push(action)
    if (this.actions.length > MAX_RECORDED_ACTIONS) this.actions.shift()
  }

  async handleLanguageMenu(params: LanguageMenuParams): Promise<TelephonyResponse> {
    return mockResponse('language-menu', { callSid: params.callSid, languages: params.enabledLanguages })
  }

  async handleIncomingCall(params: IncomingCallParams): Promise<TelephonyResponse> {
    return mockResponse('incoming-call', { callSid: params.callSid, rateLimited: params.rateLimited })
  }

  async handleCaptchaResponse(params: CaptchaResponseParams): Promise<TelephonyResponse> {
    return mockResponse('captcha', {
      callSid: params.callSid,
      outcome: params.outcome,
      ...(params.outcome === 'pass' ? {} : { digitsToSpeak: params.digitsToSpeak }),
    })
  }

  async handleCallAnswered(params: CallAnsweredParams): Promise<TelephonyResponse> {
    return mockResponse('call-answered', { callSid: params.parentCallSid })
  }

  async handleVoicemail(params: VoicemailParams): Promise<TelephonyResponse> {
    return mockResponse('voicemail', { callSid: params.callSid })
  }

  async handleWaitMusic(_lang: string, _audioUrls?: AudioUrlMap, queueTime?: number, queueTimeout?: number): Promise<TelephonyResponse> {
    const leave = queueTime !== undefined && queueTimeout !== undefined && queueTime >= queueTimeout
    return mockResponse(leave ? 'leave-queue' : 'wait')
  }

  rejectCall(): TelephonyResponse {
    return mockResponse('reject', { status: 403 })
  }

  hangupResponse(): TelephonyResponse {
    return mockResponse('hangup')
  }

  async hangupCall(callSid: string): Promise<void> {
    this.record({ type: 'hangup', callSid })
    const trace = callTraces.get(callSid)
    if (trace) trace.hungUp = true
  }

  async ringVolunteers(params: RingVolunteersParams): Promise<string[]> {
    this.record({ type: 'ring', callSid: params.callSid, legs: params.volunteers.length })
    const trace = traceFor(params.callSid, params.hubId ?? '')
    // Built exactly as a cloud provider's dial request names them (see TwilioAdapter.ringVolunteers):
    // the opaque per-leg token is the only thing that ties a leg back to its volunteer.
    const legs = params.volunteers.map((vol, i): MockDialledLeg => {
      const token = encodeURIComponent(vol.callToken)
      return {
        legSid: `mock-leg-${params.callSid}-${i}`,
        to: vol.phone,
        answerUrl: `${params.callbackUrl}/api/telephony/user-answer?callToken=${token}`,
        statusUrl: `${params.callbackUrl}/api/telephony/call-status?callToken=${token}`,
      }
    })
    trace.legs.push(...legs)
    return legs.map(leg => leg.legSid)
  }

  async cancelRinging(callSids: string[], exceptSid?: string): Promise<void> {
    this.record({ type: 'cancel-ringing', callSids, exceptSid })
    const cancelled = callSids.filter(sid => sid !== exceptSid)
    for (const trace of callTraces.values()) {
      if (trace.legs.some(leg => cancelled.includes(leg.legSid))) trace.cancelledLegSids.push(...cancelled)
    }
  }

  /**
   * Accepts a webhook only when the hub configured a signing secret and the
   * request carries its HMAC over the signed URL and body — never otherwise.
   */
  async validateWebhook(request: Request): Promise<boolean> {
    if (!this.webhookSecret) return false
    const signature = request.headers.get(MOCK_SIGNATURE_HEADER)
    if (!signature) return false
    const { url, body } = await this.signedParts(request)
    return timingSafeCompare(signature, mockWebhookSignature(this.webhookSecret, url, body))
  }

  /** Keyed on exactly what the signature authenticates: the signed URL and the body. */
  async webhookReplayKey(request: Request): Promise<string> {
    const { url, body } = await this.signedParts(request)
    return mockSigningInput(url, body)
  }

  async getCallRecording(_callSid: string): Promise<ArrayBuffer | null> {
    return null
  }

  async getRecordingAudio(_recordingSid: string): Promise<ArrayBuffer | null> {
    return null
  }

  providerAccountId(): string {
    return `mock:${this.phoneNumber}`
  }

  async deleteRecording(recordingSid: string): Promise<void> {
    if (recordingSid.startsWith(MOCK_UNDELETABLE_RECORDING_PREFIX) && !recoveredRecordings.delete(recordingSid)) {
      throw new ProviderRecordingDeleteError('mock', 503, 'the mock provider refuses to delete this recording')
    }
    this.record({ type: 'delete-recording', recordingSid })
  }

  async probeRecordingPosture(_context: RecordingPostureContext): Promise<ProviderRecordingPosture> {
    return {
      recording: { state: 'off', evidence: 'the mock provider has no media path: it cannot record a call' },
      transcription: { state: 'off', evidence: 'the mock provider has no media path: it cannot transcribe a call' },
    }
  }

  async enforceRecordingPosture(): Promise<ProviderSettingEnforcement[]> {
    return [
      { setting: 'recording', target: 'mock provider', outcome: 'already-off', evidence: 'the mock provider has no media path: it cannot record a call' },
      { setting: 'transcription', target: 'mock provider', outcome: 'already-off', evidence: 'the mock provider has no media path: it cannot transcribe a call' },
    ]
  }

  providerRetention(): ProviderRetentionStatement {
    return {
      removed: [
        { what: 'Simulated voicemail and call recordings', how: 'deleteRecording, which refuses mock-undeletable-* handles so the failure path can be driven' },
      ],
      retained: [
        { what: 'Simulated call state in this server process', reason: 'the mock provider is a test double with no external account; it keeps nothing outside memory' },
      ],
      source: 'the mock provider implementation',
    }
  }

  async parseIncomingWebhook(request: Request): Promise<WebhookCallInfo> {
    const body = await readJsonBody(request)
    return { callSid: str(body.callSid), callerNumber: str(body.callerNumber), calledNumber: str(body.calledNumber) || this.phoneNumber }
  }

  async parseLanguageWebhook(request: Request): Promise<WebhookCallInfo & WebhookDigits> {
    const body = await readJsonBody(request)
    return { ...(await this.parseIncomingWebhook(request)), digits: str(body.digits) }
  }

  async parseCaptchaWebhook(request: Request): Promise<WebhookDigits & { callerNumber: string }> {
    const body = await readJsonBody(request)
    return { digits: str(body.digits), callerNumber: str(body.callerNumber) }
  }

  async parseCallStatusWebhook(request: Request): Promise<WebhookCallStatus> {
    const body = await readJsonBody(request)
    return { status: (str(body.status, 'completed') as WebhookCallStatus['status']) }
  }

  async parseQueueWaitWebhook(request: Request): Promise<WebhookQueueWait> {
    const body = await readJsonBody(request)
    return { queueTime: typeof body.queueTime === 'number' ? body.queueTime : 0 }
  }

  async parseQueueExitWebhook(request: Request): Promise<WebhookQueueResult> {
    const body = await readJsonBody(request)
    return { result: (str(body.result, 'leave') as WebhookQueueResult['result']) }
  }

  async parseRecordingWebhook(request: Request): Promise<WebhookRecordingStatus> {
    const body = await readJsonBody(request)
    return {
      status: str(body.status, 'completed') as WebhookRecordingStatus['status'],
      recordingSid: str(body.recordingSid) || undefined,
      callSid: str(body.callSid) || undefined,
    }
  }

  handleVoicemailComplete(_lang: string): TelephonyResponse {
    return mockResponse('voicemail-complete')
  }

  emptyResponse(): TelephonyResponse {
    return mockResponse('noop')
  }
}
