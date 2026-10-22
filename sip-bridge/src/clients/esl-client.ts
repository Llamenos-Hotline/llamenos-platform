import type {
  BridgeClient,
  BridgeEvent,
  BridgeHealthStatus,
  BridgeOptions,
  OriginateParams,
} from '../bridge-client'
import { logger } from '../logger'

export interface EslConfig {
  host: string
  port: number
  password: string
  connectionTimeoutMs?: number
}

type EventHandler = (event: BridgeEvent) => void

/** Events the bridge needs from FreeSWITCH — re-sent on EVERY (re)connect. */
const EVENT_SUBSCRIPTION = 'event plain CHANNEL_CREATE CHANNEL_ANSWER CHANNEL_HANGUP_COMPLETE RECORD_STOP DTMF'

/** How long an API command may wait for its reply before it is failed. */
const COMMAND_TIMEOUT_MS = 10_000

/** Random +/- fraction applied to reconnect delays so bridges do not reconnect in lockstep. */
const RECONNECT_JITTER = 0.2

interface PendingCommand {
  resolve: (result: string) => void
  reject: (err: Error) => void
  /** Set when the command timed out — its late reply is still consumed (FIFO matching) but ignored. */
  settled: boolean
  timer: ReturnType<typeof setTimeout> | null
}

interface EslMessage {
  headers: Record<string, string>
  body: string
}

/**
 * ESL Client — connects to FreeSWITCH's Event Socket Library over TCP.
 * Authenticates, subscribes to call events, and translates them to normalized
 * BridgeEvent objects via the BridgeClient interface.
 *
 * Hardening applied:
 * - Set-based event handlers
 * - Snapshot-before-fanout
 * - Reconnect timer tracking + cleanup
 * - Connection deadline for initial connection
 */
export class EslClient implements BridgeClient {
  private readonly config: EslConfig
  private socket: ReturnType<typeof Bun.connect> | null = null
  private eventHandlers = new Set<EventHandler>()
  private connected = false
  private shouldReconnect = true
  private reconnectDelay = 1000
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly maxReconnectDelay = 30_000
  /** True once the CURRENT connection has authenticated AND subscribed. Reset on every close. */
  private hasConnected = false
  /** True once the CURRENT connection's `auth` command was accepted. Reset on every close. */
  private authenticated = false
  /** True once any connection has completed its handshake — later ones are reconnects. */
  private hasEverConnected = false
  private connectionDeadline: number | null = null
  private readonly connectionTimeoutMs: number

  private buffer = ''

  private commandQueue: PendingCommand[] = []

  constructor(config: Partial<EslConfig> & { password: string }) {
    this.config = {
      host: config.host ?? 'localhost',
      port: config.port ?? 8021,
      password: config.password,
    }
    this.connectionTimeoutMs = config.connectionTimeoutMs ?? 5 * 60 * 1000
  }

  onEvent(handler: EventHandler): void {
    this.eventHandlers.add(handler)
  }

  offEvent(handler: EventHandler): void {
    this.eventHandlers.delete(handler)
  }

  isConnected(): boolean {
    return this.connected
  }

  async connect(): Promise<void> {
    this.shouldReconnect = true
    if (!this.hasEverConnected) {
      this.connectionDeadline = Date.now() + this.connectionTimeoutMs
      logger.info('[esl]', `Will exit if FreeSWITCH is not reachable within ${Math.round(this.connectionTimeoutMs / 1000)}s`)
    }
    await this.doConnect()
  }

