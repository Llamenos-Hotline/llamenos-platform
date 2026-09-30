// ---- ARI Event Types ----

/** Base ARI event — all events include these fields */
export interface AriEvent {
  type: string
  application: string
  timestamp: string
}

/** StasisStart — a channel has entered the Stasis application */
export interface StasisStartEvent extends AriEvent {
  type: 'StasisStart'
  args: string[]
  channel: AriChannel
}

/** StasisEnd — a channel has left the Stasis application */
export interface StasisEndEvent extends AriEvent {
  type: 'StasisEnd'
  channel: AriChannel
}

/** ChannelDtmfReceived — a DTMF digit was received on a channel */
export interface ChannelDtmfReceivedEvent extends AriEvent {
  type: 'ChannelDtmfReceived'
  digit: string
  duration_ms: number
  channel: AriChannel
}

/** ChannelStateChange — a channel's state has changed */
export interface ChannelStateChangeEvent extends AriEvent {
  type: 'ChannelStateChange'
  channel: AriChannel
}

/** ChannelHangupRequest — a hangup was requested on a channel */
export interface ChannelHangupRequestEvent extends AriEvent {
  type: 'ChannelHangupRequest'
  cause: number
  channel: AriChannel
}

/** ChannelDestroyed — a channel has been destroyed */
export interface ChannelDestroyedEvent extends AriEvent {
  type: 'ChannelDestroyed'
  cause: number
  cause_txt: string
  channel: AriChannel
}

/** PlaybackFinished — a playback has finished */
export interface PlaybackFinishedEvent extends AriEvent {
  type: 'PlaybackFinished'
  playback: AriPlayback
}

/** RecordingFinished — a recording has finished */
export interface RecordingFinishedEvent extends AriEvent {
  type: 'RecordingFinished'
  recording: AriRecording
}

/** RecordingFailed — a recording has failed */
export interface RecordingFailedEvent extends AriEvent {
  type: 'RecordingFailed'
  recording: AriRecording
}

/** ChannelEnteredBridge — a channel entered a bridge */
export interface ChannelEnteredBridgeEvent extends AriEvent {
  type: 'ChannelEnteredBridge'
  bridge: AriBridge
  channel: AriChannel
}

/** ChannelLeftBridge — a channel left a bridge */
export interface ChannelLeftBridgeEvent extends AriEvent {
  type: 'ChannelLeftBridge'
  bridge: AriBridge
  channel: AriChannel
}

export type AnyAriEvent =
  | StasisStartEvent
  | StasisEndEvent
  | ChannelDtmfReceivedEvent
  | ChannelStateChangeEvent
  | ChannelHangupRequestEvent
  | ChannelDestroyedEvent
  | PlaybackFinishedEvent
  | RecordingFinishedEvent
  | RecordingFailedEvent
  | ChannelEnteredBridgeEvent
  | ChannelLeftBridgeEvent
  | AriEvent // fallback for unknown events

// ---- ARI Resource Types ----

export interface AriChannel {
  id: string
  name: string
  state:
    | 'Down'
    | 'Rsrved'
    | 'OffHook'
    | 'Dialing'
    | 'Ring'
    | 'Ringing'
    | 'Up'
    | 'Busy'
    | 'Dialing Offhook'
    | 'Pre-ring'
    | 'Unknown'
  caller: { name: string; number: string }
  connected: { name: string; number: string }
  accountcode: string
  dialplan: { context: string; exten: string; priority: number }
  creationtime: string
  language: string
}

export interface AriBridge {
  id: string
  technology: string
  bridge_type: string
  bridge_class: string
  creator: string
  name: string
  channels: string[]
}

export interface AriPlayback {
  id: string
  media_uri: string
  target_uri: string
  language: string
  state: 'queued' | 'playing' | 'complete' | 'failed'
}

