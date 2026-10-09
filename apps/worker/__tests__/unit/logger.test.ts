import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createLogger,
  _setLoggerConfigForTests,
  _clearLoggerOverflowInterval,
  withCorrelation,
  getCorrelation,
  redact,
} from '@worker/lib/logger'

describe('logger', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let originalNodeEnv: string | undefined

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'test'
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    _setLoggerConfigForTests({
      minLevel: 'trace',
      namespaces: ['*'],
      rateLimits: {
        trace: Number.POSITIVE_INFINITY,
        debug: Number.POSITIVE_INFINITY,
        info: Number.POSITIVE_INFINITY,
        warn: Number.POSITIVE_INFINITY,
        error: Number.POSITIVE_INFINITY,
        fatal: Number.POSITIVE_INFINITY,
      },
      stripStacks: true,
    })
  })

  afterEach(() => {
    _clearLoggerOverflowInterval()
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    process.env.NODE_ENV = originalNodeEnv
  })

  function lastStdout(): Record<string, unknown> | null {
    if (stdoutSpy.mock.calls.length === 0) return null
    const last = stdoutSpy.mock.calls[stdoutSpy.mock.calls.length - 1][0] as string
    return JSON.parse(last)
  }

  function lastStderr(): Record<string, unknown> | null {
    if (stderrSpy.mock.calls.length === 0) return null
    const last = stderrSpy.mock.calls[stderrSpy.mock.calls.length - 1][0] as string
    return JSON.parse(last)
  }

  describe('basic logging', () => {
    it('writes trace to stdout', () => {
      const log = createLogger('test.ns')
      log.trace('hello trace')
      const entry = lastStdout()
      expect(entry).toMatchObject({ level: 'trace', namespace: 'test.ns', message: 'hello trace' })
    })

    it('writes debug to stdout', () => {
      const log = createLogger('test.ns')
      log.debug('hello debug')
      expect(lastStdout()).toMatchObject({ level: 'debug', message: 'hello debug' })
    })

    it('writes info to stdout', () => {
      const log = createLogger('test.ns')
      log.info('hello info')
      expect(lastStdout()).toMatchObject({ level: 'info', message: 'hello info' })
    })

    it('writes warn to stdout', () => {
      const log = createLogger('test.ns')
      log.warn('hello warn')
      expect(lastStdout()).toMatchObject({ level: 'warn', message: 'hello warn' })
    })

    it('writes error to stderr', () => {
      const log = createLogger('test.ns')
      log.error('hello error')
      expect(lastStderr()).toMatchObject({ level: 'error', message: 'hello error' })
    })

    it('writes fatal to stderr', () => {
      const log = createLogger('test.ns')
      log.fatal('hello fatal')
      expect(lastStderr()).toMatchObject({ level: 'fatal', message: 'hello fatal' })
    })

    it('includes ISO timestamp', () => {
      const log = createLogger('test.ns')
      log.info('timestamp check')
      const entry = lastStdout()
      expect(typeof entry?.timestamp).toBe('string')
      expect(new Date(entry!.timestamp as string).toISOString()).toBe(entry!.timestamp)
    })
  })

  describe('namespace filtering', () => {
    it('allows all namespaces with wildcard', () => {
      _setLoggerConfigForTests({
        minLevel: 'trace',
        namespaces: ['*'],
        rateLimits: {
          trace: Number.POSITIVE_INFINITY,
          debug: Number.POSITIVE_INFINITY,
          info: Number.POSITIVE_INFINITY,
          warn: Number.POSITIVE_INFINITY,
          error: Number.POSITIVE_INFINITY,
          fatal: Number.POSITIVE_INFINITY,
        },
        stripStacks: true,
      })
      const log = createLogger('anything.here')
      log.info('allowed')
      expect(lastStdout()).toMatchObject({ message: 'allowed' })
    })

    it('filters out non-matching namespaces', () => {
      _setLoggerConfigForTests({
        minLevel: 'trace',
        namespaces: ['services.*'],
        rateLimits: {
          trace: Number.POSITIVE_INFINITY,
          debug: Number.POSITIVE_INFINITY,
          info: Number.POSITIVE_INFINITY,
          warn: Number.POSITIVE_INFINITY,
          error: Number.POSITIVE_INFINITY,
          fatal: Number.POSITIVE_INFINITY,
        },
        stripStacks: true,
      })
      const allowed = createLogger('services.blasts')
      const blocked = createLogger('telephony.twilio')
      allowed.info('yes')
      blocked.info('no')
      expect(lastStdout()).toMatchObject({ namespace: 'services.blasts', message: 'yes' })
      expect(stdoutSpy).toHaveBeenCalledTimes(1)
    })

    it('allows exact namespace match', () => {
      _setLoggerConfigForTests({
        minLevel: 'trace',
        namespaces: ['exact.match'],
        rateLimits: {
          trace: Number.POSITIVE_INFINITY,
          debug: Number.POSITIVE_INFINITY,
          info: Number.POSITIVE_INFINITY,
          warn: Number.POSITIVE_INFINITY,
          error: Number.POSITIVE_INFINITY,
          fatal: Number.POSITIVE_INFINITY,
        },
        stripStacks: true,
      })
      createLogger('exact.match').info('ok')
      createLogger('exact.match.more').info('not ok')
      expect(stdoutSpy).toHaveBeenCalledTimes(1)
      expect(lastStdout()).toMatchObject({ namespace: 'exact.match' })
    })

    it('supports prefix wildcard', () => {
      _setLoggerConfigForTests({
        minLevel: 'trace',
        namespaces: ['foo.*'],
        rateLimits: {
          trace: Number.POSITIVE_INFINITY,
          debug: Number.POSITIVE_INFINITY,
          info: Number.POSITIVE_INFINITY,
          warn: Number.POSITIVE_INFINITY,
          error: Number.POSITIVE_INFINITY,
          fatal: Number.POSITIVE_INFINITY,
        },
        stripStacks: true,
      })
      createLogger('foo').info('root')
      createLogger('foo.bar').info('child')
      createLogger('foo.bar.baz').info('grandchild')
      createLogger('other').info('excluded')
      expect(stdoutSpy).toHaveBeenCalledTimes(3)
    })
  })

  describe('level filtering', () => {
    it('drops levels below minLevel', () => {
      _setLoggerConfigForTests({
        minLevel: 'warn',
        namespaces: ['*'],
        rateLimits: {
          trace: Number.POSITIVE_INFINITY,
          debug: Number.POSITIVE_INFINITY,
          info: Number.POSITIVE_INFINITY,
          warn: Number.POSITIVE_INFINITY,
          error: Number.POSITIVE_INFINITY,
          fatal: Number.POSITIVE_INFINITY,
        },
        stripStacks: true,
      })
      const log = createLogger('test')
      log.trace('t')
      log.debug('d')
      log.info('i')
      log.warn('w')
      expect(stdoutSpy).toHaveBeenCalledTimes(1)
      expect(lastStdout()).toMatchObject({ level: 'warn', message: 'w' })
    })

    it('allows all levels when minLevel is trace', () => {
      _setLoggerConfigForTests({
        minLevel: 'trace',
        namespaces: ['*'],
        rateLimits: {
          trace: Number.POSITIVE_INFINITY,
          debug: Number.POSITIVE_INFINITY,
          info: Number.POSITIVE_INFINITY,
          warn: Number.POSITIVE_INFINITY,
          error: Number.POSITIVE_INFINITY,
          fatal: Number.POSITIVE_INFINITY,
        },
        stripStacks: true,
      })
      const log = createLogger('test')
      log.trace('t')
      log.debug('d')
      log.info('i')
      log.warn('w')
      log.error('e')
      log.fatal('f')
      expect(stdoutSpy).toHaveBeenCalledTimes(4)
      expect(stderrSpy).toHaveBeenCalledTimes(2)
    })
  })

  describe('redaction', () => {
    it('redacts phone numbers in extra strings', () => {
      const log = createLogger('test')
      log.info('call received', { callerPhone: '+1 (555) 123-4567' })
      expect(lastStdout()?.callerPhone).toBe('[REDACTED]')
    })

    it('redacts emails in extra strings', () => {
      const log = createLogger('test')
      log.info('contact', { email: 'admin@example.com' })
      expect(lastStdout()?.email).toBe('[REDACTED]')
    })

    it('redacts nsec strings in extra', () => {
      const log = createLogger('test')
      const nsec = 'nsec1' + 'a'.repeat(58)
      log.info('auth', { key: nsec })
      expect(lastStdout()?.key).toBe('[REDACTED:nsec]')
    })

    it('redacts 64-char hex keys in extra', () => {
      const log = createLogger('test')
      const hex = 'a'.repeat(64)
      log.info('key', { payload: hex })
      expect(lastStdout()?.payload).toBe('[REDACTED:hex64]')
    })

    it('redacts sensitive object keys', () => {
      const log = createLogger('test')
      log.info('data', { phone: '+15551234567', email: 'a@b.com', secret: 'shh', apiKey: 'key123' })
      const entry = lastStdout()
      expect(entry?.phone).toBe('[REDACTED]')
      expect(entry?.email).toBe('[REDACTED]')
      expect(entry?.secret).toBe('[REDACTED]')
      expect(entry?.apiKey).toBe('[REDACTED]')
    })

    it('does not redact non-sensitive keys', () => {
      const log = createLogger('test')
      log.info('data', { id: '123', count: 42, active: true })
      const entry = lastStdout()
      expect(entry?.id).toBe('123')
      expect(entry?.count).toBe(42)
      expect(entry?.active).toBe(true)
    })

    it('redacts nested sensitive keys up to depth 3', () => {
      const log = createLogger('test')
      log.info('deep', { a: { b: { c: { phone: '555' } } } })
      const entry = lastStdout()
      expect(entry?.a).toEqual({ b: { c: { phone: '[REDACTED]' } } })
    })

    it('truncates beyond max depth', () => {
      const log = createLogger('test')
      log.info('deep', { a: { b: { c: { d: { e: 'value' } } } } })
      const entry = lastStdout()
      expect(entry?.a).toEqual({ b: { c: { d: '[truncated:depth]' } } })
    })

    it('redacts name keys', () => {
      const log = createLogger('test')
      log.info('user', { firstName: 'Alice', lastName: 'Smith', fullName: 'Alice Smith' })
      const entry = lastStdout()
      expect(entry?.firstName).toBe('[REDACTED]')
      expect(entry?.lastName).toBe('[REDACTED]')
      expect(entry?.fullName).toBe('[REDACTED]')
    })

    it('redacts organisational-structure name keys (volunteerName, hubName)', () => {
      const log = createLogger('test')
      log.info('hub event', { volunteerName: 'Alice', hubName: 'Downtown Crisis Line' })
      const entry = lastStdout()
      expect(entry?.volunteerName).toBe('[REDACTED]')
      expect(entry?.hubName).toBe('[REDACTED]')
    })

    it('redacts telephony/messaging field names (from, to, caller, callerNumber, calledNumber, msisdn, recipient)', () => {
      const log = createLogger('test')
      log.info('webhook', {
        from: '+15551234567',
        to: '+15559876543',
        caller: '+15551234567',
        callerNumber: '+15551234567',
        calledNumber: '+15559876543',
        msisdn: '+447911123456',
        recipient: '+15551234567',
      })
      const entry = lastStdout()
      expect(entry?.from).toBe('[REDACTED]')
      expect(entry?.to).toBe('[REDACTED]')
      expect(entry?.caller).toBe('[REDACTED]')
      expect(entry?.callerNumber).toBe('[REDACTED]')
      expect(entry?.calledNumber).toBe('[REDACTED]')
      expect(entry?.msisdn).toBe('[REDACTED]')
      expect(entry?.recipient).toBe('[REDACTED]')
    })

    it('does not redact unrelated fields that merely contain "to"/"from" as a substring', () => {
      const log = createLogger('test')
      log.info('range', { total: 42, fromage: 'cheese' })
      const entry = lastStdout()
      expect(entry?.total).toBe(42)
      expect(entry?.fromage).toBe('cheese')
    })

    it('redacts E.164 phone numbers of various lengths in non-key-flagged string values (non-NANP included)', () => {
      const log = createLogger('test')
      // 11-digit NANP E.164
      log.info('note', { note: 'call +15551234567 back' })
      expect(lastStdout()?.note).toBe('call [REDACTED:PHONE] back')

      // 12-digit E.164 (previously NOT redacted)
      log.info('note', { note: 'call +155512345678 back' })
      expect(lastStdout()?.note).toBe('call [REDACTED:PHONE] back')

      // 13-digit E.164 (previously NOT redacted)
      log.info('note', { note: 'call +1555123456789 back' })
      expect(lastStdout()?.note).toBe('call [REDACTED:PHONE] back')

      // 11-digit non-NANP E.164, e.g. a UK mobile (previously NOT redacted)
      log.info('note', { note: 'call +447911123456 back' })
      expect(lastStdout()?.note).toBe('call [REDACTED:PHONE] back')
    })

    it('redacts bare unformatted 10-digit phone numbers in non-key-flagged string values', () => {
      const log = createLogger('test')
      log.info('note', { note: 'left a voicemail from 5551234567 today' })
      expect(lastStdout()?.note).toBe('left a voicemail from [REDACTED:PHONE] today')
    })
  })

  describe('correlation IDs', () => {
    it('includes correlationId when bound via withCorrelation', () => {
      const log = createLogger('test')
      withCorrelation({ correlationId: 'corr-123', requestId: 'req-456' }, () => {
        log.info('inside')
      })
      const entry = lastStdout()
      expect(entry?.correlationId).toBe('corr-123')
      expect(entry?.requestId).toBe('req-456')
    })

    it('does not include correlationId outside withCorrelation', () => {
      const log = createLogger('test')
      log.info('outside')
      const entry = lastStdout()
      expect(entry).not.toHaveProperty('correlationId')
      expect(entry).not.toHaveProperty('requestId')
    })

    it('getCorrelation returns empty object outside context', () => {
      expect(getCorrelation()).toEqual({})
    })

    it('getCorrelation returns bound values inside context', () => {
      withCorrelation({ correlationId: 'abc' }, () => {
        expect(getCorrelation()).toEqual({ correlationId: 'abc' })
      })
    })
  })

  describe('rate limiting', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('drops logs after token bucket is exhausted', () => {
      _setLoggerConfigForTests({
        minLevel: 'trace',
        namespaces: ['*'],
        rateLimits: {
          trace: Number.POSITIVE_INFINITY,
          debug: 2,
          info: Number.POSITIVE_INFINITY,
          warn: Number.POSITIVE_INFINITY,
          error: Number.POSITIVE_INFINITY,
          fatal: Number.POSITIVE_INFINITY,
        },
        stripStacks: true,
      })
      const log = createLogger('test')
      log.debug('first')
      log.debug('second')
      log.debug('third')
      expect(stdoutSpy).toHaveBeenCalledTimes(2)
    })

    it('refills tokens after window expires', () => {
      _setLoggerConfigForTests({
        minLevel: 'trace',
        namespaces: ['*'],
        rateLimits: {
          trace: Number.POSITIVE_INFINITY,
          debug: 1,
          info: Number.POSITIVE_INFINITY,
          warn: Number.POSITIVE_INFINITY,
          error: Number.POSITIVE_INFINITY,
          fatal: Number.POSITIVE_INFINITY,
        },
        stripStacks: true,
      })
      const log = createLogger('test')
      log.debug('first')
      log.debug('second')
      vi.advanceTimersByTime(1001)
      log.debug('third')
      expect(stdoutSpy).toHaveBeenCalledTimes(2)
    })
  })

  describe('child logger', () => {
    it('binds context fields', () => {
      const parent = createLogger('test')
      const child = parent.child({ requestId: 'r1' })
      child.info('msg')
      expect(lastStdout()).toMatchObject({ requestId: 'r1', message: 'msg' })
    })

    it('merges child context with log extra', () => {
      const parent = createLogger('test')
      const child = parent.child({ a: 1 })
      child.info('msg', { b: 2 })
      expect(lastStdout()).toMatchObject({ a: 1, b: 2 })
    })

    it('child extra overrides parent context for same keys', () => {
      const parent = createLogger('test')
      const child = parent.child({ a: 1 })
      child.info('msg', { a: 2 })
      expect(lastStdout()).toMatchObject({ a: 2 })
    })
  })

  describe('error/fatal logging', () => {
    it('unwraps Error instance', () => {
      const log = createLogger('test')
      const err = new Error('something broke')
      log.error('failed', err)
      const entry = lastStderr()
      expect(entry?.errName).toBe('Error')
      expect(entry?.errMsg).toBe('something broke')
    })

    it('unwraps Error with extra fields', () => {
      const log = createLogger('test')
      const err = new Error('boom')
      log.error('failed', err, { userId: 'u1' })
      const entry = lastStderr()
      expect(entry?.errName).toBe('Error')
      expect(entry?.userId).toBe('u1')
    })

    it('accepts plain object as extra', () => {
      const log = createLogger('test')
      log.error('failed', { code: 500 })
      const entry = lastStderr()
      expect(entry?.code).toBe(500)
    })

    it('accepts string as error-like value', () => {
      const log = createLogger('test')
      log.error('failed', 'plain string')
      const entry = lastStderr()
      expect(entry?.errName).toBe('Unknown')
      expect(entry?.errMsg).toBe('plain string')
    })

    it('fatal behaves like error', () => {
      const log = createLogger('test')
      log.fatal('critical', new Error('dead'))
      const entry = lastStderr()
      expect(entry?.level).toBe('fatal')
      expect(entry?.errName).toBe('Error')
      expect(entry?.errMsg).toBe('dead')
    })
  })

  describe('redact exported function', () => {
    it('redacts phone numbers in nested objects', () => {
      const result = redact({ contact: { phone: '+15551234567' } })
      expect(result).toEqual({ contact: { phone: '[REDACTED]' } })
    })

    it('preserves non-sensitive primitives', () => {
      expect(redact(42)).toBe(42)
      expect(redact(true)).toBe(true)
      expect(redact(null)).toBe(null)
    })

    it('handles circular references', () => {
      const obj: Record<string, unknown> = { a: 1 }
      obj.self = obj
      const result = redact(obj)
      expect(result).toEqual({ a: 1, self: '[circular]' })
    })
  })

  describe('cleanup', () => {
    it('_clearLoggerOverflowInterval does not throw', () => {
      expect(() => _clearLoggerOverflowInterval()).not.toThrow()
    })
  })
})
