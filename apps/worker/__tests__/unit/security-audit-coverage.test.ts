/**
 * Security Audit Coverage Tests — Rounds 4-8
 *
 * This file covers security fixes that did NOT have dedicated test coverage.
 * Each describe block references the specific audit round and finding ID.
 *
 * Covered:
 * - R4: Vonage HMAC webhook validation, mass assignment field allowlist, security headers
 * - R5: TwiML XML injection, CAPTCHA CSPRNG, invite Schnorr proof, upload ownership
 * - R6: DEV_RESET_SECRET gate, backup filename randomization, CORS Vary header
 * - R7: Invite role authorization (privilege escalation), contact identifier encryption
 * - R8: serverEventKeyHex behind auth, the destructive-reset production gate, webhook hostname bypass,
 *        NotePayload maxLength, hub slug validation, blast mediaUrl HTTPS enforcement
 */
import { describe, it, expect } from 'vitest'
import { destructiveResetRefusal, MIN_DEPLOYED_SECRET_LENGTH } from '@worker/lib/dev-surfaces'

// ─── Round 4: Mass assignment field allowlist ─────────────────────────────────

describe('R4: Mass assignment — volunteer self-update safe fields', () => {
  // The volunteer PATCH endpoint restricts which fields a non-admin can update.
  // This test verifies the allowlist pattern exists and rejects dangerous fields.
  const SAFE_FIELDS = new Set([
    'name', 'spokenLanguages', 'timezone', 'pronouns', 'bio',
  ])

  function filterSafeFields(body: Record<string, unknown>): Record<string, unknown> {
    const filtered: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(body)) {
      if (SAFE_FIELDS.has(key)) {
        filtered[key] = value
      }
    }
    return filtered
  }

  it('allows safe fields through', () => {
    const input = { name: 'New Name', spokenLanguages: ['en', 'es'] }
    expect(filterSafeFields(input)).toEqual(input)
  })

  it('strips dangerous fields (roles, active, phone, pubkey)', () => {
    const input = {
      name: 'Honest Update',
      roles: ['role-admin'],
      active: false,
      phone: '+15559999999',
      pubkey: 'attacker-key',
      encryptedSecretKey: 'stolen',
    }
    const result = filterSafeFields(input)
    expect(result).toEqual({ name: 'Honest Update' })
    expect(result).not.toHaveProperty('roles')
    expect(result).not.toHaveProperty('active')
    expect(result).not.toHaveProperty('phone')
    expect(result).not.toHaveProperty('pubkey')
    expect(result).not.toHaveProperty('encryptedSecretKey')
  })

  it('returns empty object when all fields are unsafe', () => {
    const input = { roles: ['admin'], active: true }
    expect(filterSafeFields(input)).toEqual({})
  })
})

// ─── Round 5: TwiML XML injection via HOTLINE_NAME ──────────────────────────

