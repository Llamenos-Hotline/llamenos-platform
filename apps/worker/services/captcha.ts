import { eq } from 'drizzle-orm'
import type { Database } from '../db'
import { captchas } from '../db/schema'
import {
  classifyCaptchaSubmission,
  type ContinuingCaptchaOutcome,
  type TerminalCaptchaOutcome,
} from './captcha-outcome'

const CAPTCHA_TTL_MS = 5 * 60 * 1000

/**
 * Server-side voice-CAPTCHA state (`captchas`).
 */
export class CaptchaService {
  constructor(protected db: Database) {}

  async storeCaptcha(data: {
    callSid: string
    expected: string
  }): Promise<{ ok: true }> {
    await this.db
      .insert(captchas)
      .values({
        callSid: data.callSid,
        expected: data.expected,
        createdAt: new Date(),
      })
      .onConflictDoUpdate({
        target: captchas.callSid,
        set: {
          expected: data.expected,
          attempts: 0,
          repeats: 0,
          createdAt: new Date(),
        },
      })
    return { ok: true }
  }

  /**
   * Classify one CAPTCHA submission and advance the challenge (#2179).
   *
   * The challenge row survives a `retry` or `repeat` (the caller hears the same
   * digits again) and is deleted only on a terminal outcome — before this, it
   * was deleted on the first submission, so a second attempt could never pass.
   * The row is locked for the read-modify-write, so two webhooks for one call
   * cannot both spend the same attempt.
   */
  async submitCaptcha(data: {
    callSid: string
    digits: string
  }): Promise<
    | { outcome: TerminalCaptchaOutcome }
    | { outcome: ContinuingCaptchaOutcome; digitsToSpeak: string; round: number }
  > {
    return this.db.transaction(async (tx) => {
      const [stored] = await tx
        .select()
        .from(captchas)
        .where(eq(captchas.callSid, data.callSid))
        .for('update')

      if (!stored || Date.now() - stored.createdAt.getTime() > CAPTCHA_TTL_MS) {
        if (stored) await tx.delete(captchas).where(eq(captchas.callSid, data.callSid))
        return { outcome: 'fail' as const }
      }

      const result = classifyCaptchaSubmission(stored, data.digits)
      if (result.outcome === 'retry' || result.outcome === 'repeat') {
        await tx
          .update(captchas)
          .set({ attempts: result.next.attempts, repeats: result.next.repeats })
          .where(eq(captchas.callSid, data.callSid))
        return {
          outcome: result.outcome,
          digitsToSpeak: stored.expected,
          round: result.next.attempts + result.next.repeats,
        }
      }

      await tx.delete(captchas).where(eq(captchas.callSid, data.callSid))
      return { outcome: result.outcome }
    })
  }
}
