import type { BridgeClient, BridgeEvent } from './bridge-client'
import type { WebhookSender } from './webhook-sender'
import type {
  ActiveCall,
  BridgeCommand,
  BridgeConfig,
  RecordingCallbackEntry,
  WebhookPayload,
} from './types'
import { type CallMode, SframeModeDispatcher, parseStasisArgs } from './sframe-mode-dispatcher'
import { type TtsEngine, createTtsEngine, formatMediaPath } from './tts-engine'
import { logger } from './logger'

/** TTL for recording callbacks — entries older than this are pruned */
const RECORDING_CALLBACK_TTL_MS = 5 * 60 * 1000 // 5 minutes
/** Interval for the TTL sweep timer */
const RECORDING_CALLBACK_SWEEP_INTERVAL_MS = 60 * 1000 // 60 seconds

/**
 * CommandHandler — the central orchestrator that:
 * 1. Receives protocol-agnostic BridgeEvents and translates them into Worker webhooks
 * 2. Receives JSON commands from the Worker and executes them via BridgeClient
 * 3. Maintains call state for coordinating multi-step flows
 * 4. Enforces Tier 5 SFrame recording ban via SframeModeDispatcher
 */
export class CommandHandler {
  private readonly client: BridgeClient
  private readonly webhook: WebhookSender
  private readonly config: BridgeConfig
  private readonly sframeDispatcher = new SframeModeDispatcher()

  /** Active calls indexed by channel ID.
   *  Pruning: entries removed via cleanupCall() on channel_hangup. */
  private readonly calls = new Map<string, ActiveCall>()

  /** Map of queue name (= parentCallSid) → caller channel ID.
   *  Pruning: entries removed via cleanupCall(). */
  private readonly queues = new Map<string, string>()

  /** Map of bridge ID → { callerChannelId, volunteerChannelId }.
   *  Pruning: entries removed via cleanupCall() → cleanupBridge(). */
  private readonly bridges = new Map<string, { callerChannelId: string; volunteerChannelId: string }>()

  /** Map of recording name → callback info.
   *  Pruning: event-driven on recording_complete/recording_failed, TTL sweep every 60s,
   *  and bulk removal per-channel via cleanupCall(). */
  private readonly recordingCallbacks = new Map<string, RecordingCallbackEntry>()

  /** Map of volunteer channel ID → parent call SID (for ringing coordination).
   *  Pruning: entries removed via cleanupCall() and volunteer hangup path. */
  private readonly ringingMap = new Map<string, string>()

  /** Channels present on the PBX at last reconcile that this handler holds no state for. */
  private untrackedChannelCount = 0

  /** Configured hotline number (for the calledNumber field) */
  private hotlineNumber = ''

  /** Handle for the recording callback TTL sweep interval */
  private readonly recordingCallbackSweepTimer: ReturnType<typeof setInterval>

  /** Optional TTS engine for synthesizing voice prompts */
  private readonly ttsEngine: TtsEngine | null

  constructor(client: BridgeClient, webhook: WebhookSender, config: BridgeConfig) {
    this.client = client
    this.webhook = webhook
    this.config = config
    this.ttsEngine = config.ttsConfig ? createTtsEngine(config.ttsConfig) : null

    // Start periodic TTL sweep for stale recording callbacks
    this.recordingCallbackSweepTimer = setInterval(() => {
      this.pruneStaleRecordingCallbacks()
    }, RECORDING_CALLBACK_SWEEP_INTERVAL_MS)
  }

  /** Stop background timers (for graceful shutdown) */
  dispose(): void {
    clearInterval(this.recordingCallbackSweepTimer)
  }

  /** Set the hotline phone number (for webhook payloads) */
  setHotlineNumber(number: string): void {
    this.hotlineNumber = number
  }

  // ================================================================
  // Centralized Call Lifecycle Cleanup
  // ================================================================

