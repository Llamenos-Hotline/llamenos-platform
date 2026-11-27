import { z } from 'zod'

/**
 * How Signal delivers the verification code. `sms` is confirmed by the bridge on
 * its own; `voice` waits for the admin to read the code back via `/signal/verify`.
 */
export const signalRegistrationMethodSchema = z.enum([
  'sms',
  'voice',
])
export type SignalRegistrationMethod = z.infer<typeof signalRegistrationMethodSchema>

/**
 * The registration state machine, as the server enforces it
 * (`SignalRegistrationService`'s transition table):
 *
 *   idle -> pending -> verifying -> complete
 *                  \-> complete          (SMS auto-confirmed by the bridge)
 *   pending | verifying -> failed         (timeout, or the third wrong code)
 *
 * `complete` and `failed` are terminal. A client keeps polling while the status
 * is `pending` and asks for a code while it is `pending` or `verifying`.
 */
export const signalRegistrationStatusSchema = z.enum([
  'idle',
  'pending',
  'verifying',
  'complete',
  'failed',
])
export type SignalRegistrationStatus = z.infer<typeof signalRegistrationStatusSchema>

/**
 * A hub's Signal registration as the provider-setup routes return it.
 *
 * The phone number is carried ONLY as `phoneNumberMasked` (the last four digits)
 * and the bridge URL is not carried at all: the raw number is stored encrypted
 * and the bridge URL is internal, so neither crosses the wire.
 */
export const signalRegistrationStateSchema = z.object({
  id: z.string(),
  hubId: z.string(),
  phoneNumberMasked: z.string(),
  method: signalRegistrationMethodSchema,
  status: signalRegistrationStatusSchema,
  attempts: z.number().int(),
  error: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SignalRegistration = z.infer<typeof signalRegistrationStateSchema>
