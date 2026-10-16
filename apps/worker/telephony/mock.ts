/**
 * MockTelephonyAdapter — a TelephonyAdapter that talks to no provider.
 *
 * Exists so a demo/staging instance with no PSTN number can still exercise the
 * product's core loop (ring → answer → note) end to end. It is selected per hub
 * exactly like the real providers (a `provider_configs` row with type `mock`),
 * and it is driven through the REAL routing path — the same ban check, shift /
 * ring-group resolution and `call:ring` event the webhook flow uses.
 *
 * SAFETY: constructing it is refused unless ALL of these hold:
 *   - ENVIRONMENT is one of development | staging | demo (fail closed: an
 *     unset or unrecognised environment is refused, and `production` is never
 *     allowed no matter what other flags are set)
 *   - DEMO_MODE === 'true'
 *   - DEMO_MODE_CONFIRM === 'DESTROY_ALL_DATA' (the same two-factor value
 *     `validateConfig` demands for DEMO_MODE)
 *
 * The mock never accepts inbound webhooks (`validateWebhook` is always false):
 * simulated calls are injected server-side by the admin-only demo routes, so
 * there is no unauthenticated surface that can conjure a call.
 */
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
} from './adapter'

/** Value stored in `provider_configs.provider_type` when a hub uses the mock. */
export const MOCK_PROVIDER_TYPE = 'mock'

/** Prefix of every call SID minted by the mock — lets routes refuse to touch real calls. */
export const MOCK_CALL_SID_PREFIX = 'mock-call-'

const ALLOWED_ENVIRONMENTS: readonly string[] = ['development', 'staging', 'demo']
const DEMO_CONFIRM_VALUE = 'DESTROY_ALL_DATA'

export interface MockTelephonyEnv {
  ENVIRONMENT?: string
  DEMO_MODE?: string
  DEMO_MODE_CONFIRM?: string
}

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

/** Returns why the mock may not be used in this environment, or null when it may. */
export function mockTelephonyRefusalReason(env: MockTelephonyEnv): string | null {
  const environment = (env.ENVIRONMENT ?? '').trim().toLowerCase()
  if (environment === 'production') return 'ENVIRONMENT=production'
  if (!ALLOWED_ENVIRONMENTS.includes(environment)) return 'ENVIRONMENT is not a demo-capable environment'
  if (env.DEMO_MODE?.trim() !== 'true') return 'DEMO_MODE is not enabled'
  if (env.DEMO_MODE_CONFIRM?.trim() !== DEMO_CONFIRM_VALUE) return 'DEMO_MODE_CONFIRM is not set'
  return null
}

export function isMockTelephonyAllowed(env: MockTelephonyEnv): boolean {
  return mockTelephonyRefusalReason(env) === null
}

/** Throws MockTelephonyRefusedError unless the mock may be used in this environment. */
export function assertMockTelephonyAllowed(env: MockTelephonyEnv): void {
  const reason = mockTelephonyRefusalReason(env)
  if (reason) throw new MockTelephonyRefusedError(reason)
}

/** Every provider-facing action the mock performed (bounded; for inspection in tests). */
export type MockTelephonyAction =
  | { type: 'ring'; callSid: string; legs: number }
  | { type: 'hangup'; callSid: string }
  | { type: 'cancel-ringing'; callSids: string[]; exceptSid?: string }

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
   */
  constructor(env: MockTelephonyEnv, readonly phoneNumber: string) {
    assertMockTelephonyAllowed(env)
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
    return mockResponse('captcha', { callSid: params.callSid, matched: params.digits === params.expectedDigits })
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
  }

  async ringVolunteers(params: RingVolunteersParams): Promise<string[]> {
    this.record({ type: 'ring', callSid: params.callSid, legs: params.volunteers.length })
    return params.volunteers.map((_, i) => `mock-leg-${params.callSid}-${i}`)
  }

  async cancelRinging(callSids: string[], exceptSid?: string): Promise<void> {
    this.record({ type: 'cancel-ringing', callSids, exceptSid })
  }

  /** The mock accepts no inbound webhooks — calls are injected by the authenticated demo routes only. */
  async validateWebhook(_request: Request): Promise<boolean> {
    return false
  }

  async getCallRecording(_callSid: string): Promise<ArrayBuffer | null> {
    return null
  }

  async getRecordingAudio(_recordingSid: string): Promise<ArrayBuffer | null> {
    return null
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
