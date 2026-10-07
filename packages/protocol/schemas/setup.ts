import { z } from 'zod'

// --- Response schemas ---

export const setupStateResponseSchema = z.object({
  setupCompleted: z.boolean(),
})

export const connectionTestResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
})

// --- Input schemas ---

export const testSignalBodySchema = z.object({
  bridgeUrl: z.string().min(1, 'Bridge URL is required'),
  bridgeApiKey: z.string().optional(),
})

export const testWhatsAppBodySchema = z.object({
  phoneNumberId: z.string().min(1, 'Phone Number ID is required'),
  accessToken: z.string().min(1, 'Access Token is required'),
})

// --- Signal Registration ---

export const signalRegisterBodySchema = z.object({
  bridgeUrl: z.string().min(1, 'Bridge URL is required'),
  bridgeApiKey: z.string().min(1, 'Bridge API key is required'),
  phoneNumber: z.string().min(1, 'Phone number is required'),
  useVoice: z.boolean().optional().default(false),
  captcha: z.string().optional(),
})

export const signalVerifyBodySchema = z.object({
  bridgeUrl: z.string().min(1, 'Bridge URL is required'),
  bridgeApiKey: z.string().min(1, 'Bridge API key is required'),
  phoneNumber: z.string().min(1, 'Phone number is required'),
  verificationCode: z.string().min(1, 'Verification code is required'),
})

export const signalUnregisterBodySchema = z.object({
  bridgeUrl: z.string().min(1, 'Bridge URL is required'),
  bridgeApiKey: z.string().min(1, 'Bridge API key is required'),
  registeredNumber: z.string().min(1, 'Registered number is required'),
})

export const signalRegistrationResponseSchema = z.object({
  step: z.enum(['idle', 'pending_verification', 'verified', 'failed']),
  number: z.string().optional(),
  error: z.string().optional(),
  bridgeUrl: z.string().optional(),
  startedAt: z.string().optional(),
})

export type SignalRegistrationState = z.infer<typeof signalRegistrationResponseSchema>

export const signalAccountInfoResponseSchema = z.object({
  registered: z.boolean(),
  number: z.string(),
  uuid: z.string().optional(),
  devices: z.array(z.object({
    id: z.number(),
    name: z.string().optional(),
  })).optional(),
  error: z.string().optional(),
})

export type SignalAccountInfo = z.infer<typeof signalAccountInfoResponseSchema>
