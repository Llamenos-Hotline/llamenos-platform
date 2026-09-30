import type {
  BridgeClient,
  BridgeEvent,
  BridgeHealthStatus,
  BridgeOptions,
  OriginateParams,
} from '../bridge-client'
import type {
  AnyAriEvent,
  AriBridge,
  AriChannel,
  AriPlayback,
  BridgeConfig,
  ChannelDestroyedEvent,
  ChannelDtmfReceivedEvent,
  ChannelStateChangeEvent,
  PlaybackFinishedEvent,
  RecordingFailedEvent,
  RecordingFinishedEvent,
  StasisStartEvent,
} from '../types'
import { logger } from '../logger'

type EventHandler = (event: BridgeEvent) => void
type RawEventHandler = (event: AnyAriEvent) => void

/**
 * ARI Client — connects to Asterisk's ARI via WebSocket for events
 * and REST API for commands. No external dependencies; uses built-in
 * WebSocket and fetch.
 *
 * Implements BridgeClient (protocol-agnostic interface) plus ARI-specific
 * helpers (channel variables, dynamic PJSIP config, module reload).
 *
 * Hardening (from lm-asterisk-bridge-hardening):
 * - Set-based event handlers (O(1) add/remove, no duplicates)
 * - Snapshot-before-fanout (copy Set before iterating)
 * - One pending reconnect at a time, cleared in disconnect()
 * - Close old WS before reconnect attempt; a superseded socket's events are ignored
 * - AbortSignal.timeout(30_000) on all fetch calls
 * - Connection deadline for initial connection
 */
export class AriClient implements BridgeClient {
  private config: BridgeConfig
  private ws: WebSocket | null = null
  private eventHandlers = new Set<EventHandler>()
  private rawEventHandlers = new Set<RawEventHandler>()
  private reconnectDelay = 1000
  private readonly maxReconnectDelay = 30_000
  private shouldReconnect = true
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private authHeader: string
  private hasConnected = false
  private connectionDeadline: number | null = null
  private readonly connectionTimeoutMs: number

  constructor(config: BridgeConfig) {
    this.config = config
    this.authHeader = `Basic ${btoa(`${config.ariUsername}:${config.ariPassword}`)}`
    this.connectionTimeoutMs = config.connectionTimeoutMs
  }

  onEvent(handler: EventHandler): void {
    this.eventHandlers.add(handler)
  }

  offEvent(handler: EventHandler): void {
    this.eventHandlers.delete(handler)
  }

  /**
   * Register a handler for raw ARI events.
   * Used by CommandHandler which needs the full ARI event shape.
   */
  onRawEvent(handler: RawEventHandler): void {
    this.rawEventHandlers.add(handler)
  }

