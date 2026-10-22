import { z } from 'zod'

// --- Input schemas ---

export const authenticateBodySchema = z.object({
  assertion: z.record(z.string(), z.unknown()),
  challengeId: z.string().min(1),
})

export const addCredentialBodySchema = z.object({
  label: z.string().min(1).max(100).optional(),
})

export const registerCredentialBodySchema = z.object({
  attestation: z.record(z.string(), z.unknown()),
  label: z.string().min(1).max(100),
  challengeId: z.string().min(1),
})

/** PATCH /api/webauthn/credentials/:credId — rename one of the caller's own passkeys. */
export const renameCredentialBodySchema = z.object({
  label: z.string().trim().min(1).max(100),
})

export type RenameCredentialBody = z.infer<typeof renameCredentialBodySchema>

// --- Response schemas ---

export const webauthnCredentialResponseSchema = z.object({
  id: z.string(),
  publicKey: z.string(),
  counter: z.number(),
  name: z.string().optional(),
  createdAt: z.string().optional(),
  lastUsedAt: z.string().optional(),
})

export const webauthnChallengeResponseSchema = z.object({
  challenge: z.string(),
})

export const webauthnOptionsResponseSchema = z.object({
  challengeId: z.string(),
  challenge: z.string(),
})

export const webauthnLoginResponseSchema = z.object({
  token: z.string(),
  pubkey: z.string(),
})

export const webauthnCredentialInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** Authenticator transports reported at registration ('internal', 'usb', 'hybrid', …). */
  transports: z.array(z.string()),
  backedUp: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
})

export type WebAuthnCredentialInfo = z.infer<typeof webauthnCredentialInfoSchema>

export const webauthnCredentialsListResponseSchema = z.object({
  credentials: z.array(webauthnCredentialInfoSchema),
})
