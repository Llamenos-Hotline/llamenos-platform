/**
 * The real app (#2118): the declared-response check is mounted on `/api` and
 * every route that declares a JSON response schema is captured — read from the
 * route table `apps/worker/app.ts` builds, not a hand-built copy.
 */
import { describe, it, expect, vi } from 'vitest'

// app.ts imports the Bun-native db driver; only the route TABLE is read here.
vi.mock('@worker/db', () => ({
  createDatabase: vi.fn(),
  getDb: vi.fn(),
  closeDb: vi.fn(),
  schema: {},
}))

const { default: app } = await import('@worker/app')
const { registerDeclaredResponses, listDeclaredResponses } = await import('@worker/openapi/declared-responses')
const { KNOWN_VIOLATIONS } = await import('@worker/openapi/declared-response-ledger')

describe('declared-response check in apps/worker/app.ts', () => {
  it('captured the routes that declare a response schema at startup', () => {
    // Idempotent: counts what app.ts already captured. Floor set well under
    // today's count (~400), so a check that stopped seeing routes fails here
    // rather than passing every response.
    expect(registerDeclaredResponses(app)).toBeGreaterThan(300)
  })

  it('covers the conversation list (#2118)', () => {
    const list = app.routes.filter(r => r.method === 'GET' && r.path === '/api/hubs/:hubId/conversations')
    expect(list.length).toBeGreaterThan(0)
    const probe = { routes: list }
    expect(registerDeclaredResponses(probe)).toBe(1)
  })

  it('ledgers only routes the app still declares, each once', () => {
    // A removed or re-shaped route cannot leave a dead entry that would later
    // excuse whatever is mounted at that path next.
    const declared = new Set(listDeclaredResponses(app).map(d => `${d.method} ${d.route} ${d.status}`))
    const entries = KNOWN_VIOLATIONS.map(k => `${k.method} ${k.route} ${k.status}`)
    expect(entries.filter(e => !declared.has(e))).toEqual([])
    expect(new Set(entries).size).toBe(entries.length)
  })

  it('never ledgers the conversation or message lists (#2118)', () => {
    expect(KNOWN_VIOLATIONS.filter(k => k.route.startsWith('/api/hubs/:hubId/conversations'))).toEqual([])
  })
})
