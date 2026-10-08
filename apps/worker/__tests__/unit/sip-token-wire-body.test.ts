/**
 * #1659 — hold the bytes `/api/telephony/sip-token` really returns to the real response
 * schema, and hold the iOS model to that schema.
 *
 * iOS declared `SipTokenResponse` as five FLAT, REQUIRED fields while the server has
 * always returned four of them NESTED under `sip` plus a fifth (`expiry`) it has never
 * sent at all. So `APIService.getSipToken` threw `keyNotFound` on every response the
 * server could produce, `ShiftsViewModel.onShiftStarted` never ran, and in-app SIP
 * registration could not work on any build.
 *
 * Nothing caught it because the iOS tests CONSTRUCTED the model in Swift
 * (`SipTokenResponse(username:domain:password:transport:expiry:)`) and passed it in —
 * exercising the registration logic perfectly while saying nothing about whether the
 * server's bytes can produce that value. Compounded by #1584: iOS is not compiled on a
 * pull request, let alone decode-tested.
 *
 * So this runs on the backend unit tier, where it DOES run on every PR, and reads
 * `apps/ios/Tests/Wire/sip-token-response.json` — payloads produced by calling
 * `buildVolunteerSipParams` itself. `apps/ios/Tests/Unit/SipTokenResponseDecodingTests.swift`
 * decodes those same bytes through the real iOS decoder. The fixture is the only artefact
 * between the two suites.
 *
 * Same mechanism as `ios-wire-bodies.test.ts` (#1633/PR #1642), with one extension this
 * endpoint needs: `requiredSwiftKeys` are DOTTED PATHS, because a flat key list cannot
 * describe a nested response.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ZodType } from 'zod'
import { describe, expect, it } from 'vitest'

import * as webrtc from '@protocol/schemas/webrtc'
import {
  buildVolunteerSipParams,
  mintTurnCredentials,
  volunteerSipUsername,
} from '@worker/telephony/registrar'
import type { TelephonyProviderConfig } from '@shared/types'

const MODULES: Record<string, Record<string, unknown>> = {
  '@protocol/schemas/webrtc': webrtc,
}

const FIXTURE = join(__dirname, '../../../../apps/ios/Tests/Wire/sip-token-response.json')

/**
 * The identity and the TURN credential the fixture pins, both built from a FIXED byte
 * pattern through the registrar's own encoders rather than written out as literals.
 *
 * This is not cosmetic. `gitleaks` is a required check and the only thing standing
 * between a real credential and this repository, so it must stay sensitive to anything
 * secret-shaped — and a base64 HMAC-SHA1 digest is, by construction, indistinguishable
 * from a live coturn credential (4.28 bits/char over 28 characters; its
 * `generic-api-key` rule fires at 3.5). The answer is to pin a value with nothing to
 * match, not to teach the scanner an exception: a `.gitleaksignore` fingerprint is
 * `commit:file:rule:line` and stops matching on the next rebase, at which point it has
 * silently stopped protecting too.
 *
 * So the fixture carries the SHAPE each consumer actually reads — `buildVolunteerSipParams`
 * copies the credential through verbatim and the Swift decoder treats it as an opaque
 * String — and the HMAC itself stays pinned byte-exactly on `mintTurnCredentials` in
 * `sip-registrar.test.ts`, which is where a digest vector belongs.
 */
const SHA1_DIGEST_BYTES = 20

/** An HMAC-SHA1 digest's length, alphabet and padding, with zero entropy. */
const FIXTURE_TURN_CREDENTIAL = Buffer.alloc(SHA1_DIGEST_BYTES).toString('base64')

/** `vol_` + 16 hex characters, the real derivation, from a repeated-byte pubkey. */
const FIXTURE_SIP_USERNAME = volunteerSipUsername('ab'.repeat(32))

/** Shannon entropy in bits per character — the quantity gitleaks thresholds on. */
function shannonEntropy(value: string): number {
  const counts = new Map<string, number>()
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let bits = 0
  for (const n of counts.values()) {
    const p = n / value.length
    bits -= p * Math.log2(p)
  }
  return bits
}

