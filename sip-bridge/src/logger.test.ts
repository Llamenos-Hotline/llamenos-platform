import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { logger } from './logger'

describe('sip-bridge logger redaction', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>
  let infoSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  let originalLogLevel: string | undefined

  beforeEach(() => {
    originalLogLevel = process.env.LOG_LEVEL
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    process.env.LOG_LEVEL = originalLogLevel
    debugSpy.mockRestore()
    infoSpy.mockRestore()
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  function lastCall(spy: ReturnType<typeof vi.spyOn>): string {
    const calls = spy.mock.calls
    return calls[calls.length - 1]?.[0] as string
  }

  it('redacts a caller phone number at info level', () => {
    logger.info('[handler]', 'incoming call from +15551234567')
    expect(lastCall(infoSpy)).toContain('[REDACTED:PHONE]')
    expect(lastCall(infoSpy)).not.toContain('+15551234567')
  })

  it('redacts a non-NANP E.164 number regardless of level', () => {
    logger.warn('[handler]', 'channel_create caller=+447911123456')
    expect(lastCall(warnSpy)).toContain('[REDACTED:PHONE]')
    expect(lastCall(warnSpy)).not.toContain('+447911123456')
  })

  it('redacts a bare unformatted 10-digit phone number', () => {
    logger.info('[handler]', 'caller number 5551234567 answered')
    expect(lastCall(infoSpy)).toContain('[REDACTED:PHONE]')
    expect(lastCall(infoSpy)).not.toContain('5551234567')
  })

  it('redacts an email address', () => {
    logger.info('[handler]', 'notify volunteer@example.com')
    expect(lastCall(infoSpy)).toContain('[REDACTED:EMAIL]')
    expect(lastCall(infoSpy)).not.toContain('volunteer@example.com')
  })

  it('redacts a phone number embedded in the error message argument', () => {
    logger.error('[handler]', 'originate failed for +15551234567', new Error('busy'))
    expect(lastCall(errorSpy)).toContain('[REDACTED:PHONE]')
    expect(lastCall(errorSpy)).not.toContain('+15551234567')
  })

  it('leaves non-phone content untouched', () => {
    logger.info('[handler]', 'Bridging caller and volunteer')
    expect(lastCall(infoSpy)).toContain('Bridging caller and volunteer')
  })
})
