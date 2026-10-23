import { useQuery } from '@tanstack/react-query'
import { getWebhookUrls } from '@/lib/api/provider-setup'
import { getActiveHub } from '@/lib/api/client'

export const providerSetupKeys = {
  all: ['provider-setup'] as const,
  webhookUrls: (hubId: string | null) => [...providerSetupKeys.all, 'webhook-urls', hubId] as const,
}

/**
 * The server-built webhook URLs for the hub being browsed (#2068). Keyed by hub
 * because the messaging URLs carry it.
 */
export function useWebhookUrls(enabled = true) {
  const hubId = getActiveHub()
  return useQuery({
    queryKey: providerSetupKeys.webhookUrls(hubId),
    queryFn: getWebhookUrls,
    enabled,
    staleTime: Infinity,
  })
}
