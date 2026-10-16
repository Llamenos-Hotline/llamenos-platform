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
 * One ICE server in a `/api/telephony/sip-token` response.
 *
 * `url` singular, and a `turn:`/`turns:` entry carries the time-limited
 * credential pair the worker minted (`mintTurnCredentials`). A `stun:` entry
 * carries neither. RFC 7064/7065 URIs are NOT hierarchical — there is no
 * `//` — so the value is `scheme:host:port[?transport=…]`.
 */
export const sipIceServerSchema = z.object({
  url: z.string(),
  username: z.string().optional(),
  credential: z.string().optional(),
})

/**
 * `GET /api/telephony/sip-token` — the per-volunteer SIP credential.
 *
 * This describes what `buildVolunteerSipParams`
 * (apps/worker/telephony/registrar.ts) actually returns, which is NESTED under
 * `sip`. It previously described a flat shape with `iceServers[].urls` and
 * `encryption`, none of which the server has ever sent (#1190): the OpenAPI
 * snapshot was wrong, and so was every client model written from it — iOS's
 * `SipTokenResponse` could not decode a single real response (#1659).
 *
 * `SipConnectionParams` in apps/worker/telephony/sip-tokens.ts is now
 * `z.infer` of this, so the route and the published contract cannot drift
 * apart again by editing one of them.
 */
export const sipTokenResponseSchema = z.object({
  provider: telephonyProviderTypeSchema,
  sip: z.object({
    domain: z.string(),
    transport: z.enum(['tls', 'tcp', 'udp']),
    username: z.string(),
    password: z.string(),
    iceServers: z.array(sipIceServerSchema),
    mediaEncryption: z.enum(['srtp', 'zrtp', 'dtls-srtp', 'none']),
    /**
     * PEM trust anchor for the SIP edge's TLS certificate, when the deployment
     * serves one the device trust store cannot verify. Certificates only.
     * Absent means "verify against the device trust store"; it never means
     * "do not verify".
     */
    tlsTrustAnchorPem: z.string().optional(),
  }),
})

export type SipIceServer = z.infer<typeof sipIceServerSchema>
export type SipTokenResponse = z.infer<typeof sipTokenResponseSchema>

export const telephonyStatusResponseSchema = z.object({
  available: z.boolean(),
  provider: z.string().nullable(),
})