  /**
   * cleanupCall — single function that tears down ALL state for a call.
   * Must be called unconditionally when a call ends (channel_hangup).
   * Clears: gather timeout, queue interval, recording callbacks, bridges,
   * ringing channels, and finally removes from the calls Map.
   */
  private cleanupCall(channelId: string): void {
    const call = this.calls.get(channelId)
    if (call) {
      // 1. Clear gather timeout timer
      if (call.activeGather?.timeoutTimer) {
        clearTimeout(call.activeGather.timeoutTimer)
        call.activeGather = undefined
      }

      // 2. Clear queue wait interval
      if (call.queue?.waitTimer) {
        clearInterval(call.queue.waitTimer)
        call.queue = undefined
      }
    }

    // 3. Clean up bridge (hang up other leg, destroy bridge). MUST run for every
    //    hangup, not only tracked callers: volunteer channels are never in `calls`,
    //    and when the volunteer hangs up first the caller's leg would otherwise stay
    //    up on the PBX and the bridge entry would leak.
    this.cleanupBridge(channelId)

    if (call) {
      // 4. Cancel all ringing channels spawned by this call
      this.cancelRingingForCall(channelId)

      // 5. Remove recording callbacks associated with this channel
      for (const [name, entry] of this.recordingCallbacks) {
        if (entry.channelId === channelId) {
          this.recordingCallbacks.delete(name)
        }
      }

      // 6. Remove from calls map
      this.calls.delete(channelId)
    }

    // 7. Remove from queues
    this.queues.delete(channelId)

    // 8. If this was a volunteer ringing channel, clean up ringing state
    const parentSid = this.ringingMap.get(channelId)
    if (parentSid) {
      this.ringingMap.delete(channelId)
      const parentCall = this.calls.get(parentSid)
      if (parentCall) {
        parentCall.ringingChannels = parentCall.ringingChannels.filter((id) => id !== channelId)
      }
    }
  }

  /** Prune recording callbacks older than RECORDING_CALLBACK_TTL_MS */
  private pruneStaleRecordingCallbacks(): void {
    const now = Date.now()
    let pruned = 0
    for (const [name, entry] of this.recordingCallbacks) {
      if (now - entry.createdAt > RECORDING_CALLBACK_TTL_MS) {
        this.recordingCallbacks.delete(name)
        pruned++
      }
    }
    if (pruned > 0) {
      logger.debug('[handler]', `Pruned ${pruned} stale recording callback(s)`)
    }
  }

  // ================================================================
  // BridgeEvent Handler (protocol-agnostic)
  // ================================================================

  /** Process a protocol-agnostic BridgeEvent */
  async handleEvent(event: BridgeEvent): Promise<void> {
    switch (event.type) {
      case 'channel_create':
        await this.onChannelCreate(event)
        break
      case 'channel_answer':
        // Answer events are informational — we act on create and hangup
        break
      case 'channel_hangup':
        await this.onChannelHangup(event)
        break
      case 'dtmf_received':
        await this.onDtmfReceived(event)
        break
      case 'recording_complete':
        await this.onRecordingComplete(event)
        break
      case 'recording_failed':
        await this.onRecordingFailed(event)
        break
      case 'playback_finished':
        await this.onPlaybackFinished(event)
        break
      case 'connection_reset':
        await this.reconcileWithPbx()
        break
    }
  }

  // ================================================================
  // PBX reconciliation (connection loss / process restart)
  // ================================================================

  /** Every channel ID this handler holds any state for. */
  private trackedChannelIds(): Set<string> {
    const ids = new Set<string>()
    for (const id of this.calls.keys()) ids.add(id)
    for (const id of this.queues.keys()) ids.add(id)
    for (const id of this.ringingMap.keys()) ids.add(id)
    for (const b of this.bridges.values()) {
      ids.add(b.callerChannelId)
      ids.add(b.volunteerChannelId)
    }
    return ids
  }

