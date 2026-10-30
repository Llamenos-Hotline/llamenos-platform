/**
 * Voice CAPTCHA classifier (#2179): two real attempts, a free "press star to
 * hear them again" up to a cap, and a timeout told apart from a wrong answer.
 */
import { describe, expect, it } from 'vitest'
import {
  CAPTCHA_MAX_ATTEMPTS,
  CAPTCHA_MAX_REPEATS,
  classifyCaptchaSubmission,
} from '@worker/services/captcha-outcome'

const fresh = { expected: '4821', attempts: 0, repeats: 0 }

describe('classifyCaptchaSubmission', () => {
  it('passes the right digits, on the first or the second attempt', () => {
    expect(classifyCaptchaSubmission(fresh, '4821')).toEqual({ outcome: 'pass' })
    expect(classifyCaptchaSubmission({ ...fresh, attempts: 1 }, '4821')).toEqual({ outcome: 'pass' })
  })

  it('gives a second attempt after a wrong answer, then fails', () => {
    expect(classifyCaptchaSubmission(fresh, '1111')).toEqual({ outcome: 'retry', next: { attempts: 1, repeats: 0 } })
    expect(classifyCaptchaSubmission({ ...fresh, attempts: 1 }, '1111')).toEqual({ outcome: 'fail' })
    expect(CAPTCHA_MAX_ATTEMPTS).toBe(2)
  })

  it('counts no input as an attempt and ends a second one as a timeout, not a fail', () => {
    expect(classifyCaptchaSubmission(fresh, '')).toEqual({ outcome: 'retry', next: { attempts: 1, repeats: 0 } })
    expect(classifyCaptchaSubmission({ ...fresh, attempts: 1 }, '')).toEqual({ outcome: 'timeout' })
  })

  it('a wrong answer after a timeout is a fail', () => {
    expect(classifyCaptchaSubmission({ ...fresh, attempts: 1 }, '12')).toEqual({ outcome: 'fail' })
  })

  it('star repeats the digits without spending an attempt', () => {
    expect(classifyCaptchaSubmission(fresh, '*')).toEqual({ outcome: 'repeat', next: { attempts: 0, repeats: 1 } })
    // A star after partial digits is still a request to hear them again.
    expect(classifyCaptchaSubmission({ ...fresh, attempts: 1 }, '48*')).toEqual({
      outcome: 'repeat',
      next: { attempts: 1, repeats: 1 },
    })
  })

  it('a star past the repeat cap counts as an attempt', () => {
    const capped = { ...fresh, repeats: CAPTCHA_MAX_REPEATS }
    expect(classifyCaptchaSubmission(capped, '*')).toEqual({
      outcome: 'retry',
      next: { attempts: 1, repeats: CAPTCHA_MAX_REPEATS },
    })
    expect(classifyCaptchaSubmission({ ...capped, attempts: 1 }, '*')).toEqual({ outcome: 'fail' })
  })

  it('rejects a prefix or an extension of the answer', () => {
    expect(classifyCaptchaSubmission(fresh, '482').outcome).toBe('retry')
    expect(classifyCaptchaSubmission(fresh, '48210').outcome).toBe('retry')
  })
})
