import type { MessagingAdapter } from '../adapter'
import type { WhatsAppConfig } from '@shared/types'
import { WhatsAppAdapter } from './adapter'
import { TwilioWhatsAppClient } from './twilio-client'

/**
 * TwilioCredentials needed when constructing a Twilio-mode WhatsApp adapter.
 * These come from the telephony provider config, not the WhatsApp config itself.
 */
export interface TwilioCredentials {
  accountSid: string
  authToken: string
  whatsappNumber: string
}

/**
 * Create a WhatsAppAdapter from the given config.
 *
 * For "direct" mode, the config must include all Meta Cloud API fields.
 * For "twilio" mode, Twilio credentials must be provided separately
 * (they live in the telephony provider config, not the WhatsApp config).
 */
export function createWhatsAppAdapter(
  config: WhatsAppConfig,
  twilioCredentials?: TwilioCredentials,
  webhookBaseUrl = '',
): MessagingAdapter {
  if (config.integrationMode === 'direct') {
    return new WhatsAppAdapter(config)
  }

  if (!twilioCredentials) {
    throw new Error(
      'Twilio WhatsApp mode requires twilioCredentials (accountSid, authToken, whatsappNumber)',
    )
  }

  const client = new TwilioWhatsAppClient(
    twilioCredentials.accountSid,
    twilioCredentials.authToken,
    twilioCredentials.whatsappNumber,
    webhookBaseUrl,
  )

  return WhatsAppAdapter.createWithTwilioClient(config, client)
}
