/**
 * Voice CAPTCHA challenge state against real PostgreSQL (#2179).
 *
 * The challenge used to be deleted on the first submission, so the operator's
 * second attempt could never succeed. These tests drive `submitCaptcha` through
 * the migrated `captchas` table: the row survives a retry or a repeat with the
 * same digits, is gone after a terminal outcome, and two webhooks racing on one
 * call cannot both spend the same attempt (the row is locked).
 *
 * Requires postgres at DATABASE_URL; creates and drops its own database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '../../db/schema'

vi.mock('@llamenos/crypto/ffi', async () => await import('../mocks/llamenos-crypto-ffi'))
import { freshHubDb } from './hub-shred-helpers'

const fresh = freshHubDb('captcha_challenge')

beforeAll(fresh.setup, 180_000)
afterAll(fresh.teardown, 60_000)

let n = 0
const newCall = () => `CA-captcha-${++n}-${Math.random().toString(36).slice(2, 8)}`

async function row(callSid: string) {
  const [r] = await fresh.db.select().from(schema.captchas).where(eq(schema.captchas.callSid, callSid))
  return r
}

describe('submitCaptcha', () => {
  it('a wrong first answer keeps the challenge, and the right second answer passes', async () => {
    const callSid = newCall()
    await fresh.settings.storeCaptcha({ callSid, expected: '4821' })

    expect(await fresh.settings.submitCaptcha({ callSid, digits: '1111' })).toEqual({
      outcome: 'retry',
      digitsToSpeak: '4821',
      round: 1,
    })
    expect(await row(callSid)).toMatchObject({ attempts: 1, repeats: 0 })

    expect(await fresh.settings.submitCaptcha({ callSid, digits: '4821' })).toEqual({ outcome: 'pass' })
    expect(await row(callSid)).toBeUndefined()
  })

  it('star re-speaks the same digits without spending an attempt', async () => {
    const callSid = newCall()
    await fresh.settings.storeCaptcha({ callSid, expected: '7390' })

    expect(await fresh.settings.submitCaptcha({ callSid, digits: '*' })).toEqual({
      outcome: 'repeat',
      digitsToSpeak: '7390',
      round: 1,
    })
    expect(await row(callSid)).toMatchObject({ attempts: 0, repeats: 1 })
    expect(await fresh.settings.submitCaptcha({ callSid, digits: '7390' })).toEqual({ outcome: 'pass' })
  })

  it('two wrong answers fail and delete the challenge', async () => {
    const callSid = newCall()
    await fresh.settings.storeCaptcha({ callSid, expected: '5555' })
    await fresh.settings.submitCaptcha({ callSid, digits: '1234' })
    expect(await fresh.settings.submitCaptcha({ callSid, digits: '4321' })).toEqual({ outcome: 'fail' })
    expect(await row(callSid)).toBeUndefined()
  })

  it('no input twice is a timeout', async () => {
    const callSid = newCall()
    await fresh.settings.storeCaptcha({ callSid, expected: '5555' })
    expect((await fresh.settings.submitCaptcha({ callSid, digits: '' })).outcome).toBe('retry')
    expect(await fresh.settings.submitCaptcha({ callSid, digits: '' })).toEqual({ outcome: 'timeout' })
    expect(await row(callSid)).toBeUndefined()
  })

  it('a submission for a call with no challenge fails', async () => {
    expect(await fresh.settings.submitCaptcha({ callSid: newCall(), digits: '1234' })).toEqual({ outcome: 'fail' })
  })

  it('a new challenge for the same call starts from zero attempts', async () => {
    const callSid = newCall()
    await fresh.settings.storeCaptcha({ callSid, expected: '1111' })
    await fresh.settings.submitCaptcha({ callSid, digits: '9999' })
    await fresh.settings.storeCaptcha({ callSid, expected: '2222' })
    expect(await row(callSid)).toMatchObject({ expected: '2222', attempts: 0, repeats: 0 })
  })

  it('two simultaneous wrong answers spend both attempts — never the same one twice', async () => {
    const callSid = newCall()
    await fresh.settings.storeCaptcha({ callSid, expected: '8080' })
    const outcomes = (await Promise.all([
      fresh.settings.submitCaptcha({ callSid, digits: '1111' }),
      fresh.settings.submitCaptcha({ callSid, digits: '2222' }),
    ])).map((r) => r.outcome).sort()
    expect(outcomes).toEqual(['fail', 'retry'])
  })
})
