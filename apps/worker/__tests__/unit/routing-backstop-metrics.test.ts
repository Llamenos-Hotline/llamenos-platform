/**
 * Instance-level routing backstop metrics (#2330).
 *
 * The WebhookAuthOutage / InboundButNoAnswers alert rules are only as good as
 * the series they read. The promtool cases prove the rules against fixtures;
 * these prove the app publishes those series, with the label sets the rules
 * select on, never a hub, and counts the events the rules reason about.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@worker/__tests__/mocks/llamenos-crypto-ffi'
import metricsRoutes from '@worker/routes/metrics'
import { CallsService } from '@worker/services/calls'
import { TwilioAdapter } from '@worker/telephony/twilio'
import { SignalWireAdapter } from '@worker/telephony/signalwire'
import {
  recordTelephonyWebhookRejection,
  resetWebhookRejectionDamping,
  sourcePrefix,
} from '@worker/telephony/webhook-rejection'

const REJECTED = 'llamenos_telephony_webhook_rejected_total'
const INBOUND = 'llamenos_calls_inbound_total'
const ANSWERED = 'llamenos_calls_answered_total'

/** Scrape /api/metrics/prometheus and return `series -> value` for one metric family. */
async function scrape(name: string): Promise<Map<string, number>> {
  const res = await metricsRoutes.request(
    '/prometheus',
    { headers: { Authorization: 'Bearer scrape-token' } },
    { METRICS_SCRAPE_TOKEN: 'scrape-token' },
  )
  expect(res.status).toBe(200)
  const series = new Map<string, number>()
  for (const line of (await res.text()).split('\n')) {
    if (line.startsWith(`${name} `) || line.startsWith(`${name}{`)) {
      const at = line.lastIndexOf(' ')
      series.set(line.slice(0, at), Number(line.slice(at + 1)))
    }
  }
  return series
}

async function rejected(reason: string, attribution: string): Promise<number> {
  return (await scrape(REJECTED)).get(`${REJECTED}{reason="${reason}",attribution="${attribution}"}`) ?? NaN
}

