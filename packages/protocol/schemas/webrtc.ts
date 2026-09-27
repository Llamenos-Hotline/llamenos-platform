import { z } from 'zod'
import { telephonyProviderTypeSchema } from './settings'

// --- Response schemas ---

export const webrtcTokenResponseSchema = z.object({
  token: z.string(),
  provider: z.string(),
  identity: z.string(),
  roomName: z.string().optional(),
})

/**
 * A single STUN/TURN server for the SIP client's ICE agent.
 *
 * Note the singular `url`: this is the shape the server emits
 * (`apps/worker/telephony/sip-tokens.ts`), not the plural `urls` of the browser
 * `RTCIceServer` dictionary. Deliberately not exported — quicktype names the
 * generated struct from the `iceServers` property, and a second top-level
 * registry entry would produce a duplicate type.
 */
const sipIceServerSchema = z.object({
  url: z.string(),
  username: z.string().optional(),
  credential: z.string().optional(),
})

/**
 * SIP account parameters, consumed directly by the Linphone SDK on mobile.
 * Not exported, for the same codegen reason as `sipIceServerSchema`.
 */
const sipCredentialsSchema = z.object({
  domain: z.string(),
  transport: z.enum(['tls', 'tcp', 'udp']),
  username: z.string(),
  password: z.string(),
  iceServers: z.array(sipIceServerSchema),
  mediaEncryption: z.enum(['srtp', 'zrtp', 'dtls-srtp', 'none']),
})

/**
 * `GET /api/telephony/sip-token`.
 *
 * This describes exactly what the server returns; `generateSipParams` is typed
 * from this schema so the two cannot drift again.
 *
 * `issuedAt`/`expiresAt` bound the validity of these parameters. A client must
 * re-fetch and re-register before `expiresAt`, otherwise its SIP registration
 * silently lapses and it stops ringing. Both are absolute RFC 3339 timestamps
 * so they survive being persisted across an app restart; a client that distrusts
 * its own wall clock can use `expiresAt - issuedAt` as a relative lifetime
 * measured from the moment the response arrived.
 */
export const sipTokenResponseSchema = z.object({
  provider: telephonyProviderTypeSchema,
  sip: sipCredentialsSchema,
  issuedAt: z.string(),
  expiresAt: z.string(),
})

/** The wire type for `GET /api/telephony/sip-token`. The server is typed from this. */
export type SipTokenResponse = z.infer<typeof sipTokenResponseSchema>

export const telephonyStatusResponseSchema = z.object({
  available: z.boolean(),
  provider: z.string().nullable(),
})