/**
 * gitleaks' `generic-api-key` threshold. Keys whose NAME contains one of its keywords
 * are the ones it will look at, so those are the values held below it.
 */
const GENERIC_API_KEY_ENTROPY = 3.5
const SCANNER_KEYWORDS = ['credential', 'password', 'secret', 'token', 'key', 'auth', 'api']

interface ResponseCase {
  id: string
  endpoint: string
  module: string
  schema: string
  swiftType: string
  swiftFile: string
  /** Dotted paths the Swift model declares non-optional — a missing one is `keyNotFound`. */
  requiredSwiftKeys: string[]
  /** Dotted paths the model tolerates being absent. */
  optionalSwiftKeys: string[]
  /** Keys the model used to require, or the schema used to declare, that the server never sends. */
  absentFromServer: string[]
}

interface Fixture {
  cases: ResponseCase[]
  responses: Record<string, Record<string, unknown>>
}

const fixture: Fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))

function schemaFor(c: ResponseCase): ZodType {
  const mod = MODULES[c.module]
  expect(mod, `fixture names an unmapped module: ${c.module}`).toBeDefined()
  const schema = mod[c.schema]
  expect(schema, `${c.module} does not export ${c.schema}`).toBeDefined()
  return schema as ZodType
}

/** The keys a z.object declares, at a dotted path into nested objects. */
function declaresPath(schema: ZodType, path: string): boolean {
  let node: unknown = schema
  for (const segment of path.split('.')) {
    const shape = (node as { shape?: Record<string, unknown> })?.shape
    if (!shape || !(segment in shape)) return false
    node = shape[segment]
  }
  return true
}

/** Whether a payload carries a value at a dotted path. */
function hasPath(payload: Record<string, unknown>, path: string): boolean {
  let node: unknown = payload
  for (const segment of path.split('.')) {
    if (typeof node !== 'object' || node === null || !(segment in node)) return false
    node = (node as Record<string, unknown>)[segment]
  }
  return node !== undefined
}

const cases = fixture.cases.map(c => [c.id, c] as const)

