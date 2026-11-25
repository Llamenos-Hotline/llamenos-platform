/**
 * At-rest protection of messaging channel credentials (#3031).
 *
 * `system_settings.messaging_config` is a jsonb column holding both settings an
 * operator may read back (auto-response text, limits, which channels are on) and
 * the credentials that let anyone holding them send as the hotline. The
 * credentials are split out and sealed with the same `encryptCredentials` path
 * telephony credentials use (`serverEncrypt` under SERVER_KEK,
 * LABEL_STORAGE_CREDENTIAL_WRAP). The stored object is therefore:
 *
 *   { ...every non-secret setting..., sealedSecrets: "<hex ciphertext>" }
 *
 * and `MessagingConfig` as the rest of the worker sees it is that object with
 * the sealed secrets merged back in, in memory only.
 */
import type { MessagingConfig } from '@shared/types'
import { decryptCredentials, encryptCredentials } from './provider-setup/crypto'
import { ServiceError } from './service-error'

/** The channels that carry credentials, and which of their fields are secret. */
export const MESSAGING_SECRET_FIELDS = {
  whatsapp: ['accessToken', 'appSecret', 'verifyToken'],
  signal: ['bridgeApiKey', 'webhookSecret'],
  rcs: ['serviceAccountKey', 'webhookSecret'],
  telegram: ['botToken', 'webhookSecret'],
} as const satisfies Record<string, readonly string[]>

export type SecretChannel = keyof typeof MESSAGING_SECRET_FIELDS

/** The key under which the sealed ciphertext sits in the stored jsonb object. */
export const SEALED_SECRETS_KEY = 'sealedSecrets'

type ChannelRecord = Record<string, unknown>
type SecretBag = Partial<Record<SecretChannel, Record<string, string>>>

const SECRET_CHANNELS = Object.keys(MESSAGING_SECRET_FIELDS) as SecretChannel[]

function isRecord(value: unknown): value is ChannelRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A secret counts as present only when it is a non-empty string. */
function isPresent(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** True when the stored object still carries a credential in the clear. */
export function hasPlaintextSecrets(stored: unknown): boolean {
  if (!isRecord(stored)) return false
  return SECRET_CHANNELS.some((channel) => {
    const cfg = stored[channel]
    return isRecord(cfg) && MESSAGING_SECRET_FIELDS[channel].some((f) => isPresent(cfg[f]))
  })
}

/** Split a config into its open part and the secrets that must be sealed. */
export function splitSecrets(config: Record<string, unknown>): {
  open: Record<string, unknown>
  secrets: SecretBag
} {
  const open: Record<string, unknown> = { ...config }
  delete open[SEALED_SECRETS_KEY]
  const secrets: SecretBag = {}
  for (const channel of SECRET_CHANNELS) {
    const cfg = open[channel]
    if (!isRecord(cfg)) continue
    const rest: ChannelRecord = { ...cfg }
    const bag: Record<string, string> = {}
    for (const field of MESSAGING_SECRET_FIELDS[channel]) {
      if (isPresent(rest[field])) bag[field] = rest[field]
      delete rest[field]
    }
    open[channel] = rest
    if (Object.keys(bag).length > 0) secrets[channel] = bag
  }
  return { open, secrets }
}

/** The stored form of `config`: secrets sealed, everything else as it is. */
export function sealMessagingConfig(
  config: Record<string, unknown>,
  serverKek: string | undefined,
): Record<string, unknown> {
  const { open, secrets } = splitSecrets(config)
  if (Object.keys(secrets).length === 0) return open
  if (!serverKek) {
    throw new ServiceError(500, 'Messaging credentials cannot be stored without SERVER_KEK')
  }
  return { ...open, [SEALED_SECRETS_KEY]: encryptCredentials(secrets, serverKek) }
}

/** The in-memory config for a stored object: sealed secrets merged back in. */
export function openMessagingConfig(
  stored: Record<string, unknown>,
  serverKek: string | undefined,
): Record<string, unknown> {
  const sealed = stored[SEALED_SECRETS_KEY]
  const { [SEALED_SECRETS_KEY]: _sealed, ...config } = stored
  if (!isPresent(sealed)) return config
  if (!serverKek) {
    throw new ServiceError(500, 'Messaging credentials cannot be read without SERVER_KEK')
  }
  const secrets = decryptCredentials(sealed, serverKek) as SecretBag
  for (const channel of SECRET_CHANNELS) {
    const bag = secrets[channel]
    const cfg = config[channel]
    if (bag && isRecord(cfg)) config[channel] = { ...cfg, ...bag }
  }
  return config
}

/**
 * A PATCH carrying a channel replaces that channel, but a client that read the
 * redacted config back never held its secrets, so it cannot send them again. A
 * secret the request leaves out (or blanks) keeps its stored value; one it
 * sends replaces it.
 */
export function carryOverSecrets(
  incoming: Partial<MessagingConfig>,
  current: MessagingConfig,
): Partial<MessagingConfig> {
  const merged: Record<string, unknown> = { ...incoming }
  for (const channel of SECRET_CHANNELS) {
    const next = merged[channel]
    const prev = (current as unknown as ChannelRecord)[channel]
    if (!isRecord(next) || !isRecord(prev)) continue
    const filled: ChannelRecord = { ...next }
    for (const field of MESSAGING_SECRET_FIELDS[channel]) {
      // The `<field>Set` flags are response-only; a client echoing them back must not store them.
      delete filled[`${field}Set`]
      if (!isPresent(filled[field]) && isPresent(prev[field])) filled[field] = prev[field]
    }
    merged[channel] = filled
  }
  return merged as Partial<MessagingConfig>
}

/**
 * The config as an API response (and an audit record) may show it: every secret
 * removed, and `<field>Set` saying whether one is stored.
 */
export function redactMessagingConfig(config: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = { ...config }
  delete redacted[SEALED_SECRETS_KEY]
  for (const channel of SECRET_CHANNELS) {
    const cfg = redacted[channel]
    if (!isRecord(cfg)) continue
    const out: ChannelRecord = { ...cfg }
    for (const field of MESSAGING_SECRET_FIELDS[channel]) {
      out[`${field}Set`] = isPresent(cfg[field])
      delete out[field]
    }
    redacted[channel] = out
  }
  return redacted
}