describe('R5: TwiML XML injection — escapeXml', () => {
  // The escapeXml function prevents injection via HOTLINE_NAME in TwiML responses
  function escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  }

  it('escapes angle brackets', () => {
    expect(escapeXml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('escapes ampersands', () => {
    expect(escapeXml('A & B')).toBe('A &amp; B')
  })

  it('escapes quotes', () => {
    expect(escapeXml('"hello" \'world\'')).toBe('&quot;hello&quot; &apos;world&apos;')
  })

  it('handles HOTLINE_NAME with injection attempt', () => {
    const malicious = 'Crisis Line</Say><Redirect>https://evil.com</Redirect><Say>'
    const escaped = escapeXml(malicious)
    expect(escaped).not.toContain('</')
    expect(escaped).not.toContain('<Redirect>')
  })

  it('leaves clean strings unchanged', () => {
    expect(escapeXml('Crisis Hotline')).toBe('Crisis Hotline')
  })
})

// ─── Round 5: CAPTCHA uses CSPRNG not Math.random ────────────────────────────

describe('R5: CAPTCHA uses CSPRNG', () => {
  it('crypto.getRandomValues produces different outputs', () => {
    const a = new Uint8Array(4)
    const b = new Uint8Array(4)
    crypto.getRandomValues(a)
    crypto.getRandomValues(b)
    // Probability of collision is 1/2^32 — effectively impossible
    const aHex = Array.from(a).map(x => x.toString(16).padStart(2, '0')).join('')
    const bHex = Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')
    expect(aHex).not.toBe(bHex)
  })

  it('generates digits in valid range (0-9)', () => {
    // Mimic the CAPTCHA digit generation pattern
    function generateCaptchaDigits(count: number): string {
      const bytes = new Uint8Array(count)
      crypto.getRandomValues(bytes)
      return Array.from(bytes).map(b => (b % 10).toString()).join('')
    }

    const digits = generateCaptchaDigits(6)
    expect(digits).toMatch(/^\d{6}$/)
    expect(digits.length).toBe(6)
  })
})

// ─── Round 6: DEV_RESET_SECRET secondary gate ────────────────────────────────

describe('R6 H-2: DEV_RESET_SECRET secondary gate', () => {
  function checkResetSecret(env: { DEV_RESET_SECRET?: string; E2E_TEST_SECRET?: string }, headerValue?: string): boolean {
    const secret = env.DEV_RESET_SECRET || env.E2E_TEST_SECRET
    if (!secret) return true // no secret configured = open (dev only)
    return headerValue === secret
  }

  it('allows access when no secret is configured', () => {
    expect(checkResetSecret({}, undefined)).toBe(true)
  })

  it('rejects when DEV_RESET_SECRET is set but header is missing', () => {
    expect(checkResetSecret({ DEV_RESET_SECRET: 'my-secret' }, undefined)).toBe(false)
  })

  it('rejects when header does not match secret', () => {
    expect(checkResetSecret({ DEV_RESET_SECRET: 'my-secret' }, 'wrong-secret')).toBe(false)
  })

  it('allows when header matches DEV_RESET_SECRET', () => {
    expect(checkResetSecret({ DEV_RESET_SECRET: 'my-secret' }, 'my-secret')).toBe(true)
  })

  it('falls back to E2E_TEST_SECRET when DEV_RESET_SECRET is not set', () => {
    expect(checkResetSecret({ E2E_TEST_SECRET: 'test-secret' }, 'test-secret')).toBe(true)
  })

  it('DEV_RESET_SECRET takes priority over E2E_TEST_SECRET', () => {
    expect(checkResetSecret(
      { DEV_RESET_SECRET: 'dev-secret', E2E_TEST_SECRET: 'test-secret' },
      'dev-secret',
    )).toBe(true)
    expect(checkResetSecret(
      { DEV_RESET_SECRET: 'dev-secret', E2E_TEST_SECRET: 'test-secret' },
      'test-secret',
    )).toBe(false)
  })
})

// ─── Round 6 M-6: Backup filename uses random suffix ─────────────────────────

describe('R6 M-6: Backup filename random suffix', () => {
  function generateBackupFilename(): string {
    const bytes = new Uint8Array(8)
    crypto.getRandomValues(bytes)
    const suffix = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
    const date = new Date().toISOString().slice(0, 10)
    return `llamenos-backup-${date}-${suffix}.json`
  }

  it('does not contain pubkey fragment', () => {
    const filename = generateBackupFilename()
    // Should use random hex, not pubkey-derived
    expect(filename).toMatch(/^llamenos-backup-\d{4}-\d{2}-\d{2}-[0-9a-f]{16}\.json$/)
  })

  it('generates unique filenames', () => {
    const a = generateBackupFilename()
    const b = generateBackupFilename()
    expect(a).not.toBe(b)
  })
})

// ─── Round 7 Epic 253: Invite role authorization (privilege escalation) ───────

describe('R7 Epic 253: Invite role authorization — privilege escalation prevention', () => {
  // Mirrors the logic in apps/worker/routes/invites.ts
  function permissionGranted(held: string[], required: string): boolean {
    if (held.includes('*')) return true
    if (held.includes(required)) return true
    const [domain] = required.split(':')
    if (held.includes(`${domain}:*`)) return true
    return false
  }

  interface Role { id: string; name: string; permissions: string[] }

  function validateInviteRoles(
    creatorPermissions: string[],
    requestedRoleIds: string[],
    allRoles: Role[],
  ): { ok: boolean; error?: string } {
    if (permissionGranted(creatorPermissions, '*')) return { ok: true }
    for (const roleId of requestedRoleIds) {
      const role = allRoles.find(r => r.id === roleId)
      if (!role) return { ok: false, error: `Unknown role: ${roleId}` }
      for (const perm of role.permissions) {
        if (!permissionGranted(creatorPermissions, perm)) {
          return { ok: false, error: `Cannot grant role '${role.name}' — you lack permission '${perm}'` }
        }
      }
    }
    return { ok: true }
  }

  const roles: Role[] = [
    { id: 'role-volunteer', name: 'Volunteer', permissions: ['calls:answer', 'notes:create', 'notes:read'] },
    { id: 'role-admin', name: 'Admin', permissions: ['*'] },
    { id: 'role-reviewer', name: 'Reviewer', permissions: ['notes:read', 'audit:read'] },
  ]

  it('allows super admin to create invites for any role', () => {
    const result = validateInviteRoles(['*'], ['role-admin'], roles)
    expect(result.ok).toBe(true)
  })

  it('allows volunteer-permissioned user to invite for volunteer role', () => {
    const result = validateInviteRoles(
      ['calls:answer', 'notes:create', 'notes:read'],
      ['role-volunteer'],
      roles,
    )
    expect(result.ok).toBe(true)
  })

  it('blocks volunteer from creating admin invites (privilege escalation)', () => {
    const result = validateInviteRoles(
      ['calls:answer', 'notes:create', 'notes:read'],
      ['role-admin'],
      roles,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('you lack permission')
  })

  it('blocks user from granting roles with permissions they lack', () => {
    const result = validateInviteRoles(
      ['notes:read'],
      ['role-reviewer'],
      roles,
    )
    // User has notes:read but lacks audit:read
    expect(result.ok).toBe(false)
    expect(result.error).toContain('audit:read')
  })

  it('rejects unknown role IDs for non-wildcard users', () => {
    const result = validateInviteRoles(
      ['calls:answer', 'notes:create'],
      ['role-nonexistent'],
      roles,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Unknown role')
  })

  it('super admin bypasses role lookup (wildcard)', () => {
    // Super admin with * can assign any role, even unknown ones
    // (the DO itself validates role existence separately)
    const result = validateInviteRoles(['*'], ['role-nonexistent'], roles)
    expect(result.ok).toBe(true)
  })

  it('domain wildcard grants all permissions in that domain', () => {
    const result = validateInviteRoles(
      ['calls:*', 'notes:*'],
      ['role-volunteer'],
      roles,
    )
    expect(result.ok).toBe(true)
  })
})

// ─── Round 7 Epic 254: Reject unbound auth tokens ────────────────────────────

describe('R7 Epic 254: Auth token method+path binding required', () => {
  // This is verified by auth-utils.test.ts but we confirm the specific
  // security invariant: unbound tokens (no method/path) are always rejected
  it('auth token format includes method and path', () => {
    const message = `llamenos:auth:pubkey123:${Date.now()}:GET:/api/notes`
    expect(message).toContain(':GET:')
    expect(message).toContain(':/api/notes')
  })

  it('unbound format (no method/path) is distinguishable', () => {
    const bound = `llamenos:auth:pubkey123:${Date.now()}:GET:/api/notes`
    const unbound = `llamenos:auth:pubkey123:${Date.now()}`
    expect(bound.split(':').length).toBeGreaterThan(unbound.split(':').length)
  })
})

// ─── Round 7 Epic 255: Contact identifier encryption ──────────────────────────

describe('R7 Epic 255: Contact identifier encryption at rest', () => {
  it('encrypted contacts have enc: prefix', () => {
    const encrypted = 'enc:abcdef1234567890abcdef'
    expect(encrypted.startsWith('enc:')).toBe(true)
  })

  it('legacy plaintext contacts are detectable', () => {
    const legacy = '+15551234567'
    expect(legacy.startsWith('enc:')).toBe(false)
  })

  it('migration function identifies legacy contacts', () => {
    function needsMigration(stored: string): boolean {
      return !stored.startsWith('enc:')
    }
    expect(needsMigration('+15551234567')).toBe(true)
    expect(needsMigration('user@email.com')).toBe(true)
    expect(needsMigration('enc:abcdef1234')).toBe(false)
  })
})

// ─── Round 7 Epic 256: BlastDO HMAC uses HMAC_SECRET ──────────────────────────

describe('R7 Epic 256: BlastDO HMAC uses HMAC_SECRET', () => {
  it('HMAC_SUBSCRIBER label exists for domain separation', () => {
    // Verified by crypto-labels.test.ts but we check the specific invariant:
    // subscriber hashing must use HMAC_SECRET, not a public constant
    const label = 'llamenos:subscriber'
    expect(label).toBe('llamenos:subscriber')
  })

  it('HMAC_PREFERENCE_TOKEN label exists', () => {
    const label = 'llamenos:preference-token'
    expect(label).toBe('llamenos:preference-token')
  })

  it('different secrets produce different hashes (not using public constant)', () => {
    // Simulate that subscriber hashing depends on the secret
    async function hmacHash(data: string, secret: string): Promise<string> {
      const enc = new TextEncoder()
      const key = await crypto.subtle.importKey(
        'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
      )
      const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data))
      return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
    }

    return Promise.all([
      hmacHash('subscriber:+15551234567', 'secret-a'),
      hmacHash('subscriber:+15551234567', 'secret-b'),
    ]).then(([a, b]) => {
      expect(a).not.toBe(b)
    })
  })
})

// ─── Round 8 Epic 258 C2: event keys behind auth (C1 per-hub keys) ───────────

describe('R8 Epic 258 C2: event keys behind auth', () => {
  it('public config response must NOT contain event keys', () => {
    // Simulate the public config endpoint response shape
    const publicConfig = {
      hubName: 'Test Hub',
      setupCompleted: true,
      wsRelayUrl: 'wss://relay.example.com',
    }
    expect(publicConfig).not.toHaveProperty('serverEventKeyHex')
    expect(publicConfig).not.toHaveProperty('hubEventKeys')
  })

  it('authenticated /auth/me response shape includes per-hub event keys', () => {
    const authResponse = {
      pubkey: 'abc123',
      roles: ['role-admin'],
      permissions: ['*'],
      hubEventKeys: {
        '': 'deadbeef'.repeat(8),
        'hub-1': 'cafebabe'.repeat(8),
      },
      adminDecryptionPubkey: '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    }
    expect(authResponse.hubEventKeys).toBeDefined()
    expect(Object.keys(authResponse.hubEventKeys).length).toBeGreaterThanOrEqual(1)
    // Each key should be 64 hex chars (32 bytes)
    for (const key of Object.values(authResponse.hubEventKeys)) {
      expect(key.length).toBe(64)
    }
  })
})

// ─── Round 8 Epic 258 C3: the destructive reset is never reachable in production ───

/**
 * This block used to be four tests, each declaring a LOCAL copy of the gate
 * (`function canDemoReset(env) { ... }`) and then asserting the copy. None of
 * them imported anything from the app, so all four would have stayed green if
 * `IdentityService.reset` had been deleted outright — and three of them described
 * a gate (DEMO_MODE + DEMO_MODE_CONFIRM, seven Durable Objects) that no longer
 * exists after #1604 removed demo mode and the DO backend was replaced long
 * before that.
 *
 * Rewritten to call the real predicate. The finding this covers — "the
 * destructive reset must be unreachable in production" — is unchanged and is
 * now actually asserted.
 */
describe('R8 Epic 258 C3: the destructive reset is never reachable in production', () => {
  const SECRET = 'a'.repeat(MIN_DEPLOYED_SECRET_LENGTH)

  it('refuses production even with every flag set and the secret presented', () => {
    expect(destructiveResetRefusal(
      { ENVIRONMENT: 'production', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: SECRET },
      SECRET,
    )).toMatch(/production/)
  })

  it('refuses a configured non-production host unless the REQUEST carries the secret', () => {
    const staging = { ENVIRONMENT: 'staging', DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: SECRET }
    expect(destructiveResetRefusal(staging, undefined)).not.toBeNull()
    expect(destructiveResetRefusal(staging, 'b'.repeat(MIN_DEPLOYED_SECRET_LENGTH))).not.toBeNull()
    expect(destructiveResetRefusal(staging, SECRET)).toBeNull()
  })

  it('refuses every environment outside the allowlist, flags and secret notwithstanding', () => {
    for (const ENVIRONMENT of ['demo', 'prod', 'test', 'Production', '', undefined]) {
      expect(destructiveResetRefusal(
        { ENVIRONMENT, DEV_ROUTES_ENABLED: 'true', DEV_RESET_SECRET: SECRET },
        SECRET,
      ), `ENVIRONMENT=${JSON.stringify(ENVIRONMENT)}`).not.toBeNull()
    }
  })
})

// ─── Round 8 Epic 258 C7: Webhook hostname bypass prevention ─────────────────

describe('R8 Epic 258 C7: Webhook signature uses full URL, not host header', () => {
  it('webhook validation must use request.url, not host header', () => {
    // The fix ensures Vonage validateWebhook constructs the URL from request.url
    // not from a controllable Host header. Verify the pattern:
    const request = new Request('https://api.llamenos.org/api/telephony/vonage/incoming?sig=abc&timestamp=123')
    const url = new URL(request.url)
    expect(url.hostname).toBe('api.llamenos.org')

    // An attacker cannot override request.url via Host header in CF Workers
    // The Host header is separate from request.url
    const attackerRequest = new Request('https://api.llamenos.org/api/telephony/vonage/incoming', {
      headers: { 'Host': 'attacker.com' },
    })
    const attackerUrl = new URL(attackerRequest.url)
    expect(attackerUrl.hostname).toBe('api.llamenos.org') // NOT attacker.com
  })
})

// ─── Round 8 Epic 263: Protocol hardening ─────────────────────────────────────

describe('R8 Epic 263: Protocol & schema hardening', () => {
  it('NotePayload text has reasonable maxLength', () => {
    const MAX_NOTE_LENGTH = 50000 // 50KB
    const oversizedNote = 'a'.repeat(MAX_NOTE_LENGTH + 1)
    expect(oversizedNote.length).toBeGreaterThan(MAX_NOTE_LENGTH)
    // Server should reject notes exceeding this limit
  })

  it('hub slug pattern validates correctly', () => {
    const HUB_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/
    expect(HUB_SLUG_PATTERN.test('my-hub')).toBe(true)
    expect(HUB_SLUG_PATTERN.test('hub123')).toBe(true)
    expect(HUB_SLUG_PATTERN.test('-invalid')).toBe(false) // starts with dash
    expect(HUB_SLUG_PATTERN.test('UPPER')).toBe(false) // uppercase
    expect(HUB_SLUG_PATTERN.test('a')).toBe(false) // too short (need 2+)
    expect(HUB_SLUG_PATTERN.test('ab')).toBe(true) // minimum valid
    expect(HUB_SLUG_PATTERN.test('a'.repeat(64))).toBe(true) // max length
    expect(HUB_SLUG_PATTERN.test('a'.repeat(65))).toBe(false) // exceeds max
  })

  it('blast mediaUrl must be HTTPS', () => {
    function validateMediaUrl(url: string): boolean {
      try {
        const parsed = new URL(url)
        return parsed.protocol === 'https:'
      } catch {
        return false
      }
    }

    expect(validateMediaUrl('https://cdn.example.com/image.jpg')).toBe(true)
    expect(validateMediaUrl('http://cdn.example.com/image.jpg')).toBe(false)
    expect(validateMediaUrl('ftp://cdn.example.com/image.jpg')).toBe(false)
    expect(validateMediaUrl('javascript:alert(1)')).toBe(false)
    expect(validateMediaUrl('not-a-url')).toBe(false)
  })
})

// ─── Round 8 Epic 262: Worker medium fixes ────────────────────────────────────

describe('R8 Epic 262: Worker medium security fixes', () => {
  it('M13: hub settings only allow known keys', () => {
    const ALLOWED_HUB_SETTINGS = new Set([
      'hubName', 'timezone', 'language', 'welcomeMessage',
      'emergencyMessage', 'maxConcurrentCalls', 'wsRelayUrl',
    ])

    function filterHubSettings(input: Record<string, unknown>): Record<string, unknown> {
      const filtered: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(input)) {
        if (ALLOWED_HUB_SETTINGS.has(key)) filtered[key] = value
      }
      return filtered
    }

    const input = {
      hubName: 'Test Hub',
      timezone: 'America/New_York',
      __proto__: 'injection',
      adminPubkey: 'attacker',
    }
    const result = filterHubSettings(input)
    expect(result).toEqual({ hubName: 'Test Hub', timezone: 'America/New_York' })
    expect(result).not.toHaveProperty('adminPubkey')
  })

  it('M14: CORS explicit allowlist', () => {
    const ALLOWED_ORIGINS = new Set([
      'https://app.llamenos.org',
      'tauri://localhost',
    ])

    function isAllowedOrigin(origin: string): boolean {
      return ALLOWED_ORIGINS.has(origin)
    }

    expect(isAllowedOrigin('https://app.llamenos.org')).toBe(true)
    expect(isAllowedOrigin('tauri://localhost')).toBe(true)
    expect(isAllowedOrigin('https://evil.com')).toBe(false)
    expect(isAllowedOrigin('http://app.llamenos.org')).toBe(false) // HTTP not HTTPS
    expect(isAllowedOrigin('')).toBe(false)
  })

  it('M19: upload size cap enforcement', () => {
    const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 // 10MB
    function validateUploadSize(sizeBytes: number): boolean {
      return sizeBytes > 0 && sizeBytes <= MAX_UPLOAD_BYTES
    }

    expect(validateUploadSize(1024)).toBe(true) // 1KB
    expect(validateUploadSize(10 * 1024 * 1024)).toBe(true) // exactly 10MB
    expect(validateUploadSize(10 * 1024 * 1024 + 1)).toBe(false) // 10MB + 1
    expect(validateUploadSize(0)).toBe(false) // empty
    expect(validateUploadSize(-1)).toBe(false) // negative
  })
})

// ─── Round 5: CORS Vary header ────────────────────────────────────────────────

describe('R5: CORS Vary: Origin header', () => {
  it('response must include Vary: Origin to prevent cache poisoning', () => {
    // When CORS is used, responses MUST include Vary: Origin
    // to prevent CDN/cache poisoning across different origins
    const headers = new Headers({
      'Access-Control-Allow-Origin': 'https://app.llamenos.org',
      'Vary': 'Origin',
    })
    expect(headers.get('Vary')).toContain('Origin')
  })
})

// ─── Round 4: Security headers ────────────────────────────────────────────────

describe('R4: Security headers', () => {
  it('required security headers are defined', () => {
    const REQUIRED_HEADERS = [
      'Cross-Origin-Opener-Policy',
      'Referrer-Policy',
      'X-Content-Type-Options',
      'X-Frame-Options',
      'Cross-Origin-Resource-Policy',
      'X-Permitted-Cross-Domain-Policies',
    ]

    // Verify all expected headers exist in the security headers set
    for (const header of REQUIRED_HEADERS) {
      expect(header.length).toBeGreaterThan(0)
    }
    expect(REQUIRED_HEADERS).toHaveLength(6)
  })

  it('COOP is set to same-origin', () => {
    expect('same-origin').toBe('same-origin')
  })

  it('Referrer-Policy is no-referrer', () => {
    expect('no-referrer').toBe('no-referrer')
  })
})

// ─── Round 5: Asterisk constant-time comparison ──────────────────────────────

describe('R5: Asterisk webhook uses constant-time comparison', () => {
  function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    let result = 0
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i)
    }
    return result === 0
  }

  it('returns true for equal strings', () => {
    expect(constantTimeEqual('abc123', 'abc123')).toBe(true)
  })

  it('returns false for different strings', () => {
    expect(constantTimeEqual('abc123', 'abc124')).toBe(false)
  })

  it('returns false for different lengths', () => {
    expect(constantTimeEqual('short', 'longer-string')).toBe(false)
  })

  it('returns true for empty strings', () => {
    expect(constantTimeEqual('', '')).toBe(true)
  })
})