  /**
   * All live-call state lives in this process's memory, so after a PBX
   * disconnect (events dropped) or a bridge restart (state gone) it can disagree
   * with what the PBX is actually doing. Reconcile instead of silently mis-serving:
   *
   * - state we track for a channel the PBX no longer has → the hangup event was
   *   missed: run the normal hangup path (queue-exit / call-status webhooks, timers,
   *   bridge and recording cleanup).
   * - the PBX cannot be enumerated → we cannot trust ANY tracked state: hang up
   *   the tracked channels and tear their state down.
   * - channels present on the PBX that we hold no state for → cannot be served
   *   (e.g. callers left on hold by a previous process). Reported loudly and in
   *   `getStatus().untrackedChannels`; not hung up, because on Asterisk the channel
   *   list also contains channels this bridge does not own.
   */
  async reconcileWithPbx(): Promise<void> {
    // Snapshot tracked state BEFORE listing: anything tracked before the listing was
    // taken must appear in it if still alive; calls that begin during the await are
    // not in this snapshot and are never mistaken for vanished.
    const trackedBefore = this.trackedChannelIds()

    let live: Set<string> | null
    try {
      live = new Set((await this.client.listChannels()).map((c) => c.id))
    } catch (err) {
      logger.error('[handler]', 'Cannot enumerate PBX channels — tearing down tracked call state', err)
      live = null
    }

    let tornDown = 0
    for (const channelId of trackedBefore) {
      if (live?.has(channelId)) continue
      // Skip if the normal event path already cleaned it up while we were listing.
      if (!this.trackedChannelIds().has(channelId)) continue
      if (live === null) {
        try {
          await this.client.hangup(channelId)
        } catch {
          /* may already be gone */
        }
      }
      tornDown++
      await this.onChannelHangup({
        type: 'channel_hangup',
        channelId,
        cause: 38, // network out of order — synthesized, the real hangup event was lost
        causeText: 'CONNECTION_RESET',
        timestamp: new Date().toISOString(),
      })
    }

    if (tornDown > 0) {
      logger.warn('[handler]', `PBX reconnect: tore down state for ${tornDown} channel(s) that no longer exist`)
    }

    if (live) {
      const trackedNow = this.trackedChannelIds()
      this.untrackedChannelCount = [...live].filter((id) => !trackedNow.has(id)).length
      if (this.untrackedChannelCount > 0) {
        logger.error(
          '[handler]',
          `${this.untrackedChannelCount} channel(s) exist on the PBX with no bridge state ` +
            '(bridge restarted or events were lost) — they cannot be served'
        )
      }
    }
  }

  /** channel_create — new call entered the bridge application */
  private async onChannelCreate(event: BridgeEvent & { type: 'channel_create' }): Promise<void> {
    const args = event.args ?? []

    logger.debug('[handler]', `channel_create caller=${event.callerNumber}`)

    // Check if this is a volunteer outbound leg (originated by us for ringing)
    if (args[0] === 'dialed') {
      const parentCallSid = args[1]
      const pubkey = args[2]
      if (parentCallSid && pubkey) {
        await this.onVolunteerAnswered(event.channelId, parentCallSid, pubkey)
      }
      return
    }

    // Incoming call — parse args into a CallMode. The dialplan passes `sframe`
    // from the [volunteers-sframe] context; PSTN trunk contexts pass no args,
    // which defaults to mode='pstn'.
    const callMode = parseStasisArgs(args)

    // Answer the channel
    await this.client.answer(event.channelId)

    const call: ActiveCall = {
      channelId: event.channelId,
      callerNumber: event.callerNumber || 'unknown',
      calledNumber: event.calledNumber || this.hotlineNumber,
      startedAt: Date.now(),
      mode: callMode.mode,
      ringingChannels: [],
      dtmfBuffer: '',
    }
    this.calls.set(event.channelId, call)

    // Send incoming webhook to Worker
    const payload: WebhookPayload = {
      event: 'incoming',
      channelId: event.channelId,
      callerNumber: call.callerNumber,
      calledNumber: call.calledNumber,
    }

    const commands = await this.webhook.sendWebhookForCommands(
      '/api/telephony/incoming',
      payload
    )
    if (commands) {
      await this.executeCommands(commands)
    }
  }

  /** channel_hangup — channel destroyed */
  private async onChannelHangup(event: BridgeEvent & { type: 'channel_hangup' }): Promise<void> {
    logger.debug('[handler]', `channel_hangup cause=${event.cause}`)

    // Send call-status webhook for volunteer calls before cleanup
    const parentSid = this.ringingMap.get(event.channelId)
    if (parentSid) {
      const parentCall = this.calls.get(parentSid)
      const callerNumber = parentCall?.callerNumber ?? 'unknown'

      // Map Q.850 cause codes to call status
      let callStatus: 'completed' | 'busy' | 'no-answer' | 'failed' = 'completed'
      switch (event.cause) {
        case 17:
          callStatus = 'busy'
          break // User busy
        case 19:
          callStatus = 'no-answer'
          break // No answer
        case 21:
          callStatus = 'failed'
          break // Call rejected
        default:
          callStatus = 'completed'
      }

      const payload: WebhookPayload = {
        event: 'call-status',
        channelId: event.channelId,
        callerNumber,
        calledNumber: this.hotlineNumber,
        callStatus,
      }

      await this.webhook.sendWebhookForCommands(
        '/api/telephony/call-status',
        payload,
        { parentCallSid: parentSid }
      )
    }

    // If caller was in queue, send queue-exit webhook with 'hangup' result
    const call = this.calls.get(event.channelId)
    if (call?.queue) {
      await this.sendQueueExit(event.channelId, call, 'hangup')
    }

    // Unconditional cleanup
    this.cleanupCall(event.channelId)
  }

