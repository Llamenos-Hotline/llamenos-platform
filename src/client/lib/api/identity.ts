import { request } from './client'
import type {
  AppendSigchainLinkBody,
  DistributePukEnvelopesBody,
  DistributePukEnvelopesResponse,
  PukEnvelopeResponse,
  SigchainLinkRecord,
  SigchainResponse,
} from '@protocol/schemas'

// --- User sigchain (docs/protocol/PROTOCOL.md §4.37) ---

export async function getSigchain(userPubkey: string) {
  return request<SigchainResponse>(`/users/${userPubkey}/sigchain`)
}

export async function appendSigchainLink(userPubkey: string, body: AppendSigchainLinkBody) {
  return request<SigchainLinkRecord>(`/users/${userPubkey}/sigchain`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// --- PUK envelopes (docs/protocol/PROTOCOL.md §4.38) ---

export async function distributePukEnvelopes(body: DistributePukEnvelopesBody) {
  return request<DistributePukEnvelopesResponse>('/puk/envelopes', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function getPukEnvelope(deviceId: string) {
  return request<PukEnvelopeResponse>(`/puk/envelopes/${encodeURIComponent(deviceId)}`)
}
