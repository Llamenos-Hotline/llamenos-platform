/**
 * #2447: a service that is handed something that is not a Drizzle database must
 * fail where it is constructed, naming what was missing — not as
 * `this.db.select is not a function` from inside a subscriber's STOP.
 */
import { describe, expect, it } from 'vitest'
import { assertDatabase } from '@worker/lib/assert-database'
import { SignalIdentityService } from '@worker/messaging/signal/identity'
import type { Database } from '@worker/db'

const fakeDb = { select: () => ({}), insert: () => ({}), update: () => ({}), delete: () => ({}) } as unknown as Database

describe('assertDatabase', () => {
  it('returns a value that carries the query builders', () => {
    expect(assertDatabase(fakeDb, 'Owner')).toBe(fakeDb)
  })

  it('rejects an empty object, naming the owner and the missing methods', () => {
    expect(() => assertDatabase({} as Database, 'Owner')).toThrow(
      /Owner requires a Drizzle database.*no select\(\), insert\(\), update\(\), delete\(\)/,
    )
  })

  it('rejects null and undefined', () => {
    expect(() => assertDatabase(undefined, 'Owner')).toThrow(/Owner requires a Drizzle database, but received undefined/)
    expect(() => assertDatabase(null, 'Owner')).toThrow(/received null/)
  })
})

describe('SignalIdentityService construction', () => {
  it('fails at construction for a non-Drizzle db', () => {
    expect(() => new SignalIdentityService({} as Database)).toThrow(/SignalIdentityService requires a Drizzle database/)
  })

  it('accepts a real-shaped db', () => {
    expect(() => new SignalIdentityService(fakeDb)).not.toThrow()
  })
})