  /** DTMF digit received */
  private async onDtmfReceived(event: BridgeEvent & { type: 'dtmf_received' }): Promise<void> {
    logger.debug('[handler]', 'dtmf_received')

    const call = this.calls.get(event.channelId)
    if (!call) return

    // If there's an active gather, add the digit to the buffer
    if (call.activeGather) {
      call.dtmfBuffer += event.digit

      // Check if we've collected enough digits
      if (call.dtmfBuffer.length >= call.activeGather.numDigits) {
        // Clear the timeout
        if (call.activeGather.timeoutTimer) {
          clearTimeout(call.activeGather.timeoutTimer)
        }

        const digits = call.dtmfBuffer
        const gather = call.activeGather
        call.dtmfBuffer = ''
        call.activeGather = undefined

        // Stop any playing prompt
        try {
          await this.client.stopPlayback(`gather-${event.channelId}`)
        } catch {
          /* playback may not exist */
        }

        // Send digits to Worker via callback
        await this.sendGatherResult(
          event.channelId,
          call,
          digits,
          gather.callbackPath,
          gather.callbackParams
        )
      }
    }
  }

  /** Recording completed */
  private async onRecordingComplete(
    event: BridgeEvent & { type: 'recording_complete' }
  ): Promise<void> {
    logger.debug('[handler]', 'recording_complete')

    const callback = this.recordingCallbacks.get(event.recordingName)
    if (callback) {
      const call = this.calls.get(callback.channelId)
      const payload: WebhookPayload = {
        event: 'call-recording',
        channelId: callback.channelId,
        callerNumber: call?.callerNumber ?? 'unknown',
        calledNumber: this.hotlineNumber,
        recordingStatus: 'completed',
        recordingName: event.recordingName,
      }
      await this.webhook.sendWebhookForCommands(callback.callbackPath, payload, callback.callbackParams)
      this.recordingCallbacks.delete(event.recordingName)
    }
  }

  /** Recording failed */
  private async onRecordingFailed(
    event: BridgeEvent & { type: 'recording_failed' }
  ): Promise<void> {
    logger.debug('[handler]', 'recording_failed')

    const callback = this.recordingCallbacks.get(event.recordingName)
    if (callback) {
      const call = this.calls.get(callback.channelId)
      const payload: WebhookPayload = {
        event: 'call-recording',
        channelId: callback.channelId,
        callerNumber: call?.callerNumber ?? 'unknown',
        calledNumber: this.hotlineNumber,
        recordingStatus: 'failed',
        recordingName: event.recordingName,
      }
      await this.webhook.sendWebhookForCommands(callback.callbackPath, payload, callback.callbackParams)
      this.recordingCallbacks.delete(event.recordingName)
    }
  }

  /** Playback finished */
  private async onPlaybackFinished(
    event: BridgeEvent & { type: 'playback_finished' }
  ): Promise<void> {
    // If this was a gather prompt that finished without digits, handle timeout
    if (event.playbackId.startsWith('gather-')) {
      const channelId = event.playbackId.replace('gather-', '')
      const call = this.calls.get(channelId)
      if (call?.activeGather && call.dtmfBuffer.length === 0) {
        // Start the timeout timer for DTMF input after prompt finishes
        const gather = call.activeGather
        call.activeGather.timeoutTimer = setTimeout(async () => {
          // Timeout — send empty digits
          if (call.activeGather === gather) {
            call.activeGather = undefined
            call.dtmfBuffer = ''
            await this.sendGatherResult(
              channelId,
              call,
              '',
              gather.callbackPath,
              gather.callbackParams
            )
          }
        }, gather.timeout * 1000)
      }
    }
  }

  // ================================================================
  // Volunteer Ringing
  // ================================================================

  /** Called when a volunteer answers an outbound ringing call */
  private async onVolunteerAnswered(
    volunteerChannelId: string,
    parentCallSid: string,
    pubkey: string
  ): Promise<void> {
    logger.info('[handler]', 'Volunteer answered call')

    const parentCall = this.calls.get(parentCallSid)
    const payload: WebhookPayload = {
      event: 'volunteer-answer',
      channelId: volunteerChannelId,
      callerNumber: parentCall?.callerNumber ?? 'unknown',
      calledNumber: this.hotlineNumber,
    }

    const commands = await this.webhook.sendWebhookForCommands(
      '/api/telephony/volunteer-answer',
      payload,
      { parentCallSid, pubkey }
    )

    // Cancel ringing for other volunteers
    if (parentCall) {
      for (const ringChannelId of parentCall.ringingChannels) {
        if (ringChannelId !== volunteerChannelId) {
          try {
            await this.client.hangup(ringChannelId)
          } catch {
            /* may already be gone */
          }
        }
      }
      parentCall.ringingChannels = []
    }

    if (commands) {
      await this.executeCommands(commands)
    }
  }