describe('GET /api/metrics/prometheus — routing backstop series', () => {
  it('publishes every label set from boot, at 0, so the first event is visible to increase()', async () => {
    const res = await metricsRoutes.request(
      '/prometheus',
      { headers: { Authorization: 'Bearer scrape-token' } },
      { METRICS_SCRAPE_TOKEN: 'scrape-token' },
    )
    const body = await res.text()

    for (const name of [REJECTED, INBOUND, ANSWERED]) {
      expect(body).toContain(`# HELP ${name} `)
      expect(body).toContain(`# TYPE ${name} counter`)
      // Exactly one TYPE line per family: a duplicate makes Prometheus drop the scrape.
      expect(body.match(new RegExp(`^# TYPE ${name} `, 'gm'))).toHaveLength(1)
    }
    const keys = [...(await scrape(REJECTED)).keys()].sort()
    expect(keys).toEqual(
      [
        `${REJECTED}{reason="no_provider",attribution="unattributed"}`,
        `${REJECTED}{reason="ip_not_allowed",attribution="unattributed"}`,
        `${REJECTED}{reason="signature_invalid",attribution="own_account"}`,
        `${REJECTED}{reason="signature_invalid",attribution="unattributed"}`,
      ].sort(),
    )
    expect((await scrape(INBOUND)).has(INBOUND)).toBe(true)
    expect((await scrape(ANSWERED)).has(ANSWERED)).toBe(true)
  })

  it('carries only reason / attribution labels: never a hub, user, caller or address', async () => {
    for (const name of [REJECTED, INBOUND, ANSWERED]) {
      for (const key of (await scrape(name)).keys()) {
        const labels = [...key.matchAll(/(\w+)="/g)].map((m) => m[1])
        expect(labels.filter((l) => !['reason', 'attribution'].includes(l))).toEqual([])
        expect(key).not.toMatch(/hub/i)
      }
    }
  })
})

describe('no per-hub label is ever attached to a counter (#2330 trap)', () => {
  it('git grep "incCounter(.*hubId" finds nothing in apps/worker sources', () => {
    // Walk the sources rather than shelling out to git: the unit tier also
    // runs from a .git-less export.
    const root = path.resolve(__dirname, '../..')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts') && /incCounter\(.*hubId/.test(readFileSync(full, 'utf8'))) offenders.push(full)
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})

describe('sourcePrefix', () => {
  it('buckets IPv4 by /24 and IPv6 by /48', () => {
    expect(sourcePrefix('203.0.113.7')).toBe('203.0.113')
    expect(sourcePrefix('203.0.113.250')).toBe('203.0.113')
    expect(sourcePrefix('2001:db8:abcd:1::1')).toBe('2001:db8:abcd')
    expect(sourcePrefix('2001:DB8:ABCD:2:0:0:0:9')).toBe('2001:db8:abcd')
    expect(sourcePrefix('::1')).toBe('0:0:0')
    expect(sourcePrefix('fingerprint:abc')).toBe('fingerprint:abc')
  })
})

describe('recordTelephonyWebhookRejection', () => {
  const twilio = new TwilioAdapter('ACown', 'token', '+15550000000')

  function webhook(opts: { ip: string; accountSid?: string; body?: string }): Request {
    const body = opts.body ?? new URLSearchParams({ CallSid: 'CA1', ...(opts.accountSid ? { AccountSid: opts.accountSid } : {}) }).toString()
    return new Request('https://app.example/api/telephony/incoming', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': String(new TextEncoder().encode(body).length),
        'X-Forwarded-For': opts.ip,
      },
      body,
    })
  }

  beforeEach(() => {
    resetWebhookRejectionDamping()
    process.env.TRUST_PROXY_HEADERS = 'true'
  })

  it('counts our account, from the verified provider address, with a bad signature as own_account', async () => {
    const before = await rejected('signature_invalid', 'own_account')
    const req = webhook({ ip: '198.51.100.5', accountSid: 'ACown' })
    recordTelephonyWebhookRejection(req, {
      reason: 'signature_invalid',
      providerAddressVerified: true,
      namesOwnAccount: await twilio.webhookNamesOwnAccount(req),
    })
    expect(await rejected('signature_invalid', 'own_account')).toBe(before + 1)
  })

  it.each([
    ['a foreign account id (an attacker with their own provider account)', { accountSid: 'ACtheirs' }, true],
    ['no account id at all', {}, true],
    ['our account id but no provider-address evidence (a forgery wearing our name)', { accountSid: 'ACown' }, false],
  ])('counts %s as unattributed', async (_label, opts, verified) => {
    const own = await rejected('signature_invalid', 'own_account')
    const other = await rejected('signature_invalid', 'unattributed')
    const req = webhook({ ip: '198.51.100.9', ...opts })
    recordTelephonyWebhookRejection(req, {
      reason: 'signature_invalid',
      providerAddressVerified: verified,
      namesOwnAccount: await twilio.webhookNamesOwnAccount(req),
    })
    expect(await rejected('signature_invalid', 'own_account')).toBe(own)
    expect(await rejected('signature_invalid', 'unattributed')).toBe(other + 1)
  })

  it('classifies SignalWire like Twilio (same AccountSid field)', async () => {
    const signalwire = new SignalWireAdapter('project-id', 'token', '+15550000000', 'space')
    const before = await rejected('signature_invalid', 'own_account')
    const req = webhook({ ip: '198.51.100.21', accountSid: 'project-id' })
    recordTelephonyWebhookRejection(req, {
      reason: 'signature_invalid',
      providerAddressVerified: true,
      namesOwnAccount: await signalwire.webhookNamesOwnAccount(req),
    })
    expect(await rejected('signature_invalid', 'own_account')).toBe(before + 1)
  })

  it('never attributes a rejection that was not a signature failure', async () => {
    const own = await rejected('signature_invalid', 'own_account')
    const ip = await rejected('ip_not_allowed', 'unattributed')
    recordTelephonyWebhookRejection(webhook({ ip: '198.51.100.30', accountSid: 'ACown' }), {
      reason: 'ip_not_allowed',
      providerAddressVerified: true,
      namesOwnAccount: true,
    })
    expect(await rejected('signature_invalid', 'own_account')).toBe(own)
    expect(await rejected('ip_not_allowed', 'unattributed')).toBe(ip + 1)
  })

  it('an account id that was not read is unattributed', async () => {
    const own = await rejected('signature_invalid', 'own_account')
    const other = await rejected('signature_invalid', 'unattributed')
    recordTelephonyWebhookRejection(webhook({ ip: '198.51.100.40', accountSid: 'ACown' }), {
      reason: 'signature_invalid',
      providerAddressVerified: true,
    })
    expect(await rejected('signature_invalid', 'own_account')).toBe(own)
    expect(await rejected('signature_invalid', 'unattributed')).toBe(other + 1)
  })

  it('unattributed noise from the provider\'s own /24 cannot use up the slot an own_account event needs', async () => {
    const ownBefore = await rejected('signature_invalid', 'own_account')
    const noiseBefore = await rejected('signature_invalid', 'unattributed')
    const send = async (accountSid: string) => {
      const req = webhook({ ip: '198.51.100.77', accountSid })
      recordTelephonyWebhookRejection(req, {
        reason: 'signature_invalid',
        providerAddressVerified: true,
        namesOwnAccount: await twilio.webhookNamesOwnAccount(req),
      })
    }
    await send('ACattacker') // a customer of the same provider, same egress /24
    await send('ACattacker')
    await send('ACown')
    expect(await rejected('signature_invalid', 'unattributed')).toBe(noiseBefore + 1)
    expect(await rejected('signature_invalid', 'own_account')).toBe(ownBefore + 1)
  })

  it('counts a source /24 at most once a minute, and another /24 independently', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    try {
      const base = await rejected('no_provider', 'unattributed')
      const fire = (ip: string) =>
        recordTelephonyWebhookRejection(webhook({ ip }), { reason: 'no_provider', providerAddressVerified: false })

      for (let i = 1; i <= 500; i++) fire(`192.0.2.${i % 250}`) // 500 forged webhooks, one /24
      expect(await rejected('no_provider', 'unattributed')).toBe(base + 1)

      fire('192.0.3.1') // another /24
      expect(await rejected('no_provider', 'unattributed')).toBe(base + 2)

      vi.setSystemTime(1_000_000 + 61_000)
      fire('192.0.2.9') // its minute is over
      expect(await rejected('no_provider', 'unattributed')).toBe(base + 3)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('inbound / answered counting', () => {
  const where = (rows: unknown[]) => vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(rows) })

  it('counts a call when it enters the queue', async () => {
    const before = (await scrape(INBOUND)).get(INBOUND) ?? NaN
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ callId: 'c1', hubId: 'hub-1' }]) }),
      }),
    }
    await new CallsService(db as never).addCall('hub-1', { callId: 'c1', callerNumberSealed: null })
    expect((await scrape(INBOUND)).get(INBOUND)).toBe(before + 1)
  })

  it('counts an answer only for the pickup that wins, never for a 409 or 404', async () => {
    const before = (await scrape(ANSWERED)).get(ANSWERED) ?? NaN
    const winner = {
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: where([{ callId: 'c1' }]) }) }),
    }
    await new CallsService(winner as never).answerCall('hub-1', 'c1', 'pk')
    expect((await scrape(ANSWERED)).get(ANSWERED)).toBe(before + 1)

    const loser = {
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: where([]) }) }),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ callId: 'c1', status: 'in-progress' }]) }),
        }),
      }),
    }
    await expect(new CallsService(loser as never).answerCall('hub-1', 'c1', 'pk2')).rejects.toMatchObject({ status: 409 })
    expect((await scrape(ANSWERED)).get(ANSWERED)).toBe(before + 1)
  })
})
