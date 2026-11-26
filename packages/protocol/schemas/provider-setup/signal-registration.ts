import { z } from 'zod'

export const signalRegistrationMethodSchema = z.enum([
  'bridge',
  'cli',
  'rest_api',
])
export type SignalRegistrationMethod = z.infer<typeof signalRegistrationMethodSchema>

export const signalRegistrationStatusSchema = z.enum([
  'pending',
  'registering',
  'registered',
  'failed',
  'expired',
])
export type SignalRegistrationStatus = z.infer<typeof signalRegistrationStatusSchema>

export const signalRegistrationStateSchema = z.object({
  id: z.string(),
  hubId: z.string(),
  bridgeUrl: z.string().optional(),
  phoneNumber: z.string(),
  method: signalRegistrationMethodSchema,
  status: signalRegistrationStatusSchema,
  error: z.string().optional(),
  expiresAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SignalRegistration = z.infer<typeof signalRegistrationStateSchema>

export const signalRegisterRequestSchema = z.object({
  bridgeUrl: z.string(),
  phoneNumber: z.string(),
  method: z.enum(['sms', 'voice']).optional().default('sms'),
  hubId: z.string().optional(),
})
export type SignalRegisterRequest = z.input<typeof signalRegisterRequestSchema>

export const signalVerifyRequestSchema = z.object({
  registrationId: z.string(),
  code: z.string().regex(/^\d{3,8}$/),
  hubId: z.string().optional(),
})
export type SignalVerifyRequest = z.input<typeof signalVerifyRequestSchema>
