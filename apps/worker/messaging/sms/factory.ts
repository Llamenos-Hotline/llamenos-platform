import type { MessagingAdapter } from '../adapter'
import type { TelephonyProviderConfig, SMSConfig } from '@shared/types'
import { TwilioSMSAdapter } from './twilio'
import { SignalWireSMSAdapter } from './signalwire'
import { VonageSMSAdapter } from './vonage'
import { PlivoSMSAdapter } from './plivo'
import { AsteriskSMSAdapter } from './asterisk'

/**
 * Create an SMS messaging adapter based on the telephony provider configuration.
 * SMS reuses the telephony provider credentials -- no separate SMS credentials needed.
 *
 * @param telephonyConfig - The telephony provider configuration (credentials, type)
 * @param _smsConfig - SMS-specific configuration (enabled state, auto-responses).
 *                     Prefixed with _ because the factory only needs telephonyConfig
 *                     for adapter creation; smsConfig is consumed by the router layer.
 */
export function createSMSAdapter(
  telephonyConfig: TelephonyProviderConfig,
  _smsConfig: SMSConfig,
  webhookBaseUrl = '',
): MessagingAdapter {
  const phoneNumber = telephonyConfig.phoneNumber

  switch (telephonyConfig.type) {
    case 'twilio': {
      if (!telephonyConfig.accountSid || !telephonyConfig.authToken) {
        throw new Error('Twilio SMS requires accountSid and authToken')
      }
      return new TwilioSMSAdapter(
        telephonyConfig.accountSid,
        telephonyConfig.authToken,
        phoneNumber,
        webhookBaseUrl,
      )
    }

    case 'signalwire': {
      if (!telephonyConfig.accountSid || !telephonyConfig.authToken || !telephonyConfig.signalwireSpace) {
        throw new Error('SignalWire SMS requires accountSid, authToken, and signalwireSpace')
      }
      return new SignalWireSMSAdapter(
        telephonyConfig.accountSid,
        telephonyConfig.authToken,
        phoneNumber,
        telephonyConfig.signalwireSpace,
        webhookBaseUrl,
      )
    }

    case 'vonage': {
      if (!telephonyConfig.apiKey || !telephonyConfig.apiSecret) {
        throw new Error('Vonage SMS requires apiKey and apiSecret')
      }
      return new VonageSMSAdapter(
        telephonyConfig.apiKey,
        telephonyConfig.apiSecret,
        phoneNumber,
      )
    }

    case 'plivo': {
      if (!telephonyConfig.authId || !telephonyConfig.authToken) {
        throw new Error('Plivo SMS requires authId and authToken')
      }
      return new PlivoSMSAdapter(
        telephonyConfig.authId,
        telephonyConfig.authToken,
        phoneNumber,
        webhookBaseUrl,
      )
    }

    case 'asterisk': {
      // Asterisk has no native SMS -- delegate to Twilio if credentials available
      if (telephonyConfig.accountSid && telephonyConfig.authToken) {
        const twilioDelegate = new TwilioSMSAdapter(
          telephonyConfig.accountSid,
          telephonyConfig.authToken,
          phoneNumber,
          webhookBaseUrl,
        )
        return new AsteriskSMSAdapter(twilioDelegate)
      }
      throw new Error(
        'Asterisk requires separate SMS provider credentials. ' +
        'Provide Twilio accountSid and authToken alongside Asterisk config for SMS support.'
      )
    }

    default: {
      // Default to Twilio for unknown/future providers
      if (!telephonyConfig.accountSid || !telephonyConfig.authToken) {
        throw new Error('SMS adapter requires accountSid and authToken')
      }
      return new TwilioSMSAdapter(
        telephonyConfig.accountSid,
        telephonyConfig.authToken,
        phoneNumber,
        webhookBaseUrl,
      )
    }
  }
}