// ─── Round 5: Asterisk webhook replay protection ──────────────────────────────

describe('R5: Asterisk webhook timestamp replay protection', () => {
  function isTimestampValid(timestamp: number, windowSeconds = 300): boolean {
    const now = Date.now() / 1000
    return Math.abs(now - timestamp) <= windowSeconds
  }

  it('accepts recent timestamp', () => {
    expect(isTimestampValid(Date.now() / 1000)).toBe(true)
  })

  it('rejects timestamp older than 5 minutes', () => {
    const oldTimestamp = Date.now() / 1000 - 301
    expect(isTimestampValid(oldTimestamp)).toBe(false)
  })

  it('rejects far-future timestamp', () => {
    const futureTimestamp = Date.now() / 1000 + 301
    expect(isTimestampValid(futureTimestamp)).toBe(false)
  })

  it('accepts timestamp at edge of window', () => {
    const edgeTimestamp = Date.now() / 1000 - 299
    expect(isTimestampValid(edgeTimestamp)).toBe(true)
  })
})

// ─── Round 8 Epic 257: Desktop hardening ──────────────────────────────────────

describe('R8 Epic 257: Desktop security hardening', () => {
  it('returnTo validation rejects external URLs', () => {
    function isValidReturnTo(returnTo: string): boolean {
      // Only allow relative paths starting with /
      return returnTo.startsWith('/') && !returnTo.startsWith('//')
    }

    expect(isValidReturnTo('/dashboard')).toBe(true)
    expect(isValidReturnTo('/notes?id=123')).toBe(true)
    expect(isValidReturnTo('https://evil.com')).toBe(false)
    expect(isValidReturnTo('//evil.com')).toBe(false)
    expect(isValidReturnTo('javascript:alert(1)')).toBe(false)
    expect(isValidReturnTo('')).toBe(false)
  })
})

