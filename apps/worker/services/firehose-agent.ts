/**
 * FirehoseAgentService — manages extraction agent lifecycle and periodic
 * report extraction from encrypted message buffers.
 *
 * Each active firehose connection gets an in-memory agent instance that:
 * 1. Periodically fetches unextracted buffer messages
 * 2. Decrypts them using the agent's sealed Ed25519 key
 * 3. Clusters by time proximity (heuristic) and optionally refines via LLM
 * 4. Extracts structured reports via LLM inference
 * 5. Submits reports as E2EE conversations
 *
 * Circuit breaker: 3 consecutive extraction failures auto-pause the connection.
 */
import { hexToBytes, utf8ToBytes } from '@shared/encoding'
import { hpkeOpen, symmetricDecrypt } from '@llamenos/crypto/ffi'
import {
  LABEL_FIREHOSE_AGENT_SEAL,
  LABEL_FIREHOSE_BUFFER_ENCRYPT,
  LABEL_MESSAGE,
} from '@shared/crypto-labels'
import { KIND_FIREHOSE_REPORT } from '@shared/event-kinds'
import { bufferEnvelopeJsonSchema } from '@protocol/schemas/firehose'
import type { RecipientEnvelope } from '@shared/types'
import type { Database } from '../db'
import { unsealAgentKey } from '../lib/agent-identity'
import { encryptMessageForStorage } from '../lib/crypto'
import { CircuitBreaker } from '../lib/circuit-breaker'
import { createLogger } from '../lib/logger'
import { clearWindowKeyCache } from '../messaging/firehose-observer'
import { publishEvent } from '../lib/ws-events'
import type { ConversationsService } from './conversations'
import type { FirehoseService } from './firehose'
import {
  FirehoseInferenceClient,
  type CustomFieldDef,
  type DecryptedFirehoseMessage,
  type ExtractionResult,
  type MessageCluster,
} from './firehose-inference'
import { AuditService, audit } from './audit'
import type { SettingsService } from './settings'

const log = createLogger('services.firehose-agent')

/** In-memory state for a running extraction agent */
interface AgentInstance {
  connectionId: string
  hubId: string
  agentPubkey: string
  agentSecretKey: Uint8Array
  intervalHandle: ReturnType<typeof setInterval>
  inferenceClient: FirehoseInferenceClient
  circuitBreaker: CircuitBreaker
}

/** Minimum messages before attempting extraction */
const MIN_CLUSTER_SIZE = 2
/** Time window (ms) for heuristic clustering — 5 minutes */
const CLUSTER_WINDOW_MS = 5 * 60 * 1000
/** Default inference endpoint if none configured per-connection */
const DEFAULT_INFERENCE_ENDPOINT = 'http://localhost:8000/v1'
/** Default inference model */
const DEFAULT_INFERENCE_MODEL = 'Qwen/Qwen3.5-9B'
/** Minimum confidence score to accept an extraction */
const CONFIDENCE_THRESHOLD = 0.3

export class FirehoseAgentService {
  private agents = new Map<string, AgentInstance>()
  private inferenceClients = new Map<string, FirehoseInferenceClient>()