export interface AriRecording {
  name: string
  format: string
  state: 'queued' | 'recording' | 'paused' | 'done' | 'failed' | 'canceled'
  target_uri: string
  duration?: number
  talking_duration?: number
  silence_duration?: number
  cause?: string
}

// ---- Webhook Types (sent to Worker) ----
//
// Field names are the ones the worker parses (apps/worker/telephony/
// sip-bridge-adapter.ts: parse*Webhook). A field the worker does not read is a
// field that silently does nothing — e.g. a call-status sent as `callStatus`
// was always read as "initiated".

/** Webhook payload sent to the Worker in JSON format */
export interface WebhookPayload {
  event:
    | 'incoming'
    | 'language-selected'
    | 'captcha'
    | 'call-status'
    | 'wait-music'
    | 'queue-exit'
    | 'volunteer-answer'
    | 'call-recording'
    | 'voicemail-recording'
    | 'voicemail-complete'
  channelId: string
  callerNumber: string
  calledNumber?: string
  digits?: string
  /** Volunteer-leg outcome (call-status) */
  status?: CallLegStatus
  queueTime?: number
  /** Why the caller left the queue (queue-exit) */
  result?: QueueExitResult
  /** ARI recording state: `done` on success */
  recordingStatus?: 'done' | 'failed'
  recordingName?: string
}

export type CallLegStatus = 'completed' | 'busy' | 'no-answer' | 'failed'
export type QueueExitResult = 'leave' | 'error' | 'hangup'

// ---- Command Types (received from Worker) ----
//
// The vocabulary emitted by apps/worker/telephony/asterisk.ts. Every command in
// a webhook response acts on the channel that webhook was about — the worker
// never names channels. `metadata` is echoed back as the query string of the
// callback the command triggers (hub, callSid, lang, ...), exactly like the
// query string of a TwiML action URL.

/** Callback events a command may name, and the worker route each one posts to. */
export const CALLBACK_PATHS = {
  language_selected: '/api/telephony/language-selected',
  captcha_response: '/api/telephony/captcha',
  wait_music: '/api/telephony/wait-music',
  queue_exit: '/api/telephony/queue-exit',
  recording_complete: '/api/telephony/voicemail-recording',
} as const

export type CallbackEvent = keyof typeof CALLBACK_PATHS

/** Fixed worker routes the bridge calls on its own (not named by a command). */
export const WORKER_PATHS = {
  incoming: '/api/telephony/incoming',
  userAnswer: '/api/telephony/user-answer',
  callStatus: '/api/telephony/call-status',
  callRecording: '/api/telephony/call-recording',
  voicemailComplete: '/api/telephony/voicemail-complete',
} as const

/** Commands the Worker sends back to the bridge */
export type BridgeCommand =
  | PlayCommand
  | GatherCommand
  | QueueCommand
  | BridgeCallCommand
  | RecordCommand
  | HangupCommand
  | LeaveQueueCommand

/**
 * Play a prompt from a URL: an operator's upload (/api/ivr-audio) or speech the
 * worker generated (/api/ivr-speech). The bridge has no speech engine — the
 * worker turns every prompt into audio before it reaches the PBX.
 */
export interface PlayCommand {
  action: 'play'
  url: string
}

/** Collect DTMF digits, then post them to the callback event's route */
export interface GatherCommand {
  action: 'gather'
  /** 0 = post immediately without waiting for input */
  numDigits: number
  /** Seconds to wait for input after the preceding prompts finish */
  timeout: number
  callbackEvent: 'language_selected' | 'captcha_response'
  metadata?: Record<string, string>
}

/** Hold the caller (music on hold) until a volunteer is bridged or the queue is left */
export interface QueueCommand {
  action: 'queue'
  /** The caller's call SID — the name volunteer legs bridge against */
  queueName: string
  waitMusicEvent: 'wait_music'
  exitEvent: 'queue_exit'
  metadata?: Record<string, string>
}