  // ================================================================
  // Command Execution
  // ================================================================

  /** Execute a list of bridge commands received as JSON from the Worker */
  async executeCommands(commands: BridgeCommand[]): Promise<void> {
    for (const cmd of commands) {
      try {
        await this.executeCommand(cmd)
      } catch (err) {
        logger.error('[handler]', `Command failed: ${cmd.action}`, err)
      }
    }
  }

  /** Execute a single bridge command */
  private async executeCommand(cmd: BridgeCommand): Promise<void> {
    switch (cmd.action) {
      case 'playback':
        await this.execPlayback(cmd)
        break
      case 'gather':
        await this.execGather(cmd)
        break
      case 'bridge':
        await this.execBridge(cmd)
        break
      case 'hangup':
        await this.execHangup(cmd)
        break
      case 'record':
        await this.execRecord(cmd)
        break
      case 'ring':
        await this.execRing(cmd)
        break
      case 'queue':
        await this.execQueue(cmd)
        break
      case 'reject':
        await this.execReject(cmd)
        break
      case 'redirect':
        await this.execRedirect(cmd)
        break
    }
  }

  /** Play audio on a channel */
  private async execPlayback(cmd: PlaybackCommand): Promise<void> {
    const media = await this.resolvePlaybackMedia(cmd)
    if (!media) return
    try {
      await this.client.playMedia(cmd.channelId, media)
    } catch (err) {
      logger.warn('[handler]', 'Playback failed', err)
    }
  }

  /**
   * Resolve the media string to play for a command with optional text/media.
   * If text is provided and a TTS engine is configured, synthesize speech.
   * Falls back to beep if TTS is unavailable or fails.
   */
  private async resolvePlaybackMedia(cmd: {
    text?: string
    media?: string
    language?: string
  }): Promise<string | null> {
    if (cmd.media) {
      return cmd.media.startsWith('http') ? cmd.media : `sound:${cmd.media}`
    }
    if (cmd.text) {
      if (this.ttsEngine) {
        const audioPath = await this.ttsEngine.synthesize(cmd.text, cmd.language)
        if (audioPath) {
          return formatMediaPath(audioPath, this.config.pbxType)
        }
      }
      console.warn(
        `[handler] TTS unavailable — playing beep instead of: "${cmd.text.substring(0, 80)}..." lang=${cmd.language}`
      )
      return 'sound:beep'
    }
    return null
  }

  /** Gather DTMF digits */
  private async execGather(cmd: GatherCommand): Promise<void> {
    const call = this.calls.get(cmd.channelId)
    if (!call) return

    // A previous gather may still have a pending timeout — cancel it so it cannot
    // fire against this gather's state.
    if (call.activeGather?.timeoutTimer) {
      clearTimeout(call.activeGather.timeoutTimer)
    }

    // Set up gather state
    call.dtmfBuffer = ''
    const gather: NonNullable<ActiveCall['activeGather']> = {
      numDigits: cmd.numDigits,
      timeout: cmd.timeout,
      callbackPath: cmd.callbackPath,
      callbackParams: cmd.callbackParams,
    }
    call.activeGather = gather

    // Timeout handler — only acts if THIS gather is still the active one.
    const startTimeout = (): void => {
      gather.timeoutTimer = setTimeout(async () => {
        if (call.activeGather !== gather) return
        call.activeGather = undefined
        const digits = call.dtmfBuffer
        call.dtmfBuffer = ''
        await this.sendGatherResult(
          cmd.channelId,
          call,
          digits,
          gather.callbackPath,
          gather.callbackParams
        )
      }, cmd.timeout * 1000)
    }

    // Play the prompt (if any)
    const media = await this.resolvePlaybackMedia(cmd)
    if (media) {
      try {
        await this.client.playMedia(cmd.channelId, media, `gather-${cmd.channelId}`)
      } catch (err) {
        logger.warn('[handler]', 'Gather playback failed', err)
        // Start timeout even if playback fails
        if (call.activeGather === gather) startTimeout()
      }
    } else if (call.activeGather === gather) {
      // No prompt — just wait for digits
      startTimeout()
    }
  }

