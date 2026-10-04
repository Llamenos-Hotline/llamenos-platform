import type { BridgeConfig } from './types'
import { createBridgeClient, parsePbxType } from './client-factory'
import { WebhookSender } from './webhook-sender'
import { CommandHandler, callRecordingName, voicemailRecordingName, type RingRequest } from './command-handler'
import { logger } from './logger'

/** Load configuration from environment variables */
function loadConfig(): BridgeConfig {
  const pbxType = parsePbxType(process.env.PBX_TYPE ?? 'asterisk')

  // Shared config
  const workerWebhookUrl = process.env.WORKER_WEBHOOK_URL
  const bridgeSecret = process.env.BRIDGE_SECRET
  const bridgePort = parseInt(process.env.BRIDGE_PORT ?? '3000', 10)
  const bridgeHost = process.env.BRIDGE_HOST ?? '0.0.0.0' // Docker-compatible default
  const connectionTimeoutMs = parseInt(process.env.CONNECTION_TIMEOUT_MS ?? '300000', 10) // 5 min

  if (!workerWebhookUrl) throw new Error('WORKER_WEBHOOK_URL is required')
  if (!bridgeSecret) throw new Error('BRIDGE_SECRET is required')

  // ARI config (asterisk only — safe to read defaults even for other types)
  const ariUrl = process.env.ARI_URL ?? 'ws://localhost:8088/ari/events'
  const ariRestUrl = process.env.ARI_REST_URL ?? 'http://localhost:8088/ari'
  const ariUsername = process.env.ARI_USERNAME ?? ''
  const ariPassword = process.env.ARI_PASSWORD ?? ''
  const stasisApp = process.env.STASIS_APP ?? 'llamenos'

  // ESL config (freeswitch only)
  const eslHost = process.env.ESL_HOST ?? 'localhost'
  const eslPort = parseInt(process.env.ESL_PORT ?? '8021', 10)
  const eslPassword = process.env.ESL_PASSWORD ?? ''

  // Kamailio config
  const kamailioJsonrpcUrl = process.env.KAMAILIO_JSONRPC_URL ?? 'http://localhost:5060/jsonrpc'

  // Validate PBX-specific required vars
  if (pbxType === 'asterisk') {
    if (!ariUsername) throw new Error('ARI_USERNAME is required for asterisk PBX type')
    if (!ariPassword) throw new Error('ARI_PASSWORD is required for asterisk PBX type')
  }
  if (pbxType === 'freeswitch') {
    if (!eslPassword) throw new Error('ESL_PASSWORD is required for freeswitch PBX type')
  }

  return {
    pbxType,
    ariUrl,
    ariRestUrl,
    ariUsername,
    ariPassword,
    eslHost,
    eslPort,
    eslPassword,
    kamailioJsonrpcUrl,
    workerWebhookUrl,
    bridgeSecret,
    bridgePort,
    bridgeHost,
    stasisApp,
    connectionTimeoutMs,
  }
}

/**
 * Verify an incoming signed request from the Worker.
 * Extracts signature + timestamp from headers, delegates to WebhookSender.
 */
function verifyRequest(
  webhook: WebhookSender,
  request: Request,
  url: URL,
  body: string
): boolean {
  const signature = request.headers.get('X-Bridge-Signature') ?? ''
  const timestamp = request.headers.get('X-Bridge-Timestamp') ?? ''
  if (!signature || !timestamp) return false

  // Reject requests with timestamps older than 5 minutes (replay protection)
  const tsMs = parseInt(timestamp, 10)
  if (isNaN(tsMs) || Math.abs(Date.now() - tsMs) > 300_000) {
    logger.warn('[bridge]', 'Rejected request with stale timestamp')
    return false
  }

  return webhook.verifySignature(url.toString(), body, timestamp, signature)
}