/** Bridge this (volunteer) channel with the caller waiting in `queueName` */
export interface BridgeCallCommand {
  action: 'bridge'
  queueName: string
  record: boolean
}

/** Record a voicemail from this channel */
export interface RecordCommand {
  action: 'record'
  maxDuration: number
  finishOnKey: string
  callbackEvent: 'recording_complete'
  metadata?: Record<string, string>
}

export interface HangupCommand {
  action: 'hangup'
  reason?: string
}

/** Leave the queue — the caller goes on to voicemail via the queue-exit callback */
export interface LeaveQueueCommand {
  action: 'leave_queue'
}

// ---- Bridge Internal State ----

/** Active caller-leg state tracked by the bridge */
export interface ActiveCall {
  channelId: string
  callerNumber: string
  calledNumber: string
  startedAt: number
  /**
   * Tier 5 voice E2EE call mode.
   * - `sframe`: entered via `[volunteers-sframe]` dialplan context — MUST NOT record.
   * - `pstn`: regular carrier leg — normal recording semantics.
   */
  mode: 'sframe' | 'pstn'
  bridgeId?: string
  /** Volunteer legs currently ringing for this call */
  ringingChannels: string[]
  /** Prompts queued or playing on this channel */
  pendingPlaybacks: Set<string>
  /** The worker asked to end the call; it ends once the last prompt finishes */
  hangupAfterPrompts?: boolean
  dtmfBuffer: string
  activeGather?: {
    numDigits: number
    timeout: number
    callbackEvent: GatherCommand['callbackEvent']
    metadata?: Record<string, string>
    timeoutTimer?: ReturnType<typeof setTimeout>
  }
  queue?: {
    queueName: string
    metadata?: Record<string, string>
    startedAt: number
    waitTimer?: ReturnType<typeof setInterval>
  }
}

/** A volunteer leg originated by the bridge to ring a volunteer's phone */
export interface VolunteerLeg {
  parentCallSid: string
  /** Opaque single-use token the worker resolves to the volunteer */
  callToken: string
  answered: boolean
}

/** A recording in progress, and where to report its outcome */
export interface PendingRecording {
  kind: 'voicemail' | 'call'
  channelId: string
  /** voicemail: query for voicemail-recording / voicemail-complete; call: { parentCallSid } */
  params: Record<string, string>
  /** When to give up on the finish event; unset while the recording may legitimately still run */
  expiresAt?: number
}

/**
 * PBX_TYPE values. It names the PBX, not the protocol the bridge speaks to it:
 * `asterisk` (spoken to over ARI), `freeswitch` (ESL), `kamailio` (JSONRPC).
 */
export const PBX_TYPES = ['asterisk', 'freeswitch', 'kamailio'] as const
export type PbxType = (typeof PBX_TYPES)[number]

/** Configuration for the bridge service */
export interface BridgeConfig {
  pbxType: PbxType
  /** ARI WebSocket URL (asterisk only) */
  ariUrl: string
  /** ARI REST API URL (asterisk only) */
  ariRestUrl: string
  /** ARI username (asterisk only) */
  ariUsername: string
  /** ARI password (asterisk only) */
  ariPassword: string
  /** ESL host (freeswitch only) */
  eslHost: string
  /** ESL port (freeswitch only) */
  eslPort: number
  /** ESL password (freeswitch only) */
  eslPassword: string
  /** Kamailio JSONRPC URL (kamailio only) */
  kamailioJsonrpcUrl: string
  /** Worker webhook URL */
  workerWebhookUrl: string
  /** Shared HMAC secret for signing */
  bridgeSecret: string
  /** HTTP server port */
  bridgePort: number
  /** HTTP server bind address */
  bridgeHost: string
  /** Stasis application name (asterisk only) */
  stasisApp: string
  /** Maximum time (ms) to wait for initial PBX connection. Default 5 minutes. */
  connectionTimeoutMs: number
}