describe('#1659 /api/telephony/sip-token: the fixture is a payload the server really sends', () => {
  it('covers every case it declares', () => {
    expect(fixture.cases.length).toBeGreaterThan(0)
    expect(Object.keys(fixture.responses).sort()).toEqual(fixture.cases.map(c => c.id).sort())
  })

  it.each(cases)('%s validates against the response schema', (_id, c) => {
    const result = schemaFor(c).safeParse(fixture.responses[c.id])
    expect(
      result.success ? null : result.error.issues,
      `${c.schema} rejected the fixture for ${c.swiftType} (${c.endpoint}) — it is not a real server payload`,
    ).toBeNull()
  })

  it('the fixture IS the builder output, regenerated here rather than trusted', () => {
    // The fixture would be worth nothing if it were a transcription of what somebody
    // believed the server sends. Rebuild both payloads from buildVolunteerSipParams and
    // compare: a change to the builder that the fixture does not follow fails here, and
    // then the Swift decode test is testing a shape the server stopped sending.
    const config = { type: 'asterisk', sipDomain: 'sip.hotline.example.org' } as TelephonyProviderConfig
    const username = FIXTURE_SIP_USERNAME
    const password = 'JmsSipSecretBase64Url-0000000000000000000000'
    const anchor = fixture.responses.sipTokenWithTurn.sip as { tlsTrustAnchorPem: string }

    // The clock is pinned, so everything `mintTurnCredentials` computes from the identity
    // is reproducible and asserted here rather than taken on trust.
    const minted = mintTurnCredentials('turn-static-auth-secret', username, 3600, 1_767_225_600)
    expect(minted.expiresAt).toBe(1_767_229_200)
    expect(minted.username).toBe(`1767229200:${username}`)
    expect(Buffer.from(minted.credential, 'base64')).toHaveLength(SHA1_DIGEST_BYTES)

    const withTurn = buildVolunteerSipParams(
      config,
      username,
      password,
      {
        host: 'turn.hotline.example.org',
        // The digest is the one field substituted — see FIXTURE_TURN_CREDENTIAL. Every
        // other byte of this payload is the builder's own output.
        credentials: { ...minted, credential: FIXTURE_TURN_CREDENTIAL },
      },
      anchor.tlsTrustAnchorPem,
    )
    expect(withTurn).toEqual(fixture.responses.sipTokenWithTurn)

    const stunOnly = buildVolunteerSipParams(config, username, password, undefined, undefined)
    expect(stunOnly).toEqual(fixture.responses.sipTokenStunOnly)
  })

  it('carries nothing a secret scanner cannot tell from live key material', () => {
    // The guard for the defect this fixture actually shipped: a real minted credential
    // (and a 16-hex-character identity, read right after the word `token` in the Swift
    // test) tripped `gitleaks`' generic-api-key rule, and `gitleaks` is required. Held by
    // a test rather than an allowlist entry, so it keeps holding across rebases and
    // across whoever regenerates the fixture next.
    const relays = (fixture.responses.sipTokenWithTurn.sip as {
      iceServers: Array<{ url: string; credential?: string }>
    }).iceServers.filter(s => s.url.startsWith('turn:'))
    expect(relays).toHaveLength(2)
    for (const relay of relays) expect(relay.credential).toBe(FIXTURE_TURN_CREDENTIAL)

    // And the general case, over every string the fixture publishes under a key the
    // scanner's keyword list would make it look at.
    const offenders: string[] = []
    const walk = (node: unknown, path: string): void => {
      if (typeof node === 'string') {
        const leaf = path.split('.').pop() ?? ''
        const watched = SCANNER_KEYWORDS.some(k => leaf.toLowerCase().includes(k))
        if (watched && shannonEntropy(node) >= GENERIC_API_KEY_ENTROPY) {
          offenders.push(`${path} (${shannonEntropy(node).toFixed(2)} bits/char)`)
        }
        return
      }
      if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`))
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k)
      }
    }
    walk(fixture.responses, '')
    expect(
      offenders,
      `secret-shaped values in the fixture: ${offenders.join(', ')} — build them from a fixed byte pattern through the production encoder instead`,
    ).toEqual([])
  })
})

describe('#1659 every key the Swift model REQUIRES is one the schema declares', () => {
  // This is the gate, and the assertion that catches this whole class. A non-optional
  // Swift field whose key the server never sends is `keyNotFound` at decode time — the
  // WHOLE response is lost, not just the field.
  it.each(cases)('%s', (_id, c) => {
    const schema = schemaFor(c)
    const missing = c.requiredSwiftKeys.filter(k => !declaresPath(schema, k))
    expect(
      missing,
      `${c.swiftType} (${c.swiftFile}) requires ${missing.join(', ')}, which ${c.schema} does not declare — decoding ${c.endpoint} would throw keyNotFound`,
    ).toEqual([])

    // Declared is not enough: it must be in the concrete payload, so the Swift decode
    // test actually exercises it.
    for (const key of c.requiredSwiftKeys) {
      expect(hasPath(fixture.responses[c.id], key), `fixture for ${c.id} omits required key ${key}`).toBe(true)
    }
  })

  it.each(cases)('%s — the keys declared optional are declared by the schema too', (_id, c) => {
    // An optional Swift field whose key the schema does not declare is dead code reading
    // nil forever, which is the silent half of the same defect (#1633's `contactHash`).
    const schema = schemaFor(c)
    expect(c.optionalSwiftKeys.filter(k => !declaresPath(schema, k))).toEqual([])
  })

  it.each(cases)('%s — the keys the old model wanted are confirmed absent', (_id, c) => {
    const schema = schemaFor(c)
    for (const key of c.absentFromServer) {
      expect(
        declaresPath(schema, key),
        `${c.schema} declares top-level ${key} after all — then the old SipTokenResponse may have been right and this fix needs revisiting`,
      ).toBe(false)
      expect(hasPath(fixture.responses[c.id], key)).toBe(false)
    }
  })
})

describe('#1659 the specific disagreements, named', () => {
  it('every field the old iOS model required flat is nested under sip, and expiry does not exist', () => {
    // The five fields of the pre-fix `struct SipTokenResponse`, one by one.
    for (const key of ['username', 'domain', 'password', 'transport']) {
      expect(declaresPath(webrtc.sipTokenResponseSchema, key), `${key} should NOT be top-level`).toBe(false)
      expect(declaresPath(webrtc.sipTokenResponseSchema, `sip.${key}`), `sip.${key} should be declared`).toBe(true)
    }
    // Not nested, not top-level, not anywhere: the registrar never computes one. The
    // registration lifetime is what the registrar GRANTS in its 200 to REGISTER, and the
    // TURN credential's expiry is inside its own username.
    expect(declaresPath(webrtc.sipTokenResponseSchema, 'expiry')).toBe(false)
    expect(declaresPath(webrtc.sipTokenResponseSchema, 'sip.expiry')).toBe(false)
  })

  it('the response schema stopped describing a shape the server never sent (#1190)', () => {
    // It published flat `domain`/`transport`/`username`/`password`, `iceServers[].urls`
    // (plural, an array) and `encryption`. Every client model written from the OpenAPI
    // snapshot inherited all three mistakes.
    expect(declaresPath(webrtc.sipTokenResponseSchema, 'encryption')).toBe(false)
    expect(declaresPath(webrtc.sipTokenResponseSchema, 'sip.mediaEncryption')).toBe(true)
    expect(declaresPath(webrtc.sipIceServerSchema, 'url')).toBe(true)
    expect(declaresPath(webrtc.sipIceServerSchema, 'urls')).toBe(false)
  })

  it('a STUN-only payload is what a host with no TURN rendered hands a client (#1657)', () => {
    // Pinned so the degraded case stays a RECOGNISED shape rather than something the
    // client discovers at runtime: it is valid, it decodes, and it carries no relay — so
    // a volunteer behind a symmetric NAT has no media path. Which is exactly why the
    // Ansible render matters, and why it is measurable.
    const stunOnly = fixture.responses.sipTokenStunOnly.sip as {
      iceServers: Array<{ url: string; username?: string; credential?: string }>
    }
    expect(webrtc.sipTokenResponseSchema.safeParse(fixture.responses.sipTokenStunOnly).success).toBe(true)
    expect(stunOnly.iceServers).toHaveLength(1)
    expect(stunOnly.iceServers[0].url.startsWith('stun:')).toBe(true)
    expect(stunOnly.iceServers.some(s => s.url.startsWith('turn:'))).toBe(false)

    const withTurn = fixture.responses.sipTokenWithTurn.sip as {
      iceServers: Array<{ url: string; username?: string; credential?: string }>
    }
    const relays = withTurn.iceServers.filter(s => s.url.startsWith('turn:'))
    expect(relays).toHaveLength(2)
    for (const relay of relays) {
      expect(relay.username, 'a turn: entry without a credential is not a usable relay').toBeTruthy()
      expect(relay.credential).toBeTruthy()
      // coturn's long-term-credential REST convention: the expiry IS the username prefix.
      expect(Number((relay.username ?? '').split(':')[0])).toBeGreaterThan(0)
    }
  })

  it('the trust anchor is certificates only, and the degraded payload omits the key entirely', () => {
    const withAnchor = fixture.responses.sipTokenWithTurn.sip as { tlsTrustAnchorPem?: string }
    expect(withAnchor.tlsTrustAnchorPem).toContain('-----BEGIN CERTIFICATE-----')
    expect(withAnchor.tlsTrustAnchorPem).not.toContain('PRIVATE KEY')
    // Absent, not null and not empty: "verify against the device trust store", which is
    // a different instruction from "verify against this". Never "do not verify".
    expect(fixture.responses.sipTokenStunOnly.sip).not.toHaveProperty('tlsTrustAnchorPem')
  })
})
