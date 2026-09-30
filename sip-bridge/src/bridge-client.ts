// ---- Bridge Event Types (protocol-agnostic) ----

/**
 * Normalized event emitted by any PBX protocol client.
 * The CommandHandler translates these into HTTP webhooks to the Worker.
 */
export type BridgeEvent =
  | ChannelCreateEvent
  | ChannelAnswerEvent
  | ChannelHangupEvent
  | DtmfReceivedEvent
  | RecordingCompleteEvent
  | RecordingFailedEvent
  | PlaybackFinishedEvent

export interface ChannelCreateEvent {
  type: 'channel_create'
  channelId: string
  callerNumber: string
  calledNumber: string
  /** Protocol-specific args (e.g., ARI stasis args, ESL channel variables) */
  args?: string[]
  timestamp: string
}

export interface ChannelAnswerEvent {
  type: 'channel_answer'
  channelId: string
  timestamp: string
}

export interface ChannelHangupEvent {
  type: 'channel_hangup'
  channelId: string
  /**
   * Q.850 / ISDN cause code (16 = NORMAL_CLEARING,
   * 17 = USER_BUSY, 19 = NO_ANSWER, 21 = CALL_REJECTED).
   */
  cause: number
  causeText: string
  timestamp: string
}

export interface DtmfReceivedEvent {
  type: 'dtmf_received'
  channelId: string
  digit: string
  durationMs: number
  timestamp: string
}

export interface RecordingCompleteEvent {
  type: 'recording_complete'
  channelId: string
  recordingName: string
  duration?: number
  timestamp: string
}

export interface RecordingFailedEvent {
  type: 'recording_failed'
  channelId: string
  recordingName: string
  cause?: string
  timestamp: string
}

export interface PlaybackFinishedEvent {
  type: 'playback_finished'
  channelId: string
  playbackId: string
  /** The PBX could not fetch or decode the media — the caller heard nothing */
  failed: boolean
  media: string
  timestamp: string
}

// ---- Originate Parameters ----

export interface OriginateParams {
  /** SIP endpoint (e.g., "PJSIP/user@trunk" for Asterisk, "sofia/internal/user" for FreeSWITCH) */
  endpoint: string
  /** Caller ID to display */
  callerId?: string
  /** Ring timeout in seconds */
  timeout?: number
  /** Application-specific arguments (e.g., ARI appArgs, FS channel variables) */
  appArgs?: string
}

// ---- Bridge Options ----

export interface BridgeOptions {
  /** Whether to record the bridge */
  record?: boolean
  /** Bridge type: 'mixing' (default, media-terminating) or 'passthrough' (SFrame E2EE) */
  type?: 'mixing' | 'passthrough'
}

// ---- Health Status ----

export interface BridgeHealthStatus {
  ok: boolean
  /** Round-trip latency to the PBX in milliseconds */
  latencyMs: number
  /** Protocol-specific details */
  details?: Record<string, unknown>
}

// ---- Protocol-Agnostic Bridge Client Interface ----

type EventHandler = (event: BridgeEvent) => void

/**
 * BridgeClient — abstract interface for PBX protocol clients.
 *
 * Each PBX protocol (Asterisk ARI, FreeSWITCH ESL, Kamailio JSONRPC)
 * implements this interface. The sip-bridge entry point selects the
 * appropriate client based on the PBX_TYPE environment variable.
 */
export interface BridgeClient {
  /** Connect to the PBX (WebSocket, TCP, or HTTP depending on protocol) */
  connect(): Promise<void>

  /** Disconnect from the PBX */
  disconnect(): void

  /** Whether the client is currently connected */
  isConnected(): boolean

  /** Register a handler for normalized bridge events */
  onEvent(handler: EventHandler): void

  /** Unregister a handler */
  offEvent(handler: EventHandler): void

  // ---- Call Control ----

  /** Originate an outbound call. Returns the channel/call ID. */
  originate(params: OriginateParams): Promise<{ id: string }>

  /** Hang up a channel by ID */
  hangup(channelId: string): Promise<void>

  /** Answer a channel */
  answer(channelId: string): Promise<void>

  /** Bridge two channels together. Returns the bridge ID. */
  bridge(channelId1: string, channelId2: string, options?: BridgeOptions): Promise<string>

  /** Destroy a bridge */
  destroyBridge(bridgeId: string): Promise<void>

  // ---- Media ----

  /** Play media on a channel. Returns playback ID. */
  playMedia(channelId: string, media: string, playbackId?: string): Promise<string>

  /** Stop a playback */
  stopPlayback(playbackId: string): Promise<void>

  /** Start music-on-hold on a channel */
  startMoh(channelId: string, mohClass?: string): Promise<void>

  /** Stop music-on-hold */
  stopMoh(channelId: string): Promise<void>

  // ---- Recording ----

  /** Start recording a channel */
  recordChannel(
    channelId: string,
    params: {
      name: string
      format?: string
      maxDurationSeconds?: number
      beep?: boolean
      terminateOn?: string
    }
  ): Promise<void>

  /** Start recording a bridge */
  recordBridge(
    bridgeId: string,
    params: {
      name: string
      format?: string
      maxDurationSeconds?: number
    }
  ): Promise<void>

  /** Stop an active recording */
  stopRecording(recordingName: string): Promise<void>

  /** Get recording audio as raw bytes */
  getRecordingFile(recordingName: string): Promise<ArrayBuffer | null>

  /** Delete a stored recording */
  deleteRecording(recordingName: string): Promise<void>

  // ---- Channel Variables ----

  /** Set a channel variable */
  setChannelVar(channelId: string, variable: string, value: string): Promise<void>

  /** Get a channel variable */
  getChannelVar(channelId: string, variable: string): Promise<string>

  // ---- System ----

  /** Health check — returns ok status and round-trip latency */
  healthCheck(): Promise<BridgeHealthStatus>

  /** List active channels */
  listChannels(): Promise<Array<{ id: string; state: string; caller: string }>>

  /** List active bridges */
  listBridges(): Promise<Array<{ id: string; channels: string[] }>>
}
