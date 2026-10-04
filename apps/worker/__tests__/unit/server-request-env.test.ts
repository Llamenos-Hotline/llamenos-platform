/**
 * `src/server/index.ts` builds the Hono request env (`c.env`) as an explicit
 * key-by-key literal. Anything missing from that literal is permanently
 * `undefined` to every route, whatever the deploy writes into the container.
 *
 * The bug this pins: the push variables were written by
 * deploy/ansible/templates/env/_worker-required-env.j2 and read by
 * apps/worker/lib/voip-push.ts and push-dispatch.ts, but were never bridged
 * into the literal. Both push transports were therefore inert on every
 * deployment — and silently so, because `validateConfig()` reads `process.env`
 * directly and so reported push as configured while the routes saw nothing.
 *
 * The expected set is derived by reading the consuming source, not restated
 * here: a test that hardcodes the same list twice cannot catch the next
 * variable someone reads from `c.env` and forgets to bridge.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(__dirname, '../../../..')

const SERVER_ENTRY = path.join(REPO_ROOT, 'src/server/index.ts')

/** Files that read deploy-provided configuration off the Hono request env. */
const ENV_CONSUMERS = [
  'apps/worker/lib/voip-push.ts',
  'apps/worker/lib/push-dispatch.ts',
  'apps/worker/lib/ntfy-origin.ts',
  'apps/worker/routes/config.ts',
]

/** The `const env: Record<string, unknown> = { ... }` literal, as source. */
function requestEnvLiteral(): string {
  const source = readFileSync(SERVER_ENTRY, 'utf-8')
  const start = source.indexOf('const env: Record<string, unknown> = {')
  expect(start, 'request env literal not found in src/server/index.ts').toBeGreaterThan(-1)
  const end = source.indexOf('\n}', start)
  return source.slice(start, end)
}

/** Keys the literal actually assigns. */
function bridgedKeys(): Set<string> {
  const keys = new Set<string>()
  for (const m of requestEnvLiteral().matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)) keys.add(m[1])
  return keys
}

/** Deploy-provided names a consumer reads off `env` / `c.env`. */
function consumedKeys(relativePath: string): Set<string> {
  const source = readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8')
  const keys = new Set<string>()
  for (const m of source.matchAll(/\bc?\.?env\.([A-Z][A-Z0-9_]{2,})\b/g)) keys.add(m[1])
  // `Pick<Env, 'NTFY_URL' | 'NTFY_PUBLIC_URL'>` style reads.
  for (const m of source.matchAll(/\bPick<\s*Env\s*,([^>]+)>/g)) {
    for (const q of m[1].matchAll(/'([A-Z][A-Z0-9_]{2,})'/g)) keys.add(q[1]);
  }
  return keys
}

describe('server request env', () => {
  it('bridges every deploy-provided variable its consumers read', () => {
    const bridged = bridgedKeys()
    const missing: string[] = []

    for (const file of ENV_CONSUMERS) {
      for (const key of consumedKeys(file)) {
        if (!bridged.has(key)) missing.push(`${key} (read in ${file})`)
      }
    }

    expect(missing).toEqual([])
  })

  it('bridges the push variables that were inert on every deployment', () => {
    const bridged = bridgedKeys()

    // iOS VoIP/APNs.
    expect(bridged).toContain('APNS_KEY_P8')
    expect(bridged).toContain('APNS_KEY_ID')
    expect(bridged).toContain('APNS_TEAM_ID')
    // Android UnifiedPush via ntfy. Without NTFY_PUBLIC_URL, device endpoints
    // registered on the public vhost are rejected by the origin policy.
    expect(bridged).toContain('NTFY_URL')
    expect(bridged).toContain('NTFY_AUTH_TOKEN')
    expect(bridged).toContain('NTFY_PUBLIC_URL')
    // Demo reset schedule reported by routes/config.ts.
    expect(bridged).toContain('DEMO_RESET_CRON')
  })

  it('stays an explicit literal — no blanket env spread', () => {
    // A spread would make this test vacuous and would widen what every route
    // can read to the container's entire environment. Comments are stripped
    // first so prose about the rule does not trip the rule.
    const code = requestEnvLiteral().replace(/\/\/[^\n]*/g, '')
    expect(code).not.toMatch(/\.\.\.\s*process\.env/)
  })
})
