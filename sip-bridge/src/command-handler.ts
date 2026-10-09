import type { BridgeClient, BridgeEvent } from './bridge-client'
import type { WebhookSender } from './webhook-sender'
import {
  CALLBACK_PATHS,
  WORKER_PATHS,
  type ActiveCall,
  type BridgeCallCommand,
  type BridgeCommand,
  type BridgeConfig,
  type CallLegStatus,
  type GatherCommand,
  type PendingRecording,
  type QueueCommand,
  type QueueExitResult,
  type RecordCommand,
  type VolunteerLeg,
  type WebhookPayload,
} from './types'
import { type CallMode, SframeModeDispatcher, parseStasisArgs } from './sframe-mode-dispatcher'
import { logger } from './logger'

/** How long after a recording must have ended its finish event may still arrive */
const RECORDING_FINISH_GRACE_MS = 5 * 60 * 1000 // 5 minutes
/** Interval for the stale-recording sweep */
const RECORDING_SWEEP_INTERVAL_MS = 60 * 1000 // 60 seconds
/** How often a queued caller's wait-music callback is re-polled */
const QUEUE_WAIT_INTERVAL_MS = 10_000
/** How long a volunteer's phone rings before the leg gives up */
const RING_TIMEOUT_SECONDS = 30

/** A volunteer phone to ring for a waiting caller (POST /ring from the worker) */
export interface RingRequest {
  parentCallSid: string
  callerNumber: string
  /** `pubkey` carries the opaque call token, never a real pubkey */
  volunteers: Array<{ pubkey: string; phone: string }>
  /**
   * In-app volunteers: each is a SIP endpoint registered on THIS PBX, rung by
   * an INVITE to its AOR rather than a call out through the trunk. One more
   * parallel leg per entry, in the same leg registry as the phone legs.
   */
  appTargets?: Array<{ callToken: string; sipAor: string }>
}

/**
 * The caller ID an in-app leg presents. The app already knows which call is
 * ringing (its push payload carries the call id and the caller's last four
 * digits), so the INVITE does not need to carry the caller's number — and the
 * app's own UI deliberately shows only the last four. A name with no number
 * keeps that contract instead of widening it.
 */
const IN_APP_CALLER_ID = 'Llamenos'

/**
 * CommandHandler — the call-flow state machine between the PBX and the Worker.
 *
 * 1. Translates protocol-agnostic BridgeEvents into signed Worker webhooks.
 * 2. Executes the JSON commands the Worker answers with (see BridgeCommand).
 *    A command acts on the channel of the webhook it answered.
 * 3. Rings volunteers for a queued caller and bridges the first to pick up.
 * 4. Enforces the Tier 5 SFrame recording ban via SframeModeDispatcher.
 */
export class CommandHandler {
  private readonly client: BridgeClient
  private readonly webhook: WebhookSender
  private readonly config: BridgeConfig
  private readonly sframeDispatcher = new SframeModeDispatcher()

  /** Caller legs by channel ID. Pruned on channel_hangup. */
  private readonly calls = new Map<string, ActiveCall>()

  /** Queue name (= the caller's call SID) → caller channel ID. Pruned when the caller leaves the queue. */
  private readonly queues = new Map<string, string>()

  /** Volunteer legs by channel ID. Pruned on the leg's hangup or cancellation. */
  private readonly legs = new Map<string, VolunteerLeg>()

  /** Bridge ID → the two channels in it. Pruned when either side hangs up. */
  private readonly bridges = new Map<string, { callerChannelId: string; volunteerChannelId: string }>()

  /** Recordings in progress by recording name. Pruned on finish/failure, or past their deadline. */
  private readonly recordings = new Map<string, PendingRecording>()

  /** Channels present on the PBX at last reconcile that this handler holds no state for. */
  private untrackedChannelCount = 0

  /** Configured hotline number (fallback calledNumber when the dialplan provides none) */
  private hotlineNumber = ''

  private readonly recordingSweepTimer: ReturnType<typeof setInterval>

