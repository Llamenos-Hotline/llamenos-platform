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
import * as devices from '@protocol/schemas/devices'

const MODULES: Record<string, Record<string, unknown>> = {
  '@protocol/schemas/notes': notes,
  '@protocol/schemas/conversations': conversations,
  '@protocol/schemas/contacts-v2': contactsV2,
  '@protocol/schemas/reports': reports,
  '@protocol/schemas/records': records,
  '@protocol/schemas/recovery-group': recoveryGroup,
  '@protocol/schemas/devices': devices,
}

const FIXTURE = join(__dirname, '../../../../apps/ios/Tests/Wire/ios-request-bodies.json')
const RESPONSE_FIXTURE = join(__dirname, '../../../../apps/ios/Tests/Wire/ios-response-bodies.json')

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
  /**
   * Keys iOS sends that the schema does not declare at all, so they are stripped
   * even in their correct camelCase form. Not an exclusion for convenience: the
   * suite asserts separately that each of these really is absent from the schema
   * shape AND really is sent, so it cannot be used to wave away a genuine drop.
   */
  unmodelledKeys?: string[]
}

interface Fixture {
  cases: WireCase[]
  bodies: Record<string, { wire: Record<string, unknown>; legacySnakeCase: Record<string, unknown> }>
}

interface ResponseCase {
  id: string
  endpoint: string
  module: string
  schema: string
  swiftType: string
  swiftFile: string
  /** Keys the Swift model declares non-optional — a missing one is `keyNotFound`. */
  requiredSwiftKeys: string[]
  /** Keys the model used to require/read that the server never sends. */
  absentFromServer: string[]
}

interface ResponseFixture {
  cases: ResponseCase[]
  responses: Record<string, Record<string, unknown>>
}

const fixture: Fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))
const responseFixture: ResponseFixture = JSON.parse(readFileSync(RESPONSE_FIXTURE, 'utf8'))

function schemaFor(c: WireCase): ZodType {
  const mod = MODULES[c.module]
  expect(mod, `fixture names an unmapped module: ${c.module}`).toBeDefined()
  const schema = mod[c.schema]
  expect(schema, `${c.module} does not export ${c.schema}`).toBeDefined()
  return schema as ZodType
}

/**
 * The keys a schema declares. Module scope so the request-body and response-model
 * suites share one definition — `registerDeviceBodySchema` is `.refine()`d twice and
 * still exposes `.shape`, which is what lets the request side assert a key the
 * contract does not model.
 */
