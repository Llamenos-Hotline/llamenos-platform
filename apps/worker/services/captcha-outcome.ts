/**
 * Voice CAPTCHA submission classifier (#2179).
 *
 * A challenge allows `CAPTCHA_MAX_ATTEMPTS` real attempts. A `*` asks to hear
 * the digits again and is free up to `CAPTCHA_MAX_REPEATS` times; past that it
 * counts as an attempt. A submission with no digits at all is the provider
 * reporting that the caller pressed nothing before the gather timed out.
 *
 * Pure: the caller loads the challenge row, applies `next`, and deletes the row
 * on a terminal outcome. Kept free of I/O so every branch is unit-testable.
 */

export const CAPTCHA_MAX_ATTEMPTS = 2
export const CAPTCHA_MAX_REPEATS = 3

/** Every way one CAPTCHA submission can end. */
export type CaptchaOutcome = 'pass' | 'retry' | 'repeat' | 'fail' | 'timeout'
/** The outcomes after which the challenge is over and its row deleted. */
export type TerminalCaptchaOutcome = Extract<CaptchaOutcome, 'pass' | 'fail' | 'timeout'>
/** The outcomes after which the caller hears the same digits again. */
export type ContinuingCaptchaOutcome = Extract<CaptchaOutcome, 'retry' | 'repeat'>

export const CAPTCHA_OUTCOMES: readonly CaptchaOutcome[] = ['pass', 'retry', 'repeat', 'fail', 'timeout']

export interface CaptchaChallengeState {
  expected: string
  attempts: number
  repeats: number
}

export type CaptchaClassification =
  | { outcome: TerminalCaptchaOutcome }
  | { outcome: ContinuingCaptchaOutcome; next: { attempts: number; repeats: number } }

/** Constant-time string equality: the answer must not leak through timing. */
function constantTimeEqual(expected: string, actual: string): boolean {
  let match = expected.length === actual.length ? 1 : 0
  for (let i = 0; i < expected.length; i++) {
    match &= expected.charCodeAt(i) === actual.charCodeAt(i) ? 1 : 0
  }
  return match === 1
}

export function classifyCaptchaSubmission(state: CaptchaChallengeState, digits: string): CaptchaClassification {
  if (digits.includes('*') && state.repeats < CAPTCHA_MAX_REPEATS) {
    return { outcome: 'repeat', next: { attempts: state.attempts, repeats: state.repeats + 1 } }
  }

  if (constantTimeEqual(state.expected, digits)) return { outcome: 'pass' }

  const attempts = state.attempts + 1
  if (attempts < CAPTCHA_MAX_ATTEMPTS) {
    return { outcome: 'retry', next: { attempts, repeats: state.repeats } }
  }
  return { outcome: digits === '' ? 'timeout' : 'fail' }
}