  /** Bridge two channels — enforces SFrame recording ban */
  private async execBridge(cmd: BridgeCallCommand): Promise<void> {
    // Resolve the caller channel from the queue
    let callerChannelId = cmd.callerChannelId
    const queuedCallerId = this.queues.get(callerChannelId)
    if (queuedCallerId) {
      callerChannelId = queuedCallerId
    }

    logger.info('[handler]', 'Bridging caller and volunteer')

    // Stop hold music on the caller
    const callerCall = this.calls.get(callerChannelId)
    if (callerCall?.queue?.waitTimer) {
      clearInterval(callerCall.queue.waitTimer)
      callerCall.queue = undefined
    }
    try {
      await this.client.stopMoh(callerChannelId)
    } catch {
      /* may not be on hold */
    }

    // Create bridge — use passthrough for SFrame E2EE calls
    const bridgeType = cmd.bridgeType ?? 'mixing'
    const bridgeId = await this.client.bridge(callerChannelId, cmd.volunteerChannelId, {
      type: bridgeType,
      record: false, // We handle recording separately below
    })

    // Track bridge state
    this.bridges.set(bridgeId, {
      callerChannelId,
      volunteerChannelId: cmd.volunteerChannelId,
    })

    if (callerCall) {
      callerCall.bridgeId = bridgeId
    }

    // Start recording if requested — enforcing Tier 5 SFrame recording ban
    if (cmd.record) {
      // Bridge recording inherits the caller's call mode. SFrame calls MUST NOT
      // be recorded; throwing aborts the recording attempt without tearing down
      // the bridge, keeping the volunteer-to-volunteer leg up.
      // If no ActiveCall is tracked (shouldn't happen for a just-bridged call),
      // default to mode='sframe' (fail-closed) — never accidentally record.
      const guardMode: CallMode = { mode: callerCall?.mode ?? 'sframe' }
      try {
        this.sframeDispatcher.assertRecordingAllowed(guardMode)
      } catch (err) {
        logger.warn('[handler]', 'Skipping bridge recording (Tier 5 SFrame)', err)
        return
      }

      const recordingName = `call-${callerChannelId}-${Date.now()}`
      try {
        await this.client.recordBridge(bridgeId, {
          name: recordingName,
          format: 'wav',
        })

        if (cmd.recordingCallbackPath) {
          this.recordingCallbacks.set(recordingName, {
            callbackPath: cmd.recordingCallbackPath,
            callbackParams: cmd.recordingCallbackParams ?? {},
            channelId: callerChannelId,
            createdAt: Date.now(),
          })
        }
      } catch (err) {
        logger.error('[handler]', 'Failed to start bridge recording', err)
      }
    }
  }

  /** Hang up a channel */
  private async execHangup(cmd: HangupCommand): Promise<void> {
    logger.info('[handler]', 'Hangup channel')
    await this.client.hangup(cmd.channelId)
  }

  /** Record a channel — enforces Tier 5 SFrame recording ban */
  private async execRecord(cmd: RecordCommand): Promise<void> {
    logger.info('[handler]', 'Recording channel')

    // Tier 5 voice E2EE guard — look up the call's mode and refuse to record
    // SFrame calls. If no ActiveCall is tracked (e.g. the bridge restarted and lost
    // its in-memory state) the mode cannot be established, so default to
    // mode='sframe' (fail-closed) — never record a call that might be E2EE.
    const callForGuard = this.calls.get(cmd.channelId)
    const guardMode: CallMode = { mode: callForGuard?.mode ?? 'sframe' }
    try {
      this.sframeDispatcher.assertRecordingAllowed(guardMode)
    } catch (err) {
      logger.warn('[handler]', 'Skipping channel recording (Tier 5 SFrame)', err)
      return
    }

    if (cmd.beep) {
      try {
        await this.client.playMedia(cmd.channelId, 'tone:1004/200')
      } catch {
        /* beep failed, continue anyway */
      }
    }

    try {
      await this.client.recordChannel(cmd.channelId, {
        name: cmd.name,
        format: 'wav',
        maxDurationSeconds: cmd.maxDuration,
        beep: false, // We already beeped
        terminateOn: '#',
      })

      this.recordingCallbacks.set(cmd.name, {
        callbackPath: cmd.callbackPath,
        callbackParams: cmd.callbackParams ?? {},
        channelId: cmd.channelId,
        createdAt: Date.now(),
      })
    } catch (err) {
      logger.error('[handler]', 'Failed to start recording', err)
    }
  }

