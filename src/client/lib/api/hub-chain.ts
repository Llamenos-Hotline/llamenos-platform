import { request } from './client'
import type {
  AppendHubChainLinkBody,
  AppendHubChainLinkResponse,
  HubChainLink,
  HubChainResponse,
  HubFoundingResponse,
} from '@protocol/schemas/hub-chain'

// --- Hub authority chain (#2963; wire spec §5) ---

/** One page of a hub's chain: links with `seq >= from`, in seq order. */
export async function getHubChainPage(hubId: string, from: number) {
  return request<HubChainResponse>(`/hubs/${encodeURIComponent(hubId)}/chain?from=${from}`)
}

/** Append one signed link; a 409 means the head moved (re-read, re-evaluate, re-sign). */
export async function appendHubChainLink(hubId: string, link: HubChainLink) {
  const body: AppendHubChainLinkBody = { link }
  return request<AppendHubChainLinkResponse>(`/hubs/${encodeURIComponent(hubId)}/chain`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** The bundles a new hub's founder signs into its genesis, with their concrete permissions. */
export async function getHubFounding() {
  return request<HubFoundingResponse>('/hubs/founding')
}