  constructor(
    readonly _db: Database,
    private readonly firehose: FirehoseService,
    private readonly conversations: ConversationsService,
    private readonly auditService: AuditService,
    private readonly settings: SettingsService,
    private readonly sealKey: string,
    private readonly env: {
      SERVER_SECRET?: string
      ADMIN_PUBKEY?: string
      ADMIN_DECRYPTION_PUBKEY?: string
    },
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async init(): Promise<void> {
    const connections = await this.firehose.listActiveConnections()
    log.info('Initializing active agents', { count: connections.length })

    for (const conn of connections) {
      try {
        await this.startAgent(conn.id)
      } catch (err) {
        log.error('Failed to start agent', { connectionId: conn.id, error: err instanceof Error ? err.message : String(err) })
      }
    }

    const started = this.agents.size
    const failed = connections.length - started
    if (failed > 0) {
      log.warn('Partial agent startup', { started, total: connections.length, failed })
    } else if (started > 0) {
      log.info('All agents started successfully', { started })
    }
  }

  async startAgent(connectionId: string): Promise<void> {
    if (this.agents.has(connectionId)) {
      log.warn('Agent already running', { connectionId })
      return
    }

    const conn = await this.firehose.getConnection(connectionId)
    if (!conn) {
      throw new Error(`Connection ${connectionId} not found`)
    }
    if (conn.status !== 'active') {
      throw new Error(`Connection ${connectionId} is not active (status: ${conn.status})`)
    }

    // Unseal the agent's Ed25519 secret key
    const agentSecretKeyHex = unsealAgentKey(
      connectionId,
      conn.sealedAgentKey,
      this.sealKey,
      LABEL_FIREHOSE_AGENT_SEAL,
    )
    const agentSecretKey = hexToBytes(agentSecretKeyHex)

    // Get or create inference client for this endpoint
    const endpoint = conn.inferenceEndpoint || DEFAULT_INFERENCE_ENDPOINT
    const inferenceClient = this.getOrCreateInferenceClient(endpoint)

    // Create circuit breaker for this connection
    const circuitBreaker = new CircuitBreaker({
      name: `firehose:${connectionId.slice(0, 8)}`,
      failureThreshold: 3,
      resetTimeoutMs: 60_000,
      failureWindowMs: 300_000,
      onStateChange: (name, from, to) => {
        log.warn('Circuit breaker state change', { name, from, to, connectionId })
        if (to === 'open') {
          // Auto-pause connection on circuit break
          this.handleCircuitBreak(connectionId).catch((err) => {
            log.error('Failed to handle circuit break', { connectionId, error: err instanceof Error ? err.message : String(err) })
          })
        }
      },
    })

    // Start extraction loop
    const intervalMs = (conn.extractionIntervalSec ?? 60) * 1000
    const intervalHandle = setInterval(() => {
      this.runExtractionLoop(connectionId).catch((err) => {
        log.error('Extraction loop error', { connectionId, error: err instanceof Error ? err.message : String(err) })
      })
    }, intervalMs)

    this.agents.set(connectionId, {
      connectionId,
      hubId: conn.hubId,
      agentPubkey: conn.agentPubkey,
      agentSecretKey,
      intervalHandle,
      inferenceClient,
      circuitBreaker,
    })

    log.info('Started agent', { connectionId, intervalSec: conn.extractionIntervalSec })
  }

  stopAgent(connectionId: string): void {
    const agent = this.agents.get(connectionId)
    if (!agent) return

    clearInterval(agent.intervalHandle)
    // Zero the agent secret key from memory
    agent.agentSecretKey.fill(0)
    this.agents.delete(connectionId)

    log.info('Stopped agent', { connectionId })
  }

  shutdown(): void {
    log.info('Shutting down agents', { count: this.agents.size })
    for (const connectionId of this.agents.keys()) {
      this.stopAgent(connectionId)
    }
    this.inferenceClients.clear()
    clearWindowKeyCache()
  }

  isRunning(connectionId: string): boolean {
    return this.agents.has(connectionId)
  }

  // ---------------------------------------------------------------------------
  // Extraction Loop
  // ---------------------------------------------------------------------------

  async runExtractionLoop(connectionId: string): Promise<void> {
    const agent = this.agents.get(connectionId)
    if (!agent) return

    // 1. Get unextracted messages
    const bufferMessages = await this.firehose.getUnextractedMessages(connectionId)
    if (bufferMessages.length < MIN_CLUSTER_SIZE) return

    // 2. Decrypt messages — group by windowKeyId to unseal each key once
    const decrypted: DecryptedFirehoseMessage[] = []
    const unsealedWindowKeys = new Map<string, Uint8Array>()

    for (const msg of bufferMessages) {
      try {
        if (msg.windowKeyId) {
          // Window-key path: decrypt with the unsealed window key
          let windowKey = unsealedWindowKeys.get(msg.windowKeyId)
          if (!windowKey) {
            windowKey = await this.unsealWindowKey(msg.windowKeyId, agent.agentSecretKey)
            unsealedWindowKeys.set(msg.windowKeyId, windowKey)
          }

          const content = this.decryptWithWindowKey(msg.encryptedContent, windowKey)
          const senderJson = this.decryptWithWindowKey(msg.encryptedSenderInfo, windowKey)

          const sender = JSON.parse(senderJson) as {
            identifier: string
            identifierHash: string
            username: string
            timestamp: number
          }

          decrypted.push({
            id: msg.id,
            senderUsername: sender.username,
            content,
            timestamp: msg.signalTimestamp.toISOString(),
          })
        } else {
          // Legacy envelope path (pre-window-key messages)
          const parsed = bufferEnvelopeJsonSchema.parse(JSON.parse(msg.encryptedContent))
          const senderParsed = bufferEnvelopeJsonSchema.parse(JSON.parse(msg.encryptedSenderInfo))

          const contentEnvelope = parsed.envelopes.find((e) => e.pubkey === agent.agentPubkey)
          const senderEnvelope = senderParsed.envelopes.find((e) => e.pubkey === agent.agentPubkey)

          if (!contentEnvelope || !senderEnvelope) {
            log.warn('No agent envelope found for message', { messageId: msg.id })
            continue
          }

          const content = this.decryptEnvelope(
            parsed.encrypted,
            contentEnvelope as RecipientEnvelope,
            agent.agentSecretKey,
          )

          const senderJson = this.decryptEnvelope(
            senderParsed.encrypted,
            senderEnvelope as RecipientEnvelope,
            agent.agentSecretKey,
          )

          const sender = JSON.parse(senderJson) as {
            identifier: string
            identifierHash: string
            username: string
            timestamp: number
          }

          decrypted.push({
            id: msg.id,
            senderUsername: sender.username,
            content,
            timestamp: msg.signalTimestamp.toISOString(),
          })
        }
      } catch (err) {
        log.error('Failed to decrypt message', { messageId: msg.id, error: err instanceof Error ? err.message : String(err) })
      }
    }

    // Zero unsealed window keys from memory
    for (const key of unsealedWindowKeys.values()) {
      key.fill(0)
    }

    if (decrypted.length < MIN_CLUSTER_SIZE) return

    // 3. Heuristic clustering
    const clusters = this.heuristicCluster(decrypted)

    // 4. Load connection for metadata
    const conn = await this.firehose.getConnection(connectionId)
    if (!conn) return

    // 5. For each cluster, attempt LLM extraction via circuit breaker
    for (const cluster of clusters) {
      if (cluster.messages.length < MIN_CLUSTER_SIZE) continue

      try {
        await agent.circuitBreaker.execute(async () => {
          const fieldDefs = await this.getFieldDefsForReportType(conn.hubId, conn.reportTypeId)
          const schema = agent.inferenceClient.buildJsonSchemaFromFields(fieldDefs)

          const extraction = await agent.inferenceClient.extractReport(
            cluster.messages,
            schema,
            conn.geoContext ?? undefined,
            conn.systemPromptSuffix ?? undefined,
          )

          if (extraction.confidence < CONFIDENCE_THRESHOLD) {
            log.info('Skipping low-confidence extraction', {
              confidence: extraction.confidence,
              clusterId: cluster.id,
            })
            return
          }

          const reportId = await this.submitExtractedReport(conn, cluster, extraction)
          const messageIds = cluster.messages.map((m) => m.id)
          await this.firehose.markMessagesExtracted(messageIds, reportId, cluster.id)

          log.info('Extracted report', {
            reportId,
            sourceMessageCount: messageIds.length,
            confidence: extraction.confidence,
          })
        })
      } catch (err) {
        // CircuitOpenError means circuit is open — stop processing this connection
        if ((err as { name?: string }).name === 'CircuitOpenError') {
          log.warn('Circuit open, skipping remaining clusters', { connectionId })
          return
        }
        log.error('Extraction failed for cluster', { clusterId: cluster.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Heuristic Clustering
  // ---------------------------------------------------------------------------

  heuristicCluster(messages: DecryptedFirehoseMessage[]): MessageCluster[] {
    if (messages.length === 0) return []

    const sorted = [...messages].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    )

    const clusters: MessageCluster[] = []
    let currentCluster: DecryptedFirehoseMessage[] = [sorted[0]]

    for (let i = 1; i < sorted.length; i++) {
      const prevTime = new Date(sorted[i - 1].timestamp).getTime()
      const currTime = new Date(sorted[i].timestamp).getTime()

      if (currTime - prevTime <= CLUSTER_WINDOW_MS) {
        currentCluster.push(sorted[i])
      } else {
        clusters.push({
          id: crypto.randomUUID(),
          messages: currentCluster,
          confidence: 0.7,
        })
        currentCluster = [sorted[i]]
      }
    }

    if (currentCluster.length > 0) {
      clusters.push({
        id: crypto.randomUUID(),
        messages: currentCluster,
        confidence: 0.7,
      })
    }

    return clusters
  }

  // ---------------------------------------------------------------------------
  // Report Submission
  // ---------------------------------------------------------------------------

  private async submitExtractedReport(
    conn: { id: string; hubId: string; reportTypeId: string; agentPubkey: string },
    cluster: MessageCluster,
    extraction: ExtractionResult,
  ): Promise<string> {
    const reportContent = JSON.stringify({
      extractedFields: extraction.fields,
      confidence: extraction.confidence,
      sourceMessageCount: cluster.messages.length,
      sourceMessageIds: cluster.messages.map((m) => m.id),
      agentPubkey: conn.agentPubkey,
      clusterId: cluster.id,
      incidentTimestamp: cluster.messages[0]?.timestamp,
      extractedAt: new Date().toISOString(),
    })

    // Get admin pubkeys for envelope encryption
    const adminPubkeys: string[] = []
    if (this.env.ADMIN_PUBKEY && /^[0-9a-f]{64}$/i.test(this.env.ADMIN_PUBKEY)) {
      adminPubkeys.push(this.env.ADMIN_PUBKEY)
    }
    if (this.env.ADMIN_DECRYPTION_PUBKEY && /^[0-9a-f]{64}$/i.test(this.env.ADMIN_DECRYPTION_PUBKEY)) {
      adminPubkeys.push(this.env.ADMIN_DECRYPTION_PUBKEY)
    }
    const recipientPubkeys = [
      ...new Set([conn.agentPubkey, ...adminPubkeys]),
    ]

    if (recipientPubkeys.length === 0) {
      throw new Error('No valid recipient pubkeys for report envelope')
    }

    // Envelope-encrypt the report content
    const { encryptedContent, readerEnvelopes } = encryptMessageForStorage(
      reportContent,
      recipientPubkeys,
    )

    // Create conversation with report metadata
    const conversation = await this.conversations.create({
      hubId: conn.hubId,
      channelType: 'web',
      contactIdentifierHash: conn.agentPubkey,
      status: 'waiting',
      metadata: {
        type: 'report',
        reportTitle: `Firehose extraction — ${new Date().toISOString()}`,
        reportCategory: 'firehose-extraction',
        firehoseConnectionId: conn.id,
        firehoseClusterId: cluster.id,
        firehoseConfidence: extraction.confidence,
        extractedAt: new Date().toISOString(),
      },
    })

    // Add the encrypted report as the first message
    await this.conversations.addMessage({
      conversationId: conversation.id,
      direction: 'inbound',
      authorPubkey: conn.agentPubkey,
      encryptedContent,
      readerEnvelopes,
      hasAttachments: false,
      status: 'delivered',
    })

    // Publish Nostr event
    this.publishFirehoseEvent(conn, conversation.id, extraction.confidence)

    // Audit log
    await audit(this.auditService, 'firehoseReportExtracted', conn.agentPubkey, {
      conversationId: conversation.id,
      connectionId: conn.id,
      clusterId: cluster.id,
      confidence: extraction.confidence,
      sourceMessageCount: cluster.messages.length,
    }, undefined, conn.hubId)

    return conversation.id
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async handleCircuitBreak(connectionId: string): Promise<void> {
    this.stopAgent(connectionId)
    await this.firehose.updateConnection(connectionId, { status: 'paused' })
    log.warn('Connection auto-paused due to circuit breaker', { connectionId })
  }

  /**
   * Unseal a window key by HPKE-opening it with the agent's secret key.
   * The sealedKey is JSON: { enc, ct }.
   */
  private async unsealWindowKey(
    windowKeyId: string,
    secretKey: Uint8Array,
  ): Promise<Uint8Array> {
    const windowKeyRow = await this.firehose.getWindowKey(windowKeyId)
    if (!windowKeyRow) throw new Error(`Window key ${windowKeyId} not found`)

    const sealed = JSON.parse(windowKeyRow.sealedKey) as {
      enc: string
      ct: string
    }

    const envelope = new Uint8Array(hexToBytes(sealed.enc).length + hexToBytes(sealed.ct).length)
    envelope.set(hexToBytes(sealed.enc))
    envelope.set(hexToBytes(sealed.ct), 32)

    return hpkeOpen(
      secretKey,
      envelope,
      utf8ToBytes(LABEL_FIREHOSE_BUFFER_ENCRYPT),
      utf8ToBytes(`${LABEL_FIREHOSE_BUFFER_ENCRYPT}:key-wrap`),
    )
  }

  /**
   * Decrypt a value that was encrypted directly with a window key.
   * Format: hex-encoded nonce(12) + ciphertext + tag(16) (AES-256-GCM).
   */
  private decryptWithWindowKey(encryptedHex: string, windowKey: Uint8Array): string {
    const bytes = hexToBytes(encryptedHex)
    const plaintext = symmetricDecrypt(windowKey, bytes, utf8ToBytes(LABEL_FIREHOSE_BUFFER_ENCRYPT))
    return new TextDecoder().decode(plaintext)
  }

  /**
   * Decrypt an HPKE envelope-encrypted value using the agent's secret key.
   * Inverse of encryptMessageForStorage: LABEL_MESSAGE as HPKE info, no AAD.
   */
  private decryptEnvelope(
    encryptedHex: string,
    envelope: RecipientEnvelope,
    secretKey: Uint8Array,
  ): string {
    const labelBytes = utf8ToBytes(LABEL_MESSAGE)
    const noAad = new Uint8Array(0)

    // Reconstruct the HPKE envelope: enc(32) || ct
    const encBytes = hexToBytes(envelope.enc)
    const ctBytes = hexToBytes(envelope.ct)
    const hpkeEnvelope = new Uint8Array(encBytes.length + ctBytes.length)
    hpkeEnvelope.set(encBytes)
    hpkeEnvelope.set(ctBytes, encBytes.length)

    // Unwrap the per-message key via HPKE
    const messageKey = hpkeOpen(secretKey, hpkeEnvelope, labelBytes, noAad)

    // Decrypt the content with AES-256-GCM
    const contentBytes = hexToBytes(encryptedHex)
    const plaintext = symmetricDecrypt(messageKey, contentBytes, noAad)

    return new TextDecoder().decode(plaintext)
  }

  private publishFirehoseEvent(
    conn: { id: string; hubId: string },
    conversationId: string,
    confidence: number,
  ): void {
    publishEvent(
      this.env as import('../types/infra').Env,
      KIND_FIREHOSE_REPORT,
      {
        type: 'firehose:report',
        connectionId: conn.id,
        conversationId,
        confidence,
      },
      conn.hubId,
    )
  }

  private getOrCreateInferenceClient(endpoint: string): FirehoseInferenceClient {
    const existing = this.inferenceClients.get(endpoint)
    if (existing) return existing
    const client = new FirehoseInferenceClient(endpoint, DEFAULT_INFERENCE_MODEL)
    this.inferenceClients.set(endpoint, client)
    return client
  }

  private async getFieldDefsForReportType(
    _hubId: string,
    _reportTypeId: string,
  ): Promise<CustomFieldDef[]> {
    const { fields: allFields } = await this.settings.getCustomFields('admin')

    // Filter to report-context fields
    const relevant = allFields.filter((f) => f.context === 'reports')

    return relevant.map((f) => ({
      name: f.name || f.id,
      label: f.label || f.name || f.id,
      type: this.mapFieldType(f.type),
      required: f.required,
      options: f.options ?? [],
    }))
  }

  private mapFieldType(
    type: string,
  ): 'text' | 'select' | 'multiselect' | 'checkbox' | 'date' | 'number' | 'location' {
    switch (type) {
      case 'select': return 'select'
      case 'multiselect': return 'multiselect'
      case 'checkbox': return 'checkbox'
      case 'number': return 'number'
      case 'location': return 'location'
      case 'date': return 'date'
      default: return 'text'
    }
  }
}
