/**
 * #1633 — hold the bytes iOS actually sends to the real input schemas.
 *
 * `APIService` (apps/ios/Sources/Services/APIService.swift) used to set
 * `.convertToSnakeCase` on the `JSONEncoder` shared by every `body:` request. That
 * strategy rewrites a type's own `CodingKeys` and a `Dictionary`'s keys, so the
 * generated `UpdateContactBody.hubID = "hubId"` went out as `hub_id` and
 * `encryptedPII` as `encrypted_pii`.
 *
 * No input schema under `packages/protocol/schemas/` declares a snake_case field, and
 * none is `strict()`, so an unrecognised key is *ignored* rather than rejected:
 *
 *   - a REQUIRED field then reads as missing  → the route 400s (loud)
 *   - an OPTIONAL field is silently discarded → the write succeeds having lost it
 *
 * The second is the dangerous one, and it hit the all-optional `.partial()` update
 * bodies hardest: `PATCH /api/contacts-v2/:id` and `PATCH /api/records/:id` validated
 * as `{}`, wrote nothing, and returned 200.
 *
 * Nothing caught it because every iOS test asserted against the Swift objects, and —
 * per #1584 — iOS is not even compiled on a pull request. So this test runs on the
 * backend unit tier, where it does run on every PR, and it reads its input from
 * `apps/ios/Tests/Wire/ios-request-bodies.json`: bytes produced by the real iOS
 * encoder and pinned there by `APIServiceWireFormatTests`. The fixture is the only
 * artefact between the two suites, so neither can drift from the other or from the
 * contract.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ZodType } from 'zod'

import * as notes from '@protocol/schemas/notes'
import * as conversations from '@protocol/schemas/conversations'
import * as contactsV2 from '@protocol/schemas/contacts-v2'
import * as reports from '@protocol/schemas/reports'
import * as records from '@protocol/schemas/records'
import * as recoveryGroup from '@protocol/schemas/recovery-group'

const MODULES: Record<string, Record<string, unknown>> = {
  '@protocol/schemas/notes': notes,
  '@protocol/schemas/conversations': conversations,
  '@protocol/schemas/contacts-v2': contactsV2,
  '@protocol/schemas/reports': reports,
  '@protocol/schemas/records': records,
  '@protocol/schemas/recovery-group': recoveryGroup,
}

const FIXTURE = join(__dirname, '../../../../apps/ios/Tests/Wire/ios-request-bodies.json')

interface WireCase {
  id: string
  method: string
  path: string
  module: string
  schema: string
  swiftType: string
  callSite: string
  /** Keys that are `.optional()` in the schema — the ones a drop cannot be seen through. */
  optionalKeys: string[]
}

interface Fixture {
  cases: WireCase[]
  bodies: Record<string, { wire: Record<string, unknown>; legacySnakeCase: Record<string, unknown> }>
}

const fixture: Fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))

function schemaFor(c: WireCase): ZodType {
  const mod = MODULES[c.module]
  expect(mod, `fixture names an unmapped module: ${c.module}`).toBeDefined()
  const schema = mod[c.schema]
  expect(schema, `${c.module} does not export ${c.schema}`).toBeDefined()
  return schema as ZodType
}

const multiWord = (key: string) => /[a-z][A-Z]/.test(key)