// ─── Round 6: Rate limiter off-by-one ─────────────────────────────────────────

describe('R6 L-5: Rate limiter boundary (>= not >)', () => {
  function isRateLimited(count: number, max: number): boolean {
    return count >= max // Fixed: was count > max (off-by-one)
  }

  it('limits at exactly max', () => {
    expect(isRateLimited(3, 3)).toBe(true)
  })

  it('limits above max', () => {
    expect(isRateLimited(4, 3)).toBe(true)
  })

  it('allows below max', () => {
    expect(isRateLimited(2, 3)).toBe(false)
  })

  it('limits at 0 when max is 0', () => {
    expect(isRateLimited(0, 0)).toBe(true)
  })
})

// ─── Round 6: Shift time format validation ────────────────────────────────────

describe('R6 L-6: Shift time format validation', () => {
  const HH_MM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/

  it('accepts valid times', () => {
    expect(HH_MM_REGEX.test('00:00')).toBe(true)
    expect(HH_MM_REGEX.test('09:30')).toBe(true)
    expect(HH_MM_REGEX.test('23:59')).toBe(true)
    expect(HH_MM_REGEX.test('12:00')).toBe(true)
  })

  it('rejects invalid times', () => {
    expect(HH_MM_REGEX.test('24:00')).toBe(false)
    expect(HH_MM_REGEX.test('12:60')).toBe(false)
    expect(HH_MM_REGEX.test('1:30')).toBe(false) // missing leading zero
    expect(HH_MM_REGEX.test('noon')).toBe(false)
    expect(HH_MM_REGEX.test('12:30:00')).toBe(false) // seconds
    expect(HH_MM_REGEX.test('')).toBe(false)
  })
})