  constructor(client: BridgeClient, webhook: WebhookSender, config: BridgeConfig) {
    this.client = client
    this.webhook = webhook
    this.config = config

    this.recordingSweepTimer = setInterval(() => {
      this.pruneStaleRecordings()
    }, RECORDING_SWEEP_INTERVAL_MS)
  }

  /** Stop background timers (for graceful shutdown) */
  dispose(): void {
    clearInterval(this.recordingSweepTimer)
    for (const call of this.calls.values()) this.clearTimers(call)
  }

  /** Set the hotline phone number (for webhook payloads) */
  setHotlineNumber(number: string): void {
    this.hotlineNumber = number
  }

  /** Bridge status for monitoring */
  getStatus(): Record<string, number> {
    return {
      activeCalls: this.calls.size,
      activeQueues: this.queues.size,
      activeBridges: this.bridges.size,
      ringingChannels: [...this.legs.values()].filter((l) => !l.answered).length,
      pendingRecordings: this.recordings.size,
      untrackedChannels: this.untrackedChannelCount,
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
        // Informational — a volunteer leg's answer arrives as its channel_create
        // (an originated channel enters Stasis when it is answered).
        break
      case 'channel_hangup':
        await this.onChannelHangup(event)
        break
      case 'hangup_requested': {
        const call = this.calls.get(event.channelId)
        if (call) call.hangupRequested = true
        break
      }
      case 'dtmf_received':
        await this.onDtmfReceived(event)
        break
      case 'recording_complete':
        await this.onRecordingDone(event.recordingName, 'done')
        break
      case 'recording_failed':
        await this.onRecordingDone(event.recordingName, 'failed')
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
    // `queues` is keyed by queue name; its VALUES are the queued caller's channel.
    for (const id of this.queues.values()) ids.add(id)
    for (const id of this.legs.keys()) ids.add(id)
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
   * - state we track for a channel the PBX no longer has -> the hangup event was
   *   missed: run the normal hangup path (queue-exit / call-status webhooks, timers,
   *   bridge and recording cleanup).
   * - the PBX cannot be enumerated -> we cannot trust ANY tracked state: hang up
   *   the tracked channels and tear their state down.
   * - channels present on the PBX that we hold no state for -> cannot be served
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

  /** channel_create — a channel entered the bridge application */
  private async onChannelCreate(event: BridgeEvent & { type: 'channel_create' }): Promise<void> {
    const args = event.args ?? []

    // A volunteer leg we originated, now answered: args = dialed,<parentCallSid>,<callToken>
    if (args[0] === 'dialed') {
      const [, parentCallSid, callToken] = args
      if (!parentCallSid || !callToken) {
        logger.error('[handler]', 'Answered volunteer leg is missing its parent call or token — hanging up')
        await this.client.hangup(event.channelId)
        return
      }
      await this.onVolunteerAnswered(event.channelId, parentCallSid, callToken)
      return
    }

    // Incoming call. The dialplan passes `sframe` from [volunteers-sframe];
    // PSTN trunk contexts pass no args, which is mode='pstn'.
    const callMode = parseStasisArgs(args)
    logger.debug('[handler]', `channel_create mode=${callMode.mode}`)

    await this.client.answer(event.channelId)

    const call: ActiveCall = {
      channelId: event.channelId,
      callerNumber: event.callerNumber || 'unknown',
      calledNumber: event.calledNumber || this.hotlineNumber,
      startedAt: Date.now(),
      mode: callMode.mode,
      ringingChannels: [],
      pendingPlaybacks: new Set(),
      dtmfBuffer: '',
    }
    this.calls.set(event.channelId, call)

    const commands = await this.post(WORKER_PATHS.incoming, this.payload('incoming', call))
    if (commands === null) {
      // Without the worker there is no call flow at all: the caller would sit in
      // silence indefinitely. End the call instead.
      logger.error('[handler]', 'Worker did not accept the incoming call — hanging up')
      await this.client.hangup(event.channelId)
      return
    }
    await this.executeCommands(event.channelId, commands)
  }

  /** channel_hangup — a channel was destroyed */
  private async onChannelHangup(event: BridgeEvent & { type: 'channel_hangup' }): Promise<void> {
    logger.debug('[handler]', `channel_hangup cause=${event.cause}`)

    const leg = this.legs.get(event.channelId)
    if (leg) {
      await this.onVolunteerLegEnded(event.channelId, leg, event.cause)
      return
    }

    const call = this.calls.get(event.channelId)
    if (!call) return

    this.clearTimers(call)
    this.calls.delete(event.channelId)

    if (call.queue) {
      this.queues.delete(call.queue.queueName)
      await this.sendQueueExit(call, call.queue, 'hangup')
    }

    // First-pickup-wins bookkeeping: nobody can answer a caller who is gone.
    this.cancelLegs(call.ringingChannels)
    call.ringingChannels = []

    // Bridged: take the volunteer down too. Its own hangup reports `completed`.
    await this.teardownBridge(event.channelId)
  }

  /** A volunteer leg ended — report its outcome and release the caller if they were bridged */
  private async onVolunteerLegEnded(channelId: string, leg: VolunteerLeg, cause: number): Promise<void> {
    this.legs.delete(channelId)
    const parent = this.calls.get(leg.parentCallSid)
    if (parent) {
      parent.ringingChannels = parent.ringingChannels.filter((id) => id !== channelId)
    }

    // Release the caller first: they must not sit in a dead bridge while the
    // worker is being told.
    await this.teardownBridge(channelId)

    const payload: WebhookPayload = {
      event: 'call-status',
      channelId,
      callerNumber: parent?.callerNumber ?? 'unknown',
      calledNumber: parent?.calledNumber ?? this.hotlineNumber,
      status: leg.answered ? 'completed' : legStatusFromCause(cause),
    }
    await this.post(WORKER_PATHS.callStatus, payload, { callToken: leg.callToken })
  }

  /** DTMF digit received */
  private async onDtmfReceived(event: BridgeEvent & { type: 'dtmf_received' }): Promise<void> {
    const call = this.calls.get(event.channelId)
    const gather = call?.activeGather
    if (!call || !gather) return

    // Barge-in: the first digit cuts off the remaining prompts.
    if (call.dtmfBuffer === '') await this.stopPrompts(call)

    call.dtmfBuffer += event.digit
    if (call.dtmfBuffer.length >= gather.numDigits) {
      await this.completeGather(call)
    }
  }

  /**
   * A prompt finished. Once none are left, a waiting gather starts its input
   * timeout, and a call the worker ended is hung up.
   */
  private async onPlaybackFinished(event: BridgeEvent & { type: 'playback_finished' }): Promise<void> {
    const call = this.calls.get(event.channelId)
    if (!call) return
    // Still ours: not one stopPrompts() cut off (a stopped playback reports done anyway).
    const ours = call.pendingPlaybacks.delete(event.playbackId)
    if (event.failed && ours && !call.hangupRequested) {
      // Asterisk reports a prompt it could not fetch or decode only here: the
      // caller heard silence, which is otherwise indistinguishable from a prompt.
      logger.error('[handler]', `Prompt failed to play — the caller heard nothing: ${redactMediaUri(event.media)}`)
    }
    if (call.pendingPlaybacks.size > 0) return
    if (call.hangupAfterPrompts) {
      await this.client.hangup(call.channelId)
    } else if (call.activeGather && !call.activeGather.timeoutTimer) {
      this.startGatherTimeout(call)
    }
  }

  /** A recording finished or failed — report it to the route that asked for it */
  private async onRecordingDone(recordingName: string, status: 'done' | 'failed'): Promise<void> {
    const recording = this.recordings.get(recordingName)
    if (!recording) return
    this.recordings.delete(recordingName)

    const call = this.calls.get(recording.channelId)
    const payload: WebhookPayload = {
      event: recording.kind === 'voicemail' ? 'voicemail-recording' : 'call-recording',
      channelId: recording.channelId,
      callerNumber: call?.callerNumber ?? 'unknown',
      calledNumber: call?.calledNumber ?? this.hotlineNumber,
      recordingStatus: status,
      recordingName,
    }

    if (recording.kind === 'call') {
      await this.post(WORKER_PATHS.callRecording, payload, recording.params)
      return
    }

    await this.post(CALLBACK_PATHS.recording_complete, payload, recording.params)
    // The caller is still on the line (they pressed the finish key or hit the
    // time limit): play the worker's closing prompt and hang up.
    if (call) {
      const commands = await this.post(
        WORKER_PATHS.voicemailComplete,
        { ...payload, event: 'voicemail-complete' },
        recording.params
      )
      if (commands) await this.executeCommands(call.channelId, commands)
    }
  }

  // ================================================================
  // Volunteer Ringing
  // ================================================================

  /**
   * Ring every volunteer phone for a caller waiting in the queue. The first leg
   * the worker accepts on /user-answer is bridged; the others are hung up.
   * @returns the originated leg channel IDs
   */
  async ringVolunteers(request: RingRequest): Promise<string[]> {
    const parent = this.calls.get(request.parentCallSid)
    if (!parent) {
      logger.warn('[handler]', 'Ring requested for a caller who is no longer on the line')
      return []
    }

    const channelIds: string[] = []
    for (const volunteer of request.volunteers) {
      const id = await this.originateRingLeg(parent, request.parentCallSid, volunteer.pubkey, {
        endpoint: () => ringEndpoint(this.config.pbxType, volunteer.phone),
        callerId: request.callerNumber,
        what: 'volunteer phone',
      })
      if (id) channelIds.push(id)
    }

    // In-app legs: an INVITE to the volunteer's registered AOR on this PBX.
    // Rung alongside the phone legs, not instead of them — a volunteer with
    // both answers on whichever is to hand, and the first pickup cancels the
    // rest through the same registry.
    const appTargets = request.appTargets ?? []
    let appChannels = 0
    for (const target of appTargets) {
      const id = await this.originateRingLeg(parent, request.parentCallSid, target.callToken, {
        endpoint: () => appRingEndpoint(this.config.pbxType, target.sipAor),
        callerId: IN_APP_CALLER_ID,
        what: 'in-app volunteer endpoint',
      })
      if (id) {
        channelIds.push(id)
        appChannels += 1
      }
    }

    logger.info(
      '[handler]',
      `Ringing ${channelIds.length - appChannels}/${request.volunteers.length} volunteer phone(s)` +
        ` and ${appChannels}/${appTargets.length} in-app endpoint(s)`
    )
    return channelIds
  }

  /**
   * Originate one parallel ring leg and record it against the caller. Returns
   * the leg's channel id, or null when the PBX refused it — a refusal is one
   * leg lost, never the whole ring: the other legs still carry the call.
   */
  private async originateRingLeg(
    parent: ActiveCall,
    parentCallSid: string,
    callToken: string,
    leg: { endpoint: () => string; callerId: string; what: string }
  ): Promise<string | null> {
    // Resolved inside the try: a PBX type that cannot originate at all
    // (kamailio) is one more reason this leg does not happen, not a reason the
    // whole ring fails.
    let endpoint = leg.what
    try {
      endpoint = leg.endpoint()
      const channel = await this.client.originate({
        endpoint,
        callerId: leg.callerId,
        timeout: RING_TIMEOUT_SECONDS,
        appArgs: `dialed,${parentCallSid},${callToken}`,
      })
      this.legs.set(channel.id, { parentCallSid, callToken, answered: false })
      parent.ringingChannels.push(channel.id)
      return channel.id
    } catch (err) {
      // Unreachable endpoint, TLS failure, a PBX that will not originate: the
      // leg is gone and the caller must not depend on it silently.
      logger.error('[handler]', `Failed to ring ${leg.what} (${endpoint})`, err)
      return null
    }
  }

  /** Stop ringing volunteer legs (the worker cancels them when someone answers elsewhere) */
  cancelRinging(channelIds: string[], exceptId?: string): void {
    this.cancelLegs(channelIds.filter((id) => id !== exceptId))
  }

  /** A volunteer picked up — the worker decides (atomically) whether this leg won the call */
  private async onVolunteerAnswered(
    channelId: string,
    parentCallSid: string,
    callToken: string
  ): Promise<void> {
    logger.info('[handler]', 'Volunteer answered call')

    const leg = this.legs.get(channelId) ?? { parentCallSid, callToken, answered: false }
    leg.answered = true
    this.legs.set(channelId, leg)

    const parent = this.calls.get(parentCallSid)
    const payload: WebhookPayload = {
      event: 'volunteer-answer',
      channelId,
      callerNumber: parent?.callerNumber ?? 'unknown',
      calledNumber: parent?.calledNumber ?? this.hotlineNumber,
    }
    const commands = await this.post(WORKER_PATHS.userAnswer, payload, { callToken })
    if (commands === null) {
      // Refused: another volunteer already has this call, or the token expired.
      logger.info('[handler]', 'Worker refused the answer — hanging up this leg')
      this.legs.delete(channelId)
      await this.client.hangup(channelId)
      return
    }
    await this.executeCommands(channelId, commands)
  }

  // ================================================================
  // Command Execution
  // ================================================================

  /** Execute the Worker's commands, in order, on `channelId` */
  async executeCommands(channelId: string, commands: BridgeCommand[]): Promise<void> {
    for (const cmd of commands) {
      try {
        await this.executeCommand(channelId, cmd)
      } catch (err) {
        logger.error('[handler]', `Command failed: ${cmd.action}`, err)
      }
    }
  }

  private async executeCommand(channelId: string, cmd: BridgeCommand): Promise<void> {
    switch (cmd.action) {
      case 'play':
        await this.playPrompt(channelId, `sound:${cmd.url}`)
        break
      case 'gather':
        await this.execGather(channelId, cmd)
        break
      case 'queue':
        await this.execQueue(channelId, cmd)
        break
      case 'leave_queue':
        await this.execLeaveQueue(channelId)
        break
      case 'bridge':
        await this.execBridge(channelId, cmd)
        break
      case 'record':
        await this.execRecord(channelId, cmd)
        break
      case 'hangup':
        await this.hangupAfterPrompts(channelId)
        break
      default: {
        // The worker and the bridge disagreeing on the vocabulary is exactly how
        // every call used to sit in silence: never drop a command quietly.
        const unknown: never = cmd
        logger.error('[handler]', `Unknown command action: ${JSON.stringify(unknown)}`)
      }
    }
  }

  /**
   * Queue a prompt on the channel and track it until PlaybackFinished. The ID
   * is ours and tracked before the request: a prompt that fails at once can
   * report PlaybackFinished before the play request returns, and an ID added
   * after that would never be cleared — the call would never hang up.
   */
  private async playPrompt(channelId: string, media: string): Promise<void> {
    const pending = this.calls.get(channelId)?.pendingPlaybacks
    const requestedId = `prompt-${crypto.randomUUID()}`
    pending?.add(requestedId)
    let playbackId: string
    try {
      playbackId = await this.client.playMedia(channelId, media, requestedId)
    } catch (err) {
      pending?.delete(requestedId)
      throw err
    }
    // A PBX that names its own playbacks (ESL) is tracked by its name.
    if (playbackId !== requestedId && pending?.delete(requestedId)) pending.add(playbackId)
  }

  /**
   * End the call — after the prompts before it have played. ARI runs a
   * channel's playbacks in order but a hangup at once, so `play` then `hangup`
   * (a rate-limited caller's message, the voicemail thank-you) would otherwise
   * cut the caller off before they hear a word.
   */
  private async hangupAfterPrompts(channelId: string): Promise<void> {
    const call = this.calls.get(channelId)
    if (call && call.pendingPlaybacks.size > 0) {
      call.hangupAfterPrompts = true
      return
    }
    await this.client.hangup(channelId)
  }

  /** Stop every prompt still queued or playing on the call */
  private async stopPrompts(call: ActiveCall): Promise<void> {
    const pending = [...call.pendingPlaybacks]
    call.pendingPlaybacks.clear()
    for (const id of pending) await this.client.stopPlayback(id)
  }

  /** Collect digits; the input timeout starts once the preceding prompts finish */
  private async execGather(channelId: string, cmd: GatherCommand): Promise<void> {
    const call = this.calls.get(channelId)
    if (!call) return

    // A new gather replaces any pending one — and its timer.
    if (call.activeGather?.timeoutTimer) clearTimeout(call.activeGather.timeoutTimer)
    call.dtmfBuffer = ''
    call.activeGather = {
      numDigits: cmd.numDigits,
      timeout: cmd.timeout,
      callbackEvent: cmd.callbackEvent,
      metadata: cmd.metadata,
    }

    if (cmd.numDigits <= 0) {
      // Nothing to collect (e.g. single-language hotline): answer straight away.
      await this.completeGather(call)
      return
    }
    if (call.pendingPlaybacks.size === 0) this.startGatherTimeout(call)
  }

  private startGatherTimeout(call: ActiveCall): void {
    const gather = call.activeGather
    if (!gather) return
    gather.timeoutTimer = setTimeout(() => {
      if (call.activeGather === gather) {
        this.completeGather(call).catch((err) => logger.error('[handler]', 'Gather timeout callback failed', err))
      }
    }, gather.timeout * 1000)
  }

  /** Post the collected digits (possibly none) to the gather's callback route */
  private async completeGather(call: ActiveCall): Promise<void> {
    const gather = call.activeGather
    if (!gather) return
    if (gather.timeoutTimer) clearTimeout(gather.timeoutTimer)
    call.activeGather = undefined
    const digits = call.dtmfBuffer
    call.dtmfBuffer = ''

    const payload: WebhookPayload = {
      ...this.payload(gather.callbackEvent === 'language_selected' ? 'language-selected' : 'captcha', call),
      digits,
    }
    const commands = await this.post(CALLBACK_PATHS[gather.callbackEvent], payload, gather.metadata)
    if (commands) await this.executeCommands(call.channelId, commands)
  }

  /** Hold the caller until a volunteer is bridged or the worker says to leave */
  private async execQueue(channelId: string, cmd: QueueCommand): Promise<void> {
    const call = this.calls.get(channelId)
    if (!call) return

    logger.info('[handler]', 'Queuing caller')
    this.queues.set(cmd.queueName, channelId)
    const queue: NonNullable<ActiveCall['queue']> = {
      queueName: cmd.queueName,
      metadata: cmd.metadata,
      startedAt: Date.now(),
    }
    call.queue = queue

    try {
      await this.client.startMoh(channelId)
    } catch (err) {
      logger.warn('[handler]', 'Failed to start music on hold', err)
    }

    const pollWaitMusic = async (): Promise<void> => {
      if (call.queue !== queue) return
      const payload: WebhookPayload = {
        ...this.payload('wait-music', call),
        queueTime: Math.floor((Date.now() - queue.startedAt) / 1000),
      }
      const commands = await this.post(CALLBACK_PATHS.wait_music, payload, queue.metadata)
      if (commands && call.queue === queue) await this.executeCommands(channelId, commands)
    }
    queue.waitTimer = setInterval(() => {
      pollWaitMusic().catch((err) => logger.error('[handler]', 'Wait-music callback failed', err))
    }, QUEUE_WAIT_INTERVAL_MS)
    await pollWaitMusic()
  }

  /** Leave the queue — the worker's queue-exit answer sends the caller to voicemail */
  private async execLeaveQueue(channelId: string): Promise<void> {
    const call = this.calls.get(channelId)
    const queue = call?.queue
    if (!call || !queue) return

    this.exitQueue(call)
    await this.client.stopMoh(channelId).catch(() => {})
    this.cancelLegs(call.ringingChannels)
    call.ringingChannels = []

    const commands = await this.sendQueueExit(call, queue, 'leave')
    if (commands) await this.executeCommands(channelId, commands)
  }

  /** Bridge this volunteer leg with the caller waiting in cmd.queueName */
  private async execBridge(volunteerChannelId: string, cmd: BridgeCallCommand): Promise<void> {
    const callerChannelId = this.queues.get(cmd.queueName)
    const caller = callerChannelId ? this.calls.get(callerChannelId) : undefined
    if (!callerChannelId || !caller) {
      logger.warn('[handler]', 'Caller left before the volunteer was bridged — hanging up the volunteer')
      this.legs.delete(volunteerChannelId)
      await this.client.hangup(volunteerChannelId)
      return
    }

    logger.info('[handler]', 'Bridging caller and volunteer')
    this.exitQueue(caller)
    await this.stopPrompts(caller)
    await this.client.stopMoh(callerChannelId).catch(() => {})

    // First pickup wins: every other phone stops ringing.
    this.cancelLegs(caller.ringingChannels.filter((id) => id !== volunteerChannelId))
    caller.ringingChannels = []

    // SFrame E2EE calls must pass media through untouched.
    const bridgeId = await this.client.bridge(callerChannelId, volunteerChannelId, {
      type: caller.mode === 'sframe' ? 'passthrough' : 'mixing',
      record: false, // recorded below, behind the Tier 5 guard
    })
    this.bridges.set(bridgeId, { callerChannelId, volunteerChannelId })
    caller.bridgeId = bridgeId

    if (!cmd.record) return
    try {
      this.sframeDispatcher.assertRecordingAllowed({ mode: caller.mode })
    } catch (err) {
      logger.warn('[handler]', 'Skipping bridge recording (Tier 5 SFrame)', err)
      return
    }

    const recordingName = callRecordingName(callerChannelId)
    try {
      await this.client.recordBridge(bridgeId, { name: recordingName, format: 'wav' })
      // No deadline while the bridge is up — a crisis call can run for hours.
      this.recordings.set(recordingName, {
        kind: 'call',
        channelId: callerChannelId,
        params: { parentCallSid: cmd.queueName },
      })
    } catch (err) {
      logger.error('[handler]', 'Failed to start bridge recording', err)
    }
  }

  /** Record a voicemail — enforces the Tier 5 SFrame recording ban */
  private async execRecord(channelId: string, cmd: RecordCommand): Promise<void> {
    // Untracked channels default to 'sframe' (fail closed): never record by accident.
    const guardMode: CallMode = { mode: this.calls.get(channelId)?.mode ?? 'sframe' }
    try {
      this.sframeDispatcher.assertRecordingAllowed(guardMode)
    } catch (err) {
      logger.warn('[handler]', 'Skipping channel recording (Tier 5 SFrame)', err)
      return
    }

    const recordingName = voicemailRecordingName(channelId)
    await this.client.recordChannel(channelId, {
      name: recordingName,
      format: 'wav',
      maxDurationSeconds: cmd.maxDuration,
      beep: true,
      terminateOn: cmd.finishOnKey,
    })
    this.recordings.set(recordingName, {
      kind: 'voicemail',
      channelId,
      params: cmd.metadata ?? {},
      expiresAt: Date.now() + cmd.maxDuration * 1000 + RECORDING_FINISH_GRACE_MS,
    })
  }

  // ================================================================
  // Helpers
  // ================================================================

  /** Base webhook payload for a caller leg */
  private payload(event: WebhookPayload['event'], call: ActiveCall): WebhookPayload {
    return {
      event,
      channelId: call.channelId,
      callerNumber: call.callerNumber,
      calledNumber: call.calledNumber,
    }
  }

  /**
   * POST a webhook and return the commands the worker answered with.
   * null = the worker refused (non-2xx) or was unreachable.
   */
  private async post(
    path: string,
    payload: WebhookPayload,
    query?: Record<string, string>
  ): Promise<BridgeCommand[] | null> {
    try {
      return await this.webhook.sendWebhookForCommands(path, payload, query)
    } catch (err) {
      logger.error('[handler]', `Webhook ${path} failed`, err)
      return null
    }
  }

  private async sendQueueExit(
    call: ActiveCall,
    queue: NonNullable<ActiveCall['queue']>,
    result: QueueExitResult
  ): Promise<BridgeCommand[] | null> {
    const payload: WebhookPayload = { ...this.payload('queue-exit', call), result }
    return this.post(CALLBACK_PATHS.queue_exit, payload, queue.metadata)
  }

  /** Drop the caller's queue state (does not notify the worker) */
  private exitQueue(call: ActiveCall): void {
    if (!call.queue) return
    clearInterval(call.queue.waitTimer)
    this.queues.delete(call.queue.queueName)
    call.queue = undefined
  }

  private clearTimers(call: ActiveCall): void {
    if (call.activeGather?.timeoutTimer) clearTimeout(call.activeGather.timeoutTimer)
    call.activeGather = undefined
    if (call.queue?.waitTimer) clearInterval(call.queue.waitTimer)
  }

  /** Hang up volunteer legs that will not be bridged. Their hangups report nothing. */
  private cancelLegs(channelIds: string[]): void {
    for (const id of channelIds) {
      this.legs.delete(id)
      this.client.hangup(id).catch(() => {})
    }
  }

  /**
   * If the channel is in a bridge, end the bridge: stop its recording, hang up
   * the other side, destroy it. The recording is stopped first, while the bridge
   * still exists — its RecordingFinished event is published on the bridge, and
   * once the bridge is destroyed that event is never delivered.
   */
  private async teardownBridge(channelId: string): Promise<void> {
    for (const [bridgeId, state] of this.bridges) {
      if (state.callerChannelId !== channelId && state.volunteerChannelId !== channelId) continue
      const other = state.callerChannelId === channelId ? state.volunteerChannelId : state.callerChannelId
      this.bridges.delete(bridgeId)

      const recordingName = callRecordingName(state.callerChannelId)
      const recording = this.recordings.get(recordingName)
      if (recording) {
        recording.expiresAt = Date.now() + RECORDING_FINISH_GRACE_MS
        await this.client.stopRecording(recordingName)
      }
      await this.client.hangup(other).catch(() => {})
      await this.client.destroyBridge(bridgeId).catch(() => {})
      // `continue`, not `return`: a channel should only ever be in one bridge, but if
      // stale state ever puts it in two, leaving the second behind leaks a live leg.
    }
  }

  /**
   * Drop recordings whose finish event never came. A recording outlives its
   * channel on purpose — Asterisk emits RecordingFinished after the hangup that
   * ended it, and that event is what tells the worker a recording exists — so
   * entries expire by deadline, not by hangup.
   */
  private pruneStaleRecordings(): void {
    const now = Date.now()
    for (const [name, entry] of this.recordings) {
      if (entry.expiresAt !== undefined && now > entry.expiresAt) this.recordings.delete(name)
    }
  }
}

/** The dial string that rings a volunteer's phone through the PBX's SIP trunk */
export function ringEndpoint(pbxType: BridgeConfig['pbxType'], phone: string): string {
  switch (pbxType) {
    case 'asterisk':
      return `PJSIP/${phone}@trunk`
    case 'freeswitch':
      return `sofia/internal/${phone}@trunk`
    case 'kamailio':
      throw new Error('Kamailio is a SIP proxy — call origination is not supported')
  }
}

/**
 * The endpoint that rings a volunteer's own registered app, as opposed to
 * their phone: the AOR on this PBX, with no trunk — the INVITE goes to the
 * contact the client registered, not out to a carrier.
 */
export function appRingEndpoint(pbxType: BridgeConfig['pbxType'], sipAor: string): string {
  switch (pbxType) {
    case 'asterisk':
      return `PJSIP/${sipAor}`
    case 'freeswitch':
      return `sofia/internal/${sipAor}`
    case 'kamailio':
      throw new Error('Kamailio is a SIP proxy — call origination is not supported')
  }
}

/**
 * Recording names are derived from the caller's channel ID — which is the call
 * SID the worker knows the call by — so GET /recordings/call/:callSid can find
 * a call's recording after a bridge restart.
 */
export function callRecordingName(callSid: string): string {
  return `call-${callSid}`
}

export function voicemailRecordingName(callSid: string): string {
  return `voicemail-${callSid}`
}

/** Map a Q.850 hangup cause on an unanswered volunteer leg to the worker's call status */
export function legStatusFromCause(cause: number): CallLegStatus {
  switch (cause) {
    case 17: // user busy
      return 'busy'
    case 18: // no user responding
    case 19: // no answer
      return 'no-answer'
    default:
      return 'failed'
  }
}

/** A media URI without its query string: the signature that lets anyone fetch it stays out of logs */
function redactMediaUri(media: string): string {
  return media.replace(/\?.*$/, '')
}