  /**
   * Register an originated volunteer leg as ringing for `parentCallSid`, so its hangup
   * reports call-status and PBX reconciliation knows the bridge owns it. Also used by
   * the HTTP /ring endpoint, which originates outside the command flow.
   */
  trackRingingChannel(channelId: string, parentCallSid: string): void {
    this.ringingMap.set(channelId, parentCallSid)
    const parentCall = this.calls.get(parentCallSid)
    if (parentCall) {
      parentCall.ringingChannels.push(channelId)
    }
  }

  /** Originate an outbound call (ring a volunteer) */
  private async execRing(cmd: RingCommand): Promise<void> {
    logger.info('[handler]', 'Ringing volunteer')

    try {
      const channel = await this.client.originate({
        endpoint: cmd.endpoint,
        callerId: cmd.callerId,
        timeout: cmd.timeout,
        appArgs: `dialed,${cmd.answerCallbackParams?.parentCallSid ?? ''},${cmd.answerCallbackParams?.pubkey ?? ''}`,
      })

      // Track this as a ringing channel
      const parentSid = cmd.answerCallbackParams?.parentCallSid
      if (parentSid) {
        this.trackRingingChannel(channel.id, parentSid)
      }

      logger.info('[handler]', 'Originated call')
    } catch (err) {
      logger.error('[handler]', 'Failed to originate call', err)
    }
  }

  /** Place a caller in queue (hold with music) */
  private async execQueue(cmd: QueueCommand): Promise<void> {
    const call = this.calls.get(cmd.channelId)
    if (!call) return

    logger.info('[handler]', 'Queuing channel')

    // Register this channel as the queue for its callSid
    this.queues.set(cmd.channelId, cmd.channelId)

    // Start music on hold
    try {
      await this.client.startMoh(cmd.channelId, cmd.musicOnHold ?? 'default')
    } catch (err) {
      logger.warn('[handler]', 'Failed to start MOH', err)
    }

    // Set up periodic wait callback
    const queueStartTime = Date.now()

    call.queue = {
      startedAt: queueStartTime,
      exitCallbackPath: cmd.exitCallbackPath,
      callbackParams: cmd.callbackParams,
    }

    if (cmd.waitCallbackPath) {
      call.queue.waitTimer = setInterval(async () => {
        const queueTime = Math.floor((Date.now() - queueStartTime) / 1000)

        const payload: WebhookPayload = {
          event: 'wait-music',
          channelId: cmd.channelId,
          callerNumber: call.callerNumber,
          calledNumber: this.hotlineNumber,
          queueTime,
        }

        try {
          const commands = await this.webhook.sendWebhookForCommands(
            cmd.waitCallbackPath!,
            payload,
            cmd.callbackParams
          )

          if (commands) {
            // Check for leave_queue redirect (means leave queue → voicemail)
            const leaveCmd = commands.find(
              (c) => c.action === 'redirect' && 'path' in c && c.path === '__leave_queue__'
            )
            if (leaveCmd) {
              this.cleanupCallQueue(cmd.channelId)
              await this.sendQueueExit(cmd.channelId, call, 'leave')
            }
          }
        } catch (err) {
          logger.error('[handler]', 'Wait callback failed', err)
        }
      }, (cmd.waitCallbackInterval ?? 10) * 1000) as unknown as ReturnType<typeof setTimeout>
    }
  }

  /** Reject a call */
  private async execReject(cmd: RejectCommand): Promise<void> {
    logger.info('[handler]', 'Rejecting channel')
    await this.client.hangup(cmd.channelId)
  }

  /** Redirect — send a new webhook to the Worker */
  private async execRedirect(cmd: RedirectCommand): Promise<void> {
    if (cmd.path === '__leave_queue__') {
      // Handled by queue logic
      return
    }

    logger.info('[handler]', 'Redirect channel')

    const call = this.calls.get(cmd.channelId)
    const payload: WebhookPayload = {
      event: 'incoming', // Generic event for redirects
      channelId: cmd.channelId,
      callerNumber: call?.callerNumber ?? 'unknown',
      calledNumber: this.hotlineNumber,
    }

    const commands = await this.webhook.sendWebhookForCommands(cmd.path, payload, cmd.params)
    if (commands) {
      await this.executeCommands(commands)
    }
  }

  // ================================================================
  // HTTP Command Handler (for commands received from Worker)
  // ================================================================

