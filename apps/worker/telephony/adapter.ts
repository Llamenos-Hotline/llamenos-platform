// --- Webhook result types (provider-agnostic) ---

export interface WebhookCallInfo {
  callSid: string
  callerNumber: string
  /** The called number (To / hotline number) — used for multi-hub routing */
  calledNumber?: string
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
   * Generate response for CAPTCHA digit gather (after caller enters digits).
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
  handleWaitMusic(lang: string, audioUrls?: AudioUrlMap, queueTime?: number, queueTimeout?: number): Promise<TelephonyResponse>

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
   * Get call recording/audio for transcription by call SID.
   */
  getCallRecording(callSid: string): Promise<ArrayBuffer | null>

  /**
   * Get recording audio directly by recording SID.
   */
  getRecordingAudio(recordingSid: string): Promise<ArrayBuffer | null>

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
  handleVoicemailComplete(lang: string): TelephonyResponse

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
}

export interface IncomingCallParams {
  callSid: string
  callerNumber: string
  voiceCaptchaEnabled: boolean
  rateLimited: boolean
  callerLanguage: string
  hotlineName: string
  audioUrls?: AudioUrlMap
  /** Pre-generated CAPTCHA digits (generated server-side with CSPRNG) */
  captchaDigits?: string
  /** Hub ID for multi-hub routing — appended to callback URLs as &hub= */
  hubId?: string
}

export interface CaptchaResponseParams {
  callSid: string
  digits: string
  expectedDigits: string
  callerLanguage: string
  /** Hub ID for multi-hub routing — appended to callback URLs as &hub= */
  hubId?: string
}

export interface CallAnsweredParams {
  /** The incoming call SID, used as the queue name to bridge caller → volunteer */
  parentCallSid: string
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
}

export interface RingVolunteersParams {
  callSid: string
  callerNumber: string
  /**
   * CRIT-W2: callToken replaces pubkey in callback URLs.
   * Each volunteer gets a unique opaque single-use token that is resolved to their pubkey server-side.
   */
  volunteers: Array<{ phone: string; callToken: string }>
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