  disconnect(): void {
    this.shouldReconnect = false
    this.resetConnectionState('Disconnected')
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.socket) {
      try {
        const sock = this.socket as unknown as { end: () => void; destroy: () => void }
        if (typeof sock.end === 'function') sock.end()
        else if (typeof sock.destroy === 'function') sock.destroy()
      } catch {
        // ignore
      }
      this.socket = null
    }
  }

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      logger.info('[esl]', `Connecting to ${this.config.host}:${this.config.port}...`)

      Bun.connect({
        hostname: this.config.host,
        port: this.config.port,
        socket: {
          open: (socket) => {
            logger.info('[esl]', 'TCP connected')
            // A fresh connection starts a fresh handshake and a fresh frame buffer.
            this.resetConnectionState('Superseded by a new connection')
            this.socket = socket as unknown as ReturnType<typeof Bun.connect>
          },
          data: (socket, data) => {
            if (this.isStaleSocket(socket)) return
            this.buffer += new TextDecoder().decode(data)
            this.processBuffer(resolve, reject)
          },
          close: (socket) => {
            // A late close from a superseded socket must not tear down the live one.
            if (this.isStaleSocket(socket)) return
            logger.info('[esl]', 'TCP disconnected')
            const handshakeDone = this.hasConnected
            this.resetConnectionState('ESL connection closed')
            this.socket = null
            if (!handshakeDone) {
              // Dropped mid-handshake: fail the pending doConnect() instead of leaking it.
              reject(new Error('[esl] Connection closed before handshake completed'))
            }
            if (this.shouldReconnect) {
              this.scheduleReconnect()
            }
          },
          error: (socket, error) => {
            if (this.isStaleSocket(socket)) return
            logger.error('[esl]', 'TCP error', error)
            this.connected = false
            if (!this.hasConnected) reject(error)
          },
          connectError: (_socket, error) => {
            logger.error('[esl]', 'TCP connect error', error)
            reject(error)
            // No close event follows a failed connect — keep retrying (idempotent).
            if (this.shouldReconnect) this.scheduleReconnect()
          },
        },
      }).catch(reject)
    })
  }

  /** True when `socket` is not the socket this client currently owns. */
  private isStaleSocket(socket: unknown): boolean {
    return this.socket !== null && (this.socket as unknown) !== socket
  }

  /**
   * Discard ALL per-connection state: handshake progress, the partial-frame buffer
   * and every in-flight command. Called on close, disconnect and before a new
   * connection starts, so nothing from a dead connection can leak into the next one.
   */
  private resetConnectionState(reason: string): void {
    this.connected = false
    this.hasConnected = false
    this.authenticated = false
    this.buffer = ''
    const pending = this.commandQueue
    this.commandQueue = []
    for (const cmd of pending) {
      if (cmd.timer !== null) clearTimeout(cmd.timer)
      if (!cmd.settled) {
        cmd.settled = true
        cmd.reject(new Error(`[esl] ${reason}`))
      }
    }
  }

  private processBuffer(
    resolve?: (value: undefined) => void,
    reject?: (reason: Error) => void
  ): void {
    for (;;) {
      const separatorIdx = this.buffer.indexOf('\n\n')
      if (separatorIdx === -1) break
      const headerBlock = this.buffer.slice(0, separatorIdx)
      let rest = this.buffer.slice(separatorIdx + 2)

      const headers = this.parseHeaders(headerBlock)

      let body = ''
      const contentLength = headers['Content-Length']
      if (contentLength !== undefined) {
        const len = Number.parseInt(contentLength, 10)
        if (rest.length < len) break
        body = rest.slice(0, len)
        rest = rest.slice(len)
      }

      this.buffer = rest
      const message: EslMessage = { headers, body }
      this.handleMessage(message, resolve, reject)
    }
  }

  public parseHeaders(headerBlock: string): Record<string, string> {
    const result: Record<string, string> = {}
    for (const line of headerBlock.split('\n')) {
      const colonIdx = line.indexOf(': ')
      if (colonIdx === -1) continue
      const key = line.slice(0, colonIdx).trim()
      const rawValue = line.slice(colonIdx + 2).trim()
      try {
        result[key] = decodeURIComponent(rawValue)
      } catch {
        result[key] = rawValue
      }
    }
    return result
  }

  private handleMessage(
    message: EslMessage,
    resolve?: (value: undefined) => void,
    reject?: (reason: Error) => void
  ): void {
    const contentType = message.headers['Content-Type']

    switch (contentType) {
      case 'auth/request':
        this.sendRaw(`auth ${this.config.password}\n\n`)
        break

      case 'command/reply': {
        const reply = message.headers['Reply-Text'] ?? ''
        if (!this.authenticated) {
          // Reply to `auth` — authenticate, then (re-)subscribe on EVERY connection.
          if (reply.startsWith('+OK')) {
            this.authenticated = true
            this.sendRaw(`${EVENT_SUBSCRIPTION}\n\n`)
          } else if (reply.startsWith('-ERR')) {
            this.shouldReconnect = false
            reject?.(new Error(`[esl] Authentication failed: ${reply}`))
          }
        } else if (!this.hasConnected) {
          // Reply to the event subscription.
          if (reply.startsWith('+OK')) {
            this.hasConnected = true
            this.hasEverConnected = true
            this.connected = true
            this.reconnectDelay = 1000
            this.connectionDeadline = null
            logger.info('[esl]', 'Connected and subscribed to events')
            resolve?.(undefined)
            // Events may have been missed while the socket was down (or a previous bridge
            // process may have left calls behind) — have the handler reconcile with the PBX.
            this.emit({ type: 'connection_reset', timestamp: new Date().toISOString() })
          } else if (reply.startsWith('-ERR')) {
            reject?.(new Error(`[esl] Event subscription failed: ${reply}`))
            this.closeSocket()
          }
        }
        // Once ready every command goes through `api`, which replies with api/response;
        // a stray command/reply must never resolve an unrelated queued command.
        break
      }

      case 'api/response': {
        const cb = this.commandQueue.shift()
        if (cb && cb.timer !== null) clearTimeout(cb.timer)
        if (cb && !cb.settled) {
          cb.settled = true
          const result = message.body.trim()
          if (result.startsWith('-ERR')) {
            cb.reject(new Error(`ESL api error: ${result}`))
          } else {
            cb.resolve(result)
          }
        }
        break
      }

      case 'text/event-plain': {
        const eventHeaders = this.parseHeaders(message.body)
        const bridgeEvent = this.translateEslEvent(eventHeaders)
        if (bridgeEvent !== null) this.emit(bridgeEvent)
        break
      }

      default:
        break
    }
  }

  private emit(event: BridgeEvent): void {
    const snapshot = [...this.eventHandlers]
    for (const handler of snapshot) {
      try {
        handler(event)
      } catch (err) {
        logger.error('[esl]', 'Event handler error', err)
      }
    }
  }

  private sendRaw(text: string): void {
    if (!this.socket) {
      logger.warn('[esl]', 'sendRaw called with no socket')
      return
    }
    const sock = this.socket as unknown as { write: (data: string | Uint8Array) => void }
    sock.write(text)
  }

  private closeSocket(): void {
    const sock = this.socket as unknown as { end?: () => void } | null
    try {
      sock?.end?.()
    } catch {
      // ignore — the close handler drives cleanup
    }
  }

  private sendCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.socket) {
        reject(new Error('[esl] Not connected'))
        return
      }
      const pending: PendingCommand = { resolve, reject, settled: false, timer: null }
      // On timeout the entry stays queued (settled) so the late reply is still matched
      // to it rather than resolving the NEXT command with the wrong answer.
      pending.timer = setTimeout(() => {
        pending.timer = null
        if (pending.settled) return
        pending.settled = true
        reject(new Error(`[esl] Command timed out after ${COMMAND_TIMEOUT_MS}ms`))
      }, COMMAND_TIMEOUT_MS)
      this.commandQueue.push(pending)
      this.sendRaw(`api ${command}\n\n`)
    })
  }

  private scheduleReconnect(): void {
    if (this.connectionDeadline !== null && Date.now() >= this.connectionDeadline) {
      logger.error('[esl]', `FATAL: Could not connect to FreeSWITCH within ${Math.round(this.connectionTimeoutMs / 1000)}s — exiting.`)
      process.exit(1)
    }

    // close + a failed doConnect() can both ask for a reconnect — only one timer may exist.
    if (this.reconnectTimer !== null) return

    const remaining = this.connectionDeadline
      ? ` (${Math.round((this.connectionDeadline - Date.now()) / 1000)}s until timeout)`
      : ''
    const delay = Math.round(this.reconnectDelay * (1 + (Math.random() * 2 - 1) * RECONNECT_JITTER))
    logger.info('[esl]', `Reconnecting in ${delay}ms...${remaining}`)
    // Exponential backoff, capped; reset to 1s once a handshake completes.
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay)

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null

      if (this.connectionDeadline !== null && Date.now() >= this.connectionDeadline) {
        logger.error('[esl]', 'FATAL: Connection timeout — exiting.')
        process.exit(1)
      }

      try {
        await this.doConnect()
      } catch (err) {
        logger.error('[esl]', 'Reconnection failed', err)
        if (this.shouldReconnect) {
          this.scheduleReconnect()
        }
      }
    }, delay)
  }

  // ---- Event Translation ----

  public translateEslEvent(headers: Record<string, string>): BridgeEvent | null {
    const eventName = headers['Event-Name']
    const channelId = headers['Unique-ID'] ?? ''
    const timestamp = new Date().toISOString()

    switch (eventName) {
      case 'CHANNEL_CREATE':
        return {
          type: 'channel_create',
          channelId,
          callerNumber: headers['Caller-Caller-ID-Number'] ?? '',
          calledNumber: headers['Caller-Destination-Number'] ?? '',
          timestamp,
        }

      case 'CHANNEL_ANSWER':
        return {
          type: 'channel_answer',
          channelId,
          timestamp,
        }

      case 'CHANNEL_HANGUP_COMPLETE': {
        const causeCode = Number.parseInt(headers['Hangup-Cause-Code'] ?? '0', 10)
        return {
          type: 'channel_hangup',
          channelId,
          cause: Number.isNaN(causeCode) ? 0 : causeCode,
          causeText: headers['Hangup-Cause'] ?? 'UNKNOWN',
          timestamp,
        }
      }

      case 'RECORD_STOP': {
        const filePath = headers['Record-File-Path'] ?? ''
        const recordingName = filePath.split('/').pop() ?? filePath
        const duration = Number.parseFloat(headers.variable_record_seconds ?? '0')
        return {
          type: 'recording_complete',
          channelId,
          recordingName,
          duration: Number.isNaN(duration) ? undefined : duration,
          timestamp,
        }
      }

      case 'DTMF': {
        const durationMs = Number.parseInt(headers['DTMF-Duration'] ?? '0', 10)
        return {
          type: 'dtmf_received',
          channelId,
          digit: headers['DTMF-Digit'] ?? '',
          durationMs: Number.isNaN(durationMs) ? 0 : durationMs,
          timestamp,
        }
      }

      default:
        return null
    }
  }

  // ---- BridgeClient: Call Control ----

  async originate(params: OriginateParams): Promise<{ id: string }> {
    const vars: string[] = []
    if (params.callerId) vars.push(`origination_caller_id_number=${params.callerId}`)
    if (params.timeout) vars.push(`originate_timeout=${params.timeout}`)
    if (params.appArgs) vars.push(params.appArgs)

    const varsStr = vars.length > 0 ? `{${vars.join(',')}}` : ''
    const callerId = params.callerId ? ` XML default ${params.callerId}` : ''
    const command = `originate ${varsStr}${params.endpoint} &park()${callerId}`

    const result = await this.sendCommand(command)
    const uuid = result.replace(/^\+OK\s+/, '').trim()
    return { id: uuid }
  }

  async hangup(channelId: string): Promise<void> {
    try {
      await this.sendCommand(`uuid_kill ${channelId}`)
    } catch (err) {
      logger.warn('[esl]', 'Failed to hangup channel', err)
    }
  }

  async answer(channelId: string): Promise<void> {
    await this.sendCommand(`uuid_answer ${channelId}`)
  }

  async bridge(
    channelId1: string,
    channelId2: string,
    options?: BridgeOptions
  ): Promise<string> {
    if (options?.type === 'passthrough') {
      // Set bypass_media for SFrame E2EE passthrough
      await this.sendCommand(`uuid_setvar ${channelId1} bypass_media true`)
    }
    await this.sendCommand(`uuid_bridge ${channelId1} ${channelId2}`)
    return `${channelId1}:${channelId2}`
  }

  async destroyBridge(_bridgeId: string): Promise<void> {
    // ESL doesn't have explicit bridge objects
  }

  // ---- BridgeClient: Media ----

  async playMedia(channelId: string, media: string, _playbackId?: string): Promise<string> {
    await this.sendCommand(`uuid_broadcast ${channelId} ${media}`)
    return `${channelId}-${Date.now()}`
  }

  async stopPlayback(playbackId: string): Promise<void> {
    const channelId = playbackId.split('-')[0]
    try {
      await this.sendCommand(`uuid_break ${channelId}`)
    } catch {
      // Playback may already be done
    }
  }

  async startMoh(channelId: string, _mohClass?: string): Promise<void> {
    await this.sendCommand(`uuid_broadcast ${channelId} local_stream://moh`)
  }

  async stopMoh(channelId: string): Promise<void> {
    try {
      await this.sendCommand(`uuid_break ${channelId}`)
    } catch {
      // MOH may already be stopped
    }
  }

  // ---- BridgeClient: Recording ----

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
    const format = params.format ?? 'wav'
    const maxDuration = (params.maxDurationSeconds ?? 0) * 1000
    const filePath = `/tmp/recordings/${params.name}.${format}`
    await this.sendCommand(`uuid_record ${channelId} start ${filePath} ${maxDuration}`)
  }

  async recordBridge(
    bridgeId: string,
    params: {
      name: string
      format?: string
      maxDurationSeconds?: number
    }
  ): Promise<void> {
    const channelId = bridgeId.split(':')[0]
    await this.recordChannel(channelId, params)
  }

  async stopRecording(recordingName: string): Promise<void> {
    const filePath = recordingName.startsWith('/')
      ? recordingName
      : `/tmp/recordings/${recordingName}`
    try {
      await this.sendCommand(`uuid_record ${filePath} stop`)
    } catch {
      // May already be stopped
    }
  }

  async getRecordingFile(recordingName: string): Promise<ArrayBuffer | null> {
    const filePath = recordingName.startsWith('/')
      ? recordingName
      : `/tmp/recordings/${recordingName}`
    try {
      const file = Bun.file(filePath)
      if (!(await file.exists())) return null
      return file.arrayBuffer()
    } catch {
      return null
    }
  }

  async deleteRecording(recordingName: string): Promise<void> {
    const filePath = recordingName.startsWith('/')
      ? recordingName
      : `/tmp/recordings/${recordingName}`
    try {
      const { unlink } = await import('node:fs/promises')
      await unlink(filePath)
    } catch {
      // Already deleted or doesn't exist
    }
  }

  // ---- BridgeClient: Channel Variables ----

  async setChannelVar(channelId: string, variable: string, value: string): Promise<void> {
    await this.sendCommand(`uuid_setvar ${channelId} ${variable} ${value}`)
  }

  async getChannelVar(channelId: string, variable: string): Promise<string> {
    const result = await this.sendCommand(`uuid_getvar ${channelId} ${variable}`)
    return result.trim()
  }

  // ---- BridgeClient: System ----

  async healthCheck(): Promise<BridgeHealthStatus> {
    const start = Date.now()
    try {
      const result = await this.sendCommand('status')
      const uptimeMatch = result.match(/UP\s+(.+)/)
      return {
        ok: true,
        latencyMs: Date.now() - start,
        details: {
          status: result.split('\n')[0]?.trim(),
          uptime: uptimeMatch?.[1] ?? 'unknown',
        },
      }
    } catch {
      return { ok: false, latencyMs: Date.now() - start }
    }
  }

  async listChannels(): Promise<Array<{ id: string; state: string; caller: string }>> {
    const result = await this.sendCommand('show channels as json')
    // FreeSWITCH replies `{"row_count":0}` (no `rows`) when there are no channels.
    const parsed = JSON.parse(result || '{}') as {
      rows?: Array<{ uuid: string; state?: string; cid_num?: string }>
    }
    return (parsed.rows ?? []).map((row) => ({
      id: row.uuid,
      state: row.state ?? '',
      caller: row.cid_num ?? '',
    }))
  }

  async listBridges(): Promise<Array<{ id: string; channels: string[] }>> {
    return []
  }
}