  /**
   * Handle an HTTP command from the Worker.
   * The Worker can send direct commands to control calls.
   */
  async handleHttpCommand(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    try {
      const action = body.action as string
      if (!action) return { ok: false, error: 'Missing action' }

      switch (action) {
        case 'hangup': {
          const channelId = body.channelId as string
          if (!channelId) return { ok: false, error: 'Missing channelId' }
          await this.client.hangup(channelId)
          return { ok: true }
        }

        case 'ring': {
          const cmd = body as unknown as RingCommand
          await this.execRing(cmd)
          return { ok: true }
        }

        case 'cancelRinging': {
          const channelIds = body.channelIds as string[]
          const exceptId = body.exceptId as string | undefined
          if (!channelIds) return { ok: false, error: 'Missing channelIds' }
          for (const id of channelIds) {
            if (id !== exceptId) {
              try {
                await this.client.hangup(id)
              } catch {
                /* may already be gone */
              }
            }
          }
          return { ok: true }
        }

        case 'getRecordingAudio': {
          return { ok: false, error: 'Use GET /recordings/:name endpoint' }
        }

        case 'status': {
          return {
            ok: true,
            ...this.getStatus(),
          } as { ok: boolean }
        }

        default:
          return { ok: false, error: `Unknown action: ${action}` }
      }
    } catch (err) {
      logger.error('[handler]', 'HTTP command failed', err)
      return { ok: false, error: 'Command failed' }
    }
  }

  /** Get bridge status for monitoring */
  getStatus(): Record<string, unknown> {
    return {
      activeCalls: this.calls.size,
      activeQueues: this.queues.size,
      activeBridges: this.bridges.size,
      ringingChannels: this.ringingMap.size,
      pendingRecordings: this.recordingCallbacks.size,
      untrackedChannels: this.untrackedChannelCount,
    }
  }

  // ================================================================
  // Helper Methods
  // ================================================================

  /** Send gathered DTMF digits to the Worker */
  private async sendGatherResult(
    channelId: string,
    call: ActiveCall,
    digits: string,
    callbackPath: string,
    callbackParams?: Record<string, string>
  ): Promise<void> {
    const payload: WebhookPayload = {
      event: 'language-selected',
      channelId,
      callerNumber: call.callerNumber,
      calledNumber: this.hotlineNumber,
      digits,
    }

    const commands = await this.webhook.sendWebhookForCommands(
      callbackPath,
      payload,
      callbackParams
    )
    if (commands) {
      await this.executeCommands(commands)
    }
  }

  /** Send queue-exit webhook */
  private async sendQueueExit(
    channelId: string,
    call: ActiveCall,
    result: 'leave' | 'queue-full' | 'error' | 'bridged' | 'hangup'
  ): Promise<void> {
    const exitPath = call.queue?.exitCallbackPath
    if (!exitPath) return

    const payload: WebhookPayload = {
      event: 'queue-exit',
      channelId,
      callerNumber: call.callerNumber,
      calledNumber: this.hotlineNumber,
      queueResult: result,
    }

    const commands = await this.webhook.sendWebhookForCommands(
      exitPath,
      payload,
      call.queue?.callbackParams
    )
    if (commands) {
      await this.executeCommands(commands)
    }
  }

  /** Clean up queue state for a call (used by queue leave logic) */
  private cleanupCallQueue(channelId: string): void {
    const call = this.calls.get(channelId)
    if (call?.queue?.waitTimer) {
      clearInterval(call.queue.waitTimer)
      call.queue = undefined
    }
    this.queues.delete(channelId)
  }

  /** Clean up bridge state for a call */
  private cleanupBridge(channelId: string): void {
    for (const [bridgeId, state] of this.bridges) {
      if (state.callerChannelId === channelId || state.volunteerChannelId === channelId) {
        const otherChannel =
          state.callerChannelId === channelId
            ? state.volunteerChannelId
            : state.callerChannelId

        this.client.hangup(otherChannel).catch(() => {})
        this.client.destroyBridge(bridgeId).catch(() => {})
        this.bridges.delete(bridgeId)
      }
    }
  }

  /** Cancel all ringing channels for a call */
  private cancelRingingForCall(channelId: string): void {
    const call = this.calls.get(channelId)
    if (!call) return

    for (const ringId of call.ringingChannels) {
      this.client.hangup(ringId).catch(() => {})
      this.ringingMap.delete(ringId)
    }
    call.ringingChannels = []
  }
}

// Re-export command types for use in executeCommand type narrowing
import type {
  PlaybackCommand,
  GatherCommand,
  BridgeCallCommand,
  HangupCommand,
  RecordCommand,
  RingCommand,
  QueueCommand,
  RejectCommand,
  RedirectCommand,
} from './types'