  offRawEvent(handler: RawEventHandler): void {
    this.rawEventHandlers.delete(handler)
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  async connect(): Promise<void> {
    this.shouldReconnect = true
    if (!this.hasConnected) {
      this.connectionDeadline = Date.now() + this.connectionTimeoutMs
      logger.info('[ari]', `Will exit if Asterisk is not reachable within ${Math.round(this.connectionTimeoutMs / 1000)}s`)
    }
    await this.doConnect()
  }

  disconnect(): void {
    this.shouldReconnect = false
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const ws = this.ws
    this.ws = null
    ws?.close()
  }

  /**
   * Open the event WebSocket. `this.ws` is always the newest socket — connecting
   * or open — and only its `close` schedules a reconnect: a superseded socket
   * closing late must not tear down its replacement, and a failed attempt must
   * schedule exactly one retry (it used to schedule two, from `close` and from
   * the caller's catch, so the number of concurrent attempts doubled each round).
   */
  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const previous = this.ws
      this.ws = null
      previous?.close()

      // URL-encode the credentials: a generated password (`openssl rand -base64`)
      // contains `+` and `/`, and a raw `+` in a query string decodes as a space.
      const query = new URLSearchParams({
        app: this.config.stasisApp,
        api_key: `${this.config.ariUsername}:${this.config.ariPassword}`,
      })
      logger.info('[ari]', `Connecting to ${this.config.ariUrl}...`)

      const ws = new WebSocket(`${this.config.ariUrl}?${query}`)
      this.ws = ws
      let opened = false

      ws.addEventListener('open', () => {
        if (this.ws !== ws) return
        opened = true
        logger.info('[ari]', 'WebSocket connected')
        this.reconnectDelay = 1000
        this.hasConnected = true
        this.connectionDeadline = null
        resolve()
      })

      ws.addEventListener('message', (event) => {
        this.dispatch(event.data)
      })

      ws.addEventListener('close', (event) => {
        if (this.ws !== ws) return
        logger.info('[ari]', `WebSocket closed: code=${event.code} reason=${event.reason}`)
        this.ws = null
        if (!opened) reject(new Error(`Failed to connect to ARI WebSocket: ${event.code} ${event.reason}`))
        if (this.shouldReconnect) this.scheduleReconnect()
      })

      ws.addEventListener('error', () => {
        // Always followed by `close`, which reports and reconnects.
        if (this.ws === ws) logger.error('[ari]', 'WebSocket error')
      })
    })
  }

  /** Parse one WebSocket message and fan it out to raw and translated handlers */
  private dispatch(raw: unknown): void {
    let data: AnyAriEvent
    try {
      data = JSON.parse(
        typeof raw === 'string' ? raw : new TextDecoder().decode(raw as ArrayBuffer)
      ) as AnyAriEvent
    } catch (err) {
      logger.error('[ari]', 'Failed to parse event', err)
      return
    }

    if (data.type === 'StasisStart') this.holdSubscription((data as StasisStartEvent).channel.id)

    // Snapshot-before-fanout: copy Set before iterating
    for (const handler of [...this.rawEventHandlers]) {
      try {
        handler(data)
      } catch (err) {
        logger.error('[ari]', 'Raw event handler error', err)
      }
    }

    const bridgeEvent = this.translateEvent(data)
    if (bridgeEvent === null) return
    for (const handler of [...this.eventHandlers]) {
      try {
        handler(bridgeEvent)
      } catch (err) {
        logger.error('[ari]', 'Event handler error', err)
      }
    }
  }

  private translateEvent(ariEvent: AnyAriEvent): BridgeEvent | null {
    const timestamp = ariEvent.timestamp

    switch (ariEvent.type) {
      case 'StasisStart': {
        const e = ariEvent as StasisStartEvent
        return {
          type: 'channel_create',
          channelId: e.channel.id,
          callerNumber: e.channel.caller.number,
          calledNumber: e.channel.dialplan.exten,
          args: e.args,
          timestamp,
        }
      }

      case 'ChannelDestroyed': {
        const e = ariEvent as ChannelDestroyedEvent
        return {
          type: 'channel_hangup',
          channelId: e.channel.id,
          cause: e.cause,
          causeText: e.cause_txt,
          timestamp,
        }
      }

      case 'ChannelDtmfReceived': {
        const e = ariEvent as ChannelDtmfReceivedEvent
        return {
          type: 'dtmf_received',
          channelId: e.channel.id,
          digit: e.digit,
          durationMs: e.duration_ms,
          timestamp,
        }
      }

      case 'RecordingFinished': {
        const e = ariEvent as RecordingFinishedEvent
        return {
          type: 'recording_complete',
          channelId: e.recording.target_uri.replace(/^channel:/, ''),
          recordingName: e.recording.name,
          duration: e.recording.duration,
          timestamp,
        }
      }

      case 'RecordingFailed': {
        const e = ariEvent as RecordingFailedEvent
        return {
          type: 'recording_failed',
          channelId: e.recording.target_uri.replace(/^channel:/, ''),
          recordingName: e.recording.name,
          cause: e.recording.cause,
          timestamp,
        }
      }

      case 'PlaybackFinished': {
        const e = ariEvent as PlaybackFinishedEvent
        return {
          type: 'playback_finished',
          channelId: e.playback.target_uri.replace(/^channel:/, ''),
          playbackId: e.playback.id,
          timestamp,
        }
      }

      case 'ChannelStateChange': {
        const e = ariEvent as ChannelStateChangeEvent
        if (e.channel.state === 'Up') {
          return {
            type: 'channel_answer',
            channelId: e.channel.id,
            timestamp,
          }
        }
        return null
      }

      default:
        return null
    }
  }

  /**
   * Keep receiving a channel's events after it leaves Stasis. The subscription
   * that comes with entering Stasis ends at StasisEnd — which a hangup emits
   * *before* ChannelDestroyed — so without this a caller hanging up is never
   * reported, and their queue, ringing legs and bridge are never cleaned up.
   * An explicit subscription lasts until the channel is destroyed.
   */
  private holdSubscription(channelId: string): void {
    const source = new URLSearchParams({ eventSource: `channel:${channelId}` })
    this.request('POST', `/applications/${encodeURIComponent(this.config.stasisApp)}/subscription?${source}`)
      .catch((err) => logger.error('[ari]', 'Failed to subscribe to channel events', err))
  }

  /** Schedule the next connection attempt (at most one pending), backing off exponentially */
  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return
    this.exitIfPastDeadline()

    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(delay * 2, this.maxReconnectDelay)
    const remaining = this.connectionDeadline
      ? ` (${Math.round((this.connectionDeadline - Date.now()) / 1000)}s until timeout)`
      : ''
    logger.info('[ari]', `Reconnecting in ${delay}ms...${remaining}`)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.exitIfPastDeadline()
      // A failed attempt closes its socket, and that close schedules the next one.
      this.doConnect().catch((err) => logger.error('[ari]', 'Reconnection failed', err))
    }, delay)
  }

  /** Before the first successful connection, give up (and let the orchestrator restart us) at the deadline */
  private exitIfPastDeadline(): void {
    if (this.connectionDeadline !== null && Date.now() >= this.connectionDeadline) {
      logger.error('[ari]', `FATAL: Could not connect to Asterisk within ${Math.round(this.connectionTimeoutMs / 1000)}s — exiting.`)
      process.exit(1)
    }
  }

  // ---- ARI REST API ----

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.config.ariRestUrl}${path}`
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
    }

    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(30_000) }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }

    const res = await fetch(url, init)
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`ARI ${method} ${path} failed: ${res.status} ${text}`)
    }

    if (res.status === 204) return undefined as T
    return res.json() as T
  }

  // ---- BridgeClient: Call Control ----

  async originate(params: OriginateParams): Promise<{ id: string }> {
    const channel = await this.originateChannel({
      endpoint: params.endpoint,
      callerId: params.callerId,
      timeout: params.timeout,
      app: this.config.stasisApp,
      appArgs: params.appArgs,
    })
    return { id: channel.id }
  }

  async hangup(channelId: string): Promise<void> {
    await this.hangupChannel(channelId)
  }

  async answer(channelId: string): Promise<void> {
    await this.answerChannel(channelId)
  }

  async bridge(
    channelId1: string,
    channelId2: string,
    options?: BridgeOptions
  ): Promise<string> {
    // ARI has no passthrough bridge type — `simple_bridge` is a bridge
    // *technology*, and asking for it as a type fails with a 500, so every
    // SFrame call's bridge used to fail. A two-channel `mixing` bridge already
    // relays frames untouched (Asterisk picks the native_rtp / simple_bridge
    // technology, not softmix); what would force decoding is a third party
    // such as a recorder, which the Tier 5 guard keeps off SFrame calls.
    if (options?.type === 'passthrough' && options.record) {
      throw new Error('A passthrough (SFrame) bridge must not be recorded')
    }
    const ariBridge = await this.createBridge({ type: 'mixing' })
    await this.addChannelToBridge(ariBridge.id, channelId1)
    await this.addChannelToBridge(ariBridge.id, channelId2)
    if (options?.record) {
      const name = `bridge-${ariBridge.id}-${Date.now()}`
      await this.recordBridge(ariBridge.id, { name })
    }
    return ariBridge.id
  }

  // ---- BridgeClient: System ----

  async healthCheck(): Promise<BridgeHealthStatus> {
    const start = Date.now()
    try {
      const details = await this.getAsteriskInfo()
      return {
        ok: true,
        latencyMs: Date.now() - start,
        details: details as Record<string, unknown>,
      }
    } catch {
      return { ok: false, latencyMs: Date.now() - start }
    }
  }

  async listChannels(): Promise<Array<{ id: string; state: string; caller: string }>> {
    const channels = await this.request<AriChannel[]>('GET', '/channels')
    return channels.map((ch) => ({
      id: ch.id,
      state: ch.state,
      caller: ch.caller.number,
    }))
  }

  async listBridges(): Promise<Array<{ id: string; channels: string[] }>> {
    const bridges = await this.request<AriBridge[]>('GET', '/bridges')
    return bridges.map((b) => ({ id: b.id, channels: b.channels }))
  }

  // ---- Channel Operations ----

  async answerChannel(channelId: string): Promise<void> {
    await this.request('POST', `/channels/${channelId}/answer`)
  }

  async hangupChannel(channelId: string, reason = 'normal'): Promise<void> {
    try {
      await this.request('DELETE', `/channels/${channelId}?reason=${reason}`)
    } catch (err) {
      logger.warn('[ari]', 'Failed to hangup channel', err)
    }
  }

  async originateChannel(params: {
    endpoint: string
    callerId?: string
    timeout?: number
    app: string
    appArgs?: string
    channelId?: string
  }): Promise<AriChannel> {
    const body: Record<string, unknown> = {
      endpoint: params.endpoint,
      app: params.app,
      timeout: params.timeout ?? 30,
    }
    if (params.callerId) body.callerId = params.callerId
    if (params.appArgs) body.appArgs = params.appArgs
    if (params.channelId) body.channelId = params.channelId
    return this.request<AriChannel>('POST', '/channels', body)
  }

  async startMoh(channelId: string, mohClass = 'default'): Promise<void> {
    await this.request('POST', `/channels/${channelId}/moh?mohClass=${mohClass}`)
  }

  async stopMoh(channelId: string): Promise<void> {
    await this.request('DELETE', `/channels/${channelId}/moh`)
  }

  async startRinging(channelId: string): Promise<void> {
    await this.request('POST', `/channels/${channelId}/ring`)
  }

  async stopRinging(channelId: string): Promise<void> {
    await this.request('DELETE', `/channels/${channelId}/ring`)
  }

  async setChannelVar(channelId: string, variable: string, value: string): Promise<void> {
    await this.request(
      'POST',
      `/channels/${channelId}/variable?variable=${variable}&value=${encodeURIComponent(value)}`
    )
  }

  async getChannelVar(channelId: string, variable: string): Promise<string> {
    const res = await this.request<{ value: string }>(
      'GET',
      `/channels/${channelId}/variable?variable=${variable}`
    )
    return res.value
  }

  // ---- Playback Operations ----

  async playMedia(channelId: string, media: string, playbackId?: string): Promise<string> {
    const params = new URLSearchParams({ media })
    if (playbackId) params.set('playbackId', playbackId)
    const playback = await this.request<AriPlayback>(
      'POST',
      `/channels/${channelId}/play?${params}`
    )
    return playback.id
  }

  async stopPlayback(playbackId: string): Promise<void> {
    try {
      await this.request('DELETE', `/playbacks/${playbackId}`)
    } catch {
      // Playback may already be done
    }
  }

  // ---- Bridge Operations ----

  async createBridge(params?: {
    bridgeId?: string
    type?: string
    name?: string
  }): Promise<AriBridge> {
    const body: Record<string, unknown> = {
      type: params?.type ?? 'mixing',
    }
    if (params?.bridgeId) body.bridgeId = params.bridgeId
    if (params?.name) body.name = params.name
    return this.request<AriBridge>('POST', '/bridges', body)
  }

  async addChannelToBridge(bridgeId: string, channelId: string): Promise<void> {
    await this.request('POST', `/bridges/${bridgeId}/addChannel?channel=${channelId}`)
  }

  async removeChannelFromBridge(bridgeId: string, channelId: string): Promise<void> {
    try {
      await this.request('POST', `/bridges/${bridgeId}/removeChannel?channel=${channelId}`)
    } catch {
      // Channel may already be gone
    }
  }

  async destroyBridge(bridgeId: string): Promise<void> {
    try {
      await this.request('DELETE', `/bridges/${bridgeId}`)
    } catch {
      // Bridge may already be gone
    }
  }

  // ---- Recording Operations ----

  async recordChannel(
    channelId: string,
    params: {
      name: string
      format?: string
      maxDurationSeconds?: number
      beep?: boolean
      terminateOn?: string
    }
  ): Promise<void> {
    const body: Record<string, unknown> = {
      name: params.name,
      format: params.format ?? 'wav',
      maxDurationSeconds: params.maxDurationSeconds ?? 0,
      beep: params.beep ?? false,
      terminateOn: params.terminateOn ?? 'none',
    }
    await this.request('POST', `/channels/${channelId}/record`, body)
  }

  async recordBridge(
    bridgeId: string,
    params: {
      name: string
      format?: string
      maxDurationSeconds?: number
    }
  ): Promise<void> {
    const body: Record<string, unknown> = {
      name: params.name,
      format: params.format ?? 'wav',
      maxDurationSeconds: params.maxDurationSeconds ?? 0,
      beep: false,
      terminateOn: 'none',
    }
    await this.request('POST', `/bridges/${bridgeId}/record`, body)
  }

  async stopRecording(recordingName: string): Promise<void> {
    try {
      await this.request('POST', `/recordings/live/${recordingName}/stop`)
    } catch {
      // Recording may already be done
    }
  }

  async getRecordingFile(recordingName: string): Promise<ArrayBuffer | null> {
    const url = `${this.config.ariRestUrl}/recordings/stored/${recordingName}/file`
    const res = await fetch(url, {
      headers: { Authorization: this.authHeader },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return null
    return res.arrayBuffer()
  }

  async deleteRecording(recordingName: string): Promise<void> {
    try {
      await this.request('DELETE', `/recordings/stored/${recordingName}`)
    } catch {
      // Recording may already be deleted
    }
  }

  // ---- Asterisk Operations ----

  async getAsteriskInfo(): Promise<unknown> {
    return this.request('GET', '/asterisk/info')
  }

  /**
   * Write a dynamic config object via ARI.
   * PUT /ari/asterisk/config/dynamic/{configClass}/{objectType}/{id}
   */
  async configureDynamic(
    configClass: string,
    objectType: string,
    id: string,
    fields: Record<string, string>
  ): Promise<void> {
    const body = {
      fields: Object.entries(fields).map(([attribute, value]) => ({ attribute, value })),
    }
    await this.request('PUT', `/asterisk/config/dynamic/${configClass}/${objectType}/${id}`, body)
  }

  async reloadModule(moduleName: string): Promise<void> {
    await this.request('PUT', `/asterisk/modules/${moduleName}`)
  }

  async deleteDynamic(configClass: string, objectType: string, id: string): Promise<void> {
    await this.request('DELETE', `/asterisk/config/dynamic/${configClass}/${objectType}/${id}`)
  }
}
