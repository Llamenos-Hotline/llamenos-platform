import { request } from './client'
import type { MessagingConfig } from '@protocol/schemas'

export type { MessagingConfig }
export type { EnabledChannels } from '@shared/types'

// --- Messaging Config ---

export async function getMessagingConfig() {
  return request<MessagingConfig>('/settings/messaging')
}

export async function updateMessagingConfig(data: MessagingConfig) {
  return request<MessagingConfig>('/settings/messaging', {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function testMessagingChannel(channel: string) {
  return request<{ connected: boolean }>('/settings/messaging/test', {
    method: 'POST',
    body: JSON.stringify({ channel }),
  })
}