function shapeKeys(schema: ZodType): string[] {
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape
  expect(shape, 'expected a z.object schema with an inspectable shape').toBeDefined()
  return Object.keys(shape as Record<string, unknown>)
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
      const unmodelled = c.unmodelledKeys ?? []
      for (const key of Object.keys(body).filter(k => !unmodelled.includes(k))) {
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

  describe('a key declared unmodelled really is absent from the contract, and really is sent', () => {
    // The escape hatch above is only sound if both halves hold. If a key were merely
    // misspelled in the fixture, or had since been added to the schema, this fails
    // rather than letting the survival sweep quietly skip a real drop.
    const withUnmodelled = fixture.cases.filter(c => (c.unmodelledKeys ?? []).length > 0)

    it('at least one case exercises the hatch', () => {
      expect(withUnmodelled.length).toBeGreaterThan(0)
    })

    it.each(withUnmodelled.map(c => [c.id, c] as const))('%s', (_id, c) => {
      const declared = shapeKeys(schemaFor(c))
      const sent = Object.keys(fixture.bodies[c.id].wire)
      for (const key of c.unmodelledKeys ?? []) {
        expect(sent, `${c.id} declares ${key} unmodelled but does not send it`).toContain(key)
        expect(
          declared,
          `${c.schema} now declares ${key} — drop it from unmodelledKeys so the sweep covers it`,
        ).not.toContain(key)
      }
    })
  })

  it('POST /api/devices/register discards the device id iOS generates and stores', () => {
    // Found by adding this endpoint to the suite, not by reading the schema.
    //
    // `WakeKeyService.registerDevice` mints a UUID, persists it to the Keychain under
    // `KeychainKey.deviceID` and sends it as `deviceId`. `registerDeviceBodySchema`
    // does not declare the field, so it is stripped — in the correct camelCase form,
    // not only in the historic snake_case one. The server therefore never learns the
    // identifier the device believes identifies it, and nothing on the client observes
    // that, because the route answers 204.
    //
    // Separate from #1633: fixing the key casing does NOT fix this. Filed as #1716
    // rather than changed here — whether the contract should carry `deviceId` or the
    // client should stop sending it is a protocol decision, and packages/protocol is
    // shared-owned.
    const { wire } = fixture.bodies.registerDevice
    expect(wire).toHaveProperty('deviceId')

    const declared = shapeKeys(devices.registerDeviceBodySchema as unknown as ZodType)
    expect(declared).not.toContain('deviceId')

    const parsed = devices.registerDeviceBodySchema.safeParse(wire)
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data).not.toHaveProperty('deviceId')
  })

  it('POST /api/devices/register 400s on the historic bytes because its refines read the dropped keys', () => {
    // The one case in this suite whose breakage was observed end to end against a live
    // server: the real client sent the snake_case form on every launch and the server
    // answered 400 "Provide pushToken (to register for push) or x25519Pubkey (to
    // register this device as an HPKE recipient)" — both refines reading keys that were
    // no longer present. `devices` had 0 rows; after the fix the same client gets 204
    // and a row persists.
    //
    // Note which mechanism makes this loud: `pushToken` and `wakeKeyPublic` are
    // `.optional()` on the object, so the field modifiers alone would put this in the
    // silent-drop column. The `.refine()`s are what turn it into a 400.
    const { legacySnakeCase } = fixture.bodies.registerDevice
    const legacy = devices.registerDeviceBodySchema.safeParse(legacySnakeCase)
    expect(legacy.success).toBe(false)
    expect(
      legacy.success ? '' : JSON.stringify(legacy.error.issues),
      'expected the refine that names pushToken / x25519Pubkey',
    ).toContain('x25519Pubkey')
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

describe('#1633 iOS response models against the real response schemas', () => {
  // The request fixture only ever proved what iOS *sends*. Renaming a request key to
  // match its schema says nothing about the response model on the same endpoint, and
  // that is precisely where this PR first regressed: `POST /api/conversations/:id/messages`
  // got its request key fixed while `ConversationMessage` still required
  // `recipientEnvelopes`. Worse than before, because the mismatch only became
  // *reachable* once the send stopped 400ing.

  function schemaFor(c: ResponseCase): ZodType {
    const mod = MODULES[c.module]
    expect(mod, `fixture names an unmapped module: ${c.module}`).toBeDefined()
    const schema = mod[c.schema]
    expect(schema, `${c.module} does not export ${c.schema}`).toBeDefined()
    return schema as ZodType
  }

  it('the response fixture covers every case it declares', () => {
    expect(responseFixture.cases.length).toBeGreaterThan(0)
    expect(Object.keys(responseFixture.responses).sort())
      .toEqual(responseFixture.cases.map(c => c.id).sort())
  })

  /// Keys whose value is JSON `null`. The server sends these for every nullable
  /// column (drizzle serialises a NULL to `null`, not to an absent key), but the
  /// response schemas declare them `.optional()` — which in Zod means "may be
  /// undefined", NOT "may be null". So the schemas do not currently describe their
  /// own wire format for nullable columns. See the explicit test below: that is a
  /// defect in packages/protocol/schemas/ (shared-owned, not changed here), and it
  /// is stripped — never ignored — so this suite can still validate the rest.
  function nullKeys(payload: Record<string, unknown>): string[] {
    return Object.keys(payload).filter(k => payload[k] === null)
  }

  function withoutNulls(payload: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== null))
  }

  describe('the fixture is a payload the server could really send', () => {
    it.each(responseFixture.cases.map(c => [c.id, c] as const))('%s', (_id, c) => {
      const payload = responseFixture.responses[c.id]
      const result = schemaFor(c).safeParse(withoutNulls(payload))
      expect(
        result.success ? null : result.error.issues,
        `${c.schema} rejected the fixture for ${c.swiftType} (${c.endpoint}) — the fixture is not a real server payload`,
      ).toBeNull()
    })
  })

  it('records the nullable-column gap: the server sends null where the schema says optional', () => {
    // Not a workaround — a pinned, named defect. `messages.read_at` and
    // `messages.failure_reason` are nullable columns returned verbatim, so the 201
    // carries `"readAt": null`. `messageResponseSchema` declares `readAt:
    // z.string().optional()`, which rejects null. Either the schema should be
    // `.nullish()` or the route should omit null keys; both live in shared-owned
    // code, so this test states the gap rather than papering over it. iOS is
    // unaffected — `String?` decodes a JSON null to nil — which is why this is a
    // contract-accuracy bug and not a client crash.
    const message = responseFixture.responses.message
    expect(nullKeys(message).sort()).toEqual(['failureReason', 'readAt'])

    const shape = (conversations.messageResponseSchema as unknown as {
      shape: Record<string, ZodType>
    }).shape
    for (const key of ['readAt', 'failureReason']) {
      const field = (shape as unknown as Record<string, ZodType>)[key]
      expect(field, `${key} should be declared by messageResponseSchema`).toBeDefined()
      // Declared, accepts undefined, and (the gap) rejects null.
      expect(field.safeParse(undefined).success).toBe(true)
      expect(field.safeParse(null).success).toBe(false)
    }
  })

  describe('every key the Swift model REQUIRES is one the schema declares', () => {
    // This is the gate. A non-optional Swift field whose key the server never sends is
    // `keyNotFound` at decode time — the whole response is lost, not just the field.
    it.each(responseFixture.cases.map(c => [c.id, c] as const))('%s', (_id, c) => {
      const declared = shapeKeys(schemaFor(c))
      const missing = c.requiredSwiftKeys.filter(k => !declared.includes(k))
      expect(
        missing,
        `${c.swiftType} (${c.swiftFile}) requires ${missing.join(', ')}, which ${c.schema} does not declare — decoding ${c.endpoint} would throw keyNotFound`,
      ).toEqual([])

      // and present in the concrete payload, so the Swift decode test is exercised
      const payload = responseFixture.responses[c.id]
      for (const key of c.requiredSwiftKeys) {
        expect(payload, `fixture for ${c.id} omits required key ${key}`).toHaveProperty(key)
      }
    })
  })

  describe('the keys these models used to want are confirmed absent from the contract', () => {
    it.each(responseFixture.cases.map(c => [c.id, c] as const))('%s', (_id, c) => {
      const declared = shapeKeys(schemaFor(c))
      for (const key of c.absentFromServer) {
        expect(
          declared,
          `${c.schema} declares ${key} after all — then ${c.swiftType} may have been right and this fix needs revisiting`,
        ).not.toContain(key)
        expect(responseFixture.responses[c.id]).not.toHaveProperty(key)
      }
    })
  })

  it('a message row carries readerEnvelopes and has no channel of its own', () => {
    const declared = shapeKeys(conversations.messageResponseSchema as unknown as ZodType)
    expect(declared).toContain('readerEnvelopes')
    expect(declared).not.toContain('recipientEnvelopes')
    // The channel belongs to the conversation, not the message — which is why
    // ConversationMessage.channelType could never have decoded.
    expect(declared).not.toContain('channelType')
    expect(shapeKeys(conversations.conversationResponseSchema as unknown as ZodType))
      .toContain('channelType')
  })

  it('the send body and the response it returns agree on the envelope key', () => {
    // The actual lesson of the regression, asserted directly: one endpoint, one name.
    const body = shapeKeys(conversations.sendMessageBodySchema as unknown as ZodType)
    const response = shapeKeys(conversations.messageResponseSchema as unknown as ZodType)
    expect(body).toContain('readerEnvelopes')
    expect(response).toContain('readerEnvelopes')
  })
})