describe('#1633 iOS request bodies against the real input schemas', () => {
  it('the fixture covers every case it declares', () => {
    expect(fixture.cases.length).toBeGreaterThan(0)
    for (const c of fixture.cases) {
      expect(fixture.bodies[c.id], `no body recorded for case ${c.id}`).toBeDefined()
    }
    expect(Object.keys(fixture.bodies).sort()).toEqual(fixture.cases.map(c => c.id).sort())
  })

  it.each(fixture.cases.map(c => [c.id, c] as const))(
    'every case is actually at risk: %s carries a multi-word key',
    (_id, c) => {
      // A body of only single-word keys would pass either way and prove nothing.
      const keys = Object.keys(fixture.bodies[c.id].wire)
      expect(keys.some(multiWord), `${c.id} has no multi-word key: ${keys.join(', ')}`).toBe(true)
    },
  )

  describe('what iOS sends today validates with every key intact', () => {
    it.each(fixture.cases.map(c => [c.id, c] as const))('%s', (_id, c) => {
      const body = fixture.bodies[c.id].wire
      const result = schemaFor(c).safeParse(body)
      expect(
        result.success ? null : result.error.issues,
        `${c.schema} rejected what ${c.swiftType} sends (${c.method} ${c.path})`,
      ).toBeNull()

      // Validating is not enough — a non-strict schema validates while discarding.
      // Assert the keys SURVIVED into the parsed output, which is what the route reads.
      const parsed = (result as { data: Record<string, unknown> }).data
      for (const key of Object.keys(body)) {
        expect(parsed, `${c.schema} dropped ${key} from ${c.swiftType}`).toHaveProperty(key)
      }
    })
  })

  describe('the historic snake_case bytes: 400 when required, silently dropped when optional', () => {
    it.each(fixture.cases.map(c => [c.id, c] as const))('%s', (_id, c) => {
      const legacy = fixture.bodies[c.id].legacySnakeCase
      const wire = fixture.bodies[c.id].wire
      const result = schemaFor(c).safeParse(legacy)

      const required = Object.keys(wire).filter(k => multiWord(k) && !c.optionalKeys.includes(k))

      if (required.length > 0) {
        // At least one REQUIRED multi-word key was mangled, so this body 400s. Loud.
        expect(
          result.success,
          `${c.schema} accepted a body missing required ${required.join(', ')} — expected a 400`,
        ).toBe(false)
        return
      }

      // Every mangled key is optional: the validator accepts the body and the route
      // proceeds. This is the silent path.
      expect(
        result.success ? null : (result as { error: { issues: unknown } }).error.issues,
        `${c.schema} rejected the all-optional snake_case body; it should have accepted it`,
      ).toBeNull()

      const parsed = (result as { data: Record<string, unknown> }).data
      for (const key of Object.keys(wire).filter(multiWord)) {
        expect(
          parsed[key],
          `${c.schema} kept ${key} from the snake_case body — the silent-drop premise is wrong`,
        ).toBeUndefined()
      }
    })
  })

  it('PATCH /api/contacts-v2/:id lost the ciphertext and the HPKE envelopes, and still validated', () => {
    // The headline data-loss case, asserted on its own rather than only in the sweep:
    // a volunteer edits a contact, iOS reports success, nothing is written.
    const { wire, legacySnakeCase } = fixture.bodies.updateContact
    for (const key of ['encryptedSummary', 'summaryEnvelopes', 'encryptedPII', 'piiEnvelopes']) {
      expect(wire).toHaveProperty(key)
    }

    const result = contactsV2.updateContactBodySchema.safeParse(legacySnakeCase)
    expect(result.success).toBe(true)
    // Not "some fields missing" — the body the route receives is empty.
    expect(Object.keys((result as { data: Record<string, unknown> }).data)).toEqual([])
  })

  it('PATCH /api/records/:id did not just lose the status change — it unassigned the case and wiped its blind indexes', () => {
    // The worst of the set, because two fields of updateRecordBodySchema carry
    // `.optional().default()`:
    //
    //   assignedTo:    z.array(z.string()).optional().default([])
    //   blindIndexes:  z.record(...).optional().default({})
    //
    // With statusHash and severityHash mangled into status_hash / severity_hash, the
    // validator sees an empty body — and then SUPPLIES those two defaults. So the body
    // that reaches the route is not `{}`: it is `{assignedTo: [], blindIndexes: {}}`.
    //
    // apps/worker/services/cases.ts:205-206 writes any key that is `!== undefined`:
    //   if (input.assignedTo !== undefined)   values.assignedTo = input.assignedTo
    //   if (input.blindIndexes !== undefined) values.blindIndexes = input.blindIndexes
    //
    // so a status change from iOS cleared the case's assignees and destroyed every
    // blind index on it. The blind indexes are HMACs the client derives from plaintext
    // the server never holds, so the server cannot rebuild them: the case stops being
    // findable by any encrypted-field search. Meanwhile the status did not change, no
    // status_change interaction was written (cases.ts:217 is gated on input.statusHash),
    // a `recordUpdated` audit entry was recorded, a `record:updated` event was
    // published, and iOS reported success.
    const result = records.updateRecordBodySchema.safeParse(fixture.bodies.updateRecord.legacySnakeCase)
    expect(result.success).toBe(true)
    const parsed = (result as { data: Record<string, unknown> }).data

    // The change the user asked for is gone...
    expect(parsed.statusHash).toBeUndefined()
    expect(parsed.severityHash).toBeUndefined()
    // ...and two destructive values the user never sent are present.
    expect(parsed.assignedTo).toEqual([])
    expect(parsed.blindIndexes).toEqual({})

    // What iOS sends now carries the status change and supplies no such defaults
    // beyond them, so nothing is cleared.
    const fixed = records.updateRecordBodySchema.safeParse(fixture.bodies.updateRecord.wire)
    expect(fixed.success).toBe(true)
    const fixedData = (fixed as { data: Record<string, unknown> }).data
    expect(fixedData.statusHash).toBe('aa11')
    expect(fixedData.severityHash).toBe('bb22')
  })

  it('a nested record key was NOT rewritten, so blind indexes survived — measured, not assumed', () => {
    // Worth stating because the obvious guess is wrong, and the wrong guess would have
    // made this bug sound worse than it is. `keyEncodingStrategy` rewrites a type's own
    // CodingKeys and the keys of a top-level Dictionary body, but NOT the keys of a
    // nested Dictionary. `blindIndexes` is a z.record of caller-chosen keys, so a
    // rewrite there could not have been discarded as an unknown field — it would have
    // been accepted under the wrong name and quietly broken every encrypted-field
    // search. It did not happen: the container key was mangled, its contents were not.
    const legacy = fixture.bodies.updateContact.legacySnakeCase as {
      blind_indexes: Record<string, unknown>
    }
    expect(Object.keys(legacy)).toContain('blind_indexes')
    expect(Object.keys(legacy.blind_indexes)).toEqual(['nameToken'])

    // So the loss is a plain unknown-key drop, which `updateContactBodySchema` ignores.
    const parsed = contactsV2.updateContactBodySchema.safeParse(legacy)
    expect(parsed.success).toBe(true)
    expect((parsed as { data: Record<string, unknown> }).data.blindIndexes).toBeUndefined()
  })

  it('a top-level Dictionary body WAS rewritten, because AnyEncodable erases the type', () => {
    // `request(body:)` wraps every body in `AnyEncodable`, so Foundation cannot see
    // that the body is a Dictionary and applies the strategy to its keys — where
    // `encoder.encode(someDictionary)` directly would have skipped them. That is why
    // the untyped `[String: String]` bodies were affected too, and why collapsing
    // `AnyEncodable` away would silently change wire behaviour.
    const { wire, legacySnakeCase } = fixture.bodies.storeUserRecoveryEnvelope
    expect(Object.keys(wire).sort()).toEqual(['envelope', 'hubId'])
    expect(Object.keys(legacySnakeCase).sort()).toEqual(['envelope', 'hub_id'])

    // `hubId` is required, so storing a user's wrapped PUK recovery envelope 400'd.
    expect(recoveryGroup.userRecoveryEnvelopeSchema.safeParse(legacySnakeCase).success).toBe(false)
    expect(recoveryGroup.userRecoveryEnvelopeSchema.safeParse(wire).success).toBe(true)
  })

  it('no input schema declares a snake_case field, so no call site ever wanted the conversion', () => {
    // The premise of the whole fix. If this ever fails, some endpoint has grown a
    // snake_case body and needs its own encoder at its own call site — the way
    // POST /api/security-events does — not a strategy on the shared one.
    const snakeKeys: string[] = []
    for (const [name, mod] of Object.entries(MODULES)) {
      for (const [exportName, value] of Object.entries(mod)) {
        if (!exportName.endsWith('BodySchema') && !exportName.endsWith('Schema')) continue
        const shape = (value as { shape?: Record<string, unknown> })?.shape
        if (!shape) continue
        for (const key of Object.keys(shape)) {
          if (key.includes('_')) snakeKeys.push(`${name}:${exportName}.${key}`)
        }
      }
    }
    expect(snakeKeys).toEqual([])
  })
})
