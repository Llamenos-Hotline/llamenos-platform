import { request, hp } from './client'
import type {
  FirehoseConnection,
  FirehoseConnectionHealth,
} from '@protocol/schemas/firehose'
import type { CreateFirehoseConnectionInput, UpdateFirehoseConnectionInput } from '@protocol/schemas'

export type { FirehoseConnection, FirehoseConnectionHealth }

// --- Firehose ---

export async function listFirehoseConnections() {
  return request<{ connections: FirehoseConnection[] }>(hp('/firehose'))
}

export async function getFirehoseConnection(id: string) {
  return request<{ connection: FirehoseConnection }>(hp(`/firehose/${id}`))
}

export async function createFirehoseConnection(data: CreateFirehoseConnectionInput) {
  return request<{ connection: FirehoseConnection }>(hp('/firehose'), {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateFirehoseConnection(id: string, data: UpdateFirehoseConnectionInput) {
  return request<{ connection: FirehoseConnection }>(hp(`/firehose/${id}`), {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function deleteFirehoseConnection(id: string) {
  return request<{ ok: boolean }>(hp(`/firehose/${id}`), { method: 'DELETE' })
}

export async function activateFirehoseConnection(id: string) {
  return request<{ connection: FirehoseConnection }>(hp(`/firehose/${id}/activate`), { method: 'POST' })
}

export async function pauseFirehoseConnection(id: string) {
  return request<{ connection: FirehoseConnection }>(hp(`/firehose/${id}/pause`), { method: 'POST' })
}

export async function getFirehoseStatus() {
  return request<{ statuses: FirehoseConnectionHealth[] }>(hp('/firehose/status'))
}

export async function getFirehoseBuffer(id: string) {
  return request<{
    connectionId: string
    bufferSize: number
    agentRunning: boolean
    extractionIntervalSec: number
    bufferTtlDays: number
  }>(hp(`/firehose/${id}/buffer`))
}

export async function purgeFirehoseBuffer(id: string) {
  return request<{ purged: number }>(hp(`/firehose/${id}/buffer`), { method: 'DELETE' })
}

export async function optoutFirehoseNotifications(id: string) {
  return request<{ id: string; connectionId: string; userId: string; optedOutAt: string }>(
    hp(`/firehose/${id}/optout`),
    { method: 'POST' },
  )
}

export async function optinFirehoseNotifications(id: string) {
  return request<{ ok: boolean }>(hp(`/firehose/${id}/optout`), { method: 'DELETE' })
}