async function main(): Promise<void> {
  const config = loadConfig()
  logger.info('[bridge]', `Starting sip-bridge (PBX_TYPE=${config.pbxType})...`)

  // Initialize components
  const client = createBridgeClient(config)
  const webhook = new WebhookSender(config)
  const handler = new CommandHandler(client, webhook, config)

  // Set hotline number from env
  if (process.env.HOTLINE_NUMBER) {
    handler.setHotlineNumber(process.env.HOTLINE_NUMBER)
  }

  // Register bridge event handler
  client.onEvent((event) => {
    handler.handleEvent(event).catch((err) => {
      logger.error('[bridge]', 'Event handler error', err)
    })
  })

  // Start HTTP server for Worker commands
  const server = Bun.serve({
    port: config.bridgePort,
    hostname: config.bridgeHost,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      const path = url.pathname
      const method = request.method

      // ---- Health check (unauthenticated) ----
      if (path === '/health' && method === 'GET') {
        try {
          const health = await client.healthCheck()
          return Response.json({
            status: health.ok ? 'ok' : 'degraded',
            pbxType: config.pbxType,
            connected: client.isConnected(),
            uptime: process.uptime(),
            ...handler.getStatus(),
            pbx: health.details,
            latencyMs: health.latencyMs,
          })
        } catch (err) {
          logger.error('[bridge]', 'Health check error', err)
          return Response.json(
            { status: 'error', error: 'Command failed' },
            { status: 500 }
          )
        }
      }

      // ---- Status endpoint (detailed, authenticated) ----
      if (path === '/status' && method === 'GET') {
        const statusBody = ''
        if (!verifyRequest(webhook, request, url, statusBody)) {
          return new Response('Forbidden', { status: 403 })
        }

        try {
          const health = await client.healthCheck()
          const channels = await client.listChannels()
          const bridges = await client.listBridges()
          return Response.json({
            status: 'ok',
            pbxType: config.pbxType,
            bridge: handler.getStatus(),
            pbx: health.details,
            channels: channels.length,
            bridges: bridges.length,
          })
        } catch (err) {
          logger.error('[bridge]', 'Status check error', err)
          return Response.json(
            { status: 'error', error: 'Command failed' },
            { status: 500 }
          )
        }
      }

      // ---- All POST endpoints require signature verification ----

      // Ring volunteers endpoint
      if (path === '/ring' && method === 'POST') {
        const body = await request.text()
        if (!verifyRequest(webhook, request, url, body)) {
          return new Response('Forbidden', { status: 403 })
        }

        let data: RingRequest
        try {
          data = JSON.parse(body) as RingRequest
        } catch {
          return Response.json({ ok: false, error: 'Invalid request' }, { status: 400 })
        }
        try {
          const channelIds = await handler.ringVolunteers(data)
          return Response.json({ ok: true, channelIds })
        } catch (err) {
          logger.error('[bridge]', 'Ring error', err)
          return Response.json({ ok: false, error: 'Command failed' }, { status: 500 })
        }
      }

      // Cancel ringing endpoint
      if (path === '/cancel-ringing' && method === 'POST') {
        const body = await request.text()
        if (!verifyRequest(webhook, request, url, body)) {
          return new Response('Forbidden', { status: 403 })
        }

        let data: { channelIds: string[]; exceptId?: string }
        try {
          data = JSON.parse(body) as typeof data
        } catch {
          return Response.json({ ok: false, error: 'Invalid request' }, { status: 400 })
        }
        handler.cancelRinging(data.channelIds, data.exceptId)
        return Response.json({ ok: true })
      }

      // Hangup endpoint
      if (path === '/hangup' && method === 'POST') {
        const body = await request.text()
        if (!verifyRequest(webhook, request, url, body)) {
          return new Response('Forbidden', { status: 403 })
        }

        let data: { channelId: string }
        try {
          data = JSON.parse(body) as typeof data
        } catch {
          return Response.json({ ok: false, error: 'Invalid request' }, { status: 400 })
        }
        try {
          await client.hangup(data.channelId)
          return Response.json({ ok: true })
        } catch (err) {
          logger.error('[bridge]', 'Hangup error', err)
          return Response.json({ ok: false, error: 'Command failed' }, { status: 500 })
        }
      }

      // Get recording audio
      if (path.startsWith('/recordings/') && method === 'GET') {
        // Accept signature from header or query param (for browser/curl convenience)
        const signature =
          request.headers.get('X-Bridge-Signature') ?? url.searchParams.get('sig') ?? ''
        const timestamp =
          request.headers.get('X-Bridge-Timestamp') ?? url.searchParams.get('ts') ?? ''

        // Strip sig/ts query params before verification
        const urlForSigning = new URL(url.toString())
        urlForSigning.searchParams.delete('sig')
        urlForSigning.searchParams.delete('ts')

        if (!signature || !timestamp) {
          return new Response('Forbidden', { status: 403 })
        }

        // Replay protection for recording requests
        const tsMs = parseInt(timestamp, 10)
        if (isNaN(tsMs) || Math.abs(Date.now() - tsMs) > 300_000) {
          return new Response('Forbidden', { status: 403 })
        }

        if (!webhook.verifySignature(urlForSigning.toString(), '', timestamp, signature)) {
          return new Response('Forbidden', { status: 403 })
        }

        // /recordings/call/:callSid — the recording of a call, by the call SID the
        // worker knows (a voicemail if the caller left one, else the bridged call).
        // /recordings/:name — a recording by name.
        const rest = path.slice('/recordings/'.length)
        const callSid = rest.startsWith('call/') ? rest.slice('call/'.length) : null
        const names = callSid !== null
          ? [voicemailRecordingName(callSid), callRecordingName(callSid)]
          : [rest]

        // Path traversal protection: reject names containing / or ..
        if (names.some((name) => name === '' || name.includes('/') || name.includes('..'))) {
          return new Response('Bad Request: invalid recording name', { status: 400 })
        }
        try {
          for (const name of names) {
            const audio = await client.getRecordingFile(name)
            // The worker's SipBridgeAdapter reads { audio: <base64> }.
            if (audio) return Response.json({ audio: Buffer.from(audio).toString('base64') })
          }
          return new Response('Not Found', { status: 404 })
        } catch (err) {
          logger.error('[bridge]', 'Recording fetch error', err)
          return Response.json({ error: 'Command failed' }, { status: 500 })
        }
      }

      return new Response('Not Found', { status: 404 })
    },
  })

  logger.info('[bridge]', `HTTP server listening on ${config.bridgeHost}:${config.bridgePort}`)

  // Connect to PBX
  try {
    await client.connect()
    logger.info('[bridge]', `Connected to ${config.pbxType}`)
  } catch (err) {
    logger.error('[bridge]', `Failed to connect to ${config.pbxType}`, err)
    logger.info('[bridge]', 'Will retry connection...')
  }

  // Log startup info
  logger.info('[bridge]', `sip-bridge is running (PBX_TYPE=${config.pbxType})`)
  logger.info('[bridge]', `Webhook target: ${config.workerWebhookUrl}`)

  // Handle graceful shutdown
  const shutdown = () => {
    logger.info('[bridge]', 'Shutting down...')
    handler.dispose()
    client.disconnect()
    server.stop()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  logger.error('[bridge]', 'Fatal error', err)
  process.exit(1)
})
