/**
 * The bounded pre-auth work behind provider-webhook rejections (#2330, spec
 * §5.7 amendment 4): source-prefix damping, the instance-wide ceiling on
 * IP-refused classification, the per-(hub, kind) write batching, the traffic
 * discriminator, and the streaming body cap.
 */
import { describe, expect, it } from 'vitest'
import {
  IP_REFUSED_CLASSIFICATIONS_PER_WINDOW,
  PROVIDER_AUTH_TRAFFIC_WINDOW_MS,
  ProviderAuthMonitor,
  REJECTION_DAMPING_MS,
  SIGNAL_MIN_INTERVAL_MS,
  WEBHOOK_BODY_LIMIT_BYTES,
  bodyWithinLimit,
  sourcePrefix,
} from '@worker/services/provider-auth'

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('sourcePrefix', () => {
  it('groups IPv4 by /24 and IPv6 by /48', () => {
    expect(sourcePrefix('203.0.113.7')).toBe('203.0.113.0/24')
    expect(sourcePrefix('::ffff:203.0.113.200')).toBe('203.0.113.0/24')
    expect(sourcePrefix('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48')
    expect(sourcePrefix('2001:0db8:abcd:0012:0000:0000:0000:0001')).toBe('2001:db8:abcd::/48')
    expect(sourcePrefix('2001:db8::1')).toBe('2001:db8:0::/48')
  })

  it('puts every address-less (header fingerprint) source in ONE bucket', () => {
    expect(sourcePrefix('fingerprint:curl/8:*/*')).toBe(sourcePrefix('fingerprint:other-agent:text/html'))
  })
})

describe('ProviderAuthMonitor.admit', () => {
  it('admits one rejection per prefix and class per minute; the next minute admits again', () => {
    const c = clock()
    const m = new ProviderAuthMonitor({ now: c.now })
    expect(m.admit('198.51.100.1', 'ip')).toBe(true)
    expect(m.admit('198.51.100.99', 'ip'), 'same /24 inside the window').toBe(false)
    expect(m.admit('198.51.101.1', 'ip'), 'another /24').toBe(true)
    expect(m.admit('198.51.100.1', 'signature_invalid'), 'classes are damped separately').toBe(true)
    c.advance(REJECTION_DAMPING_MS)
    expect(m.admit('198.51.100.1', 'ip')).toBe(true)
  })

  it('an attacker flooding one class cannot damp another: own-account failures keep their own budget', () => {
    const m = new ProviderAuthMonitor({ now: clock().now })
    expect(m.admit('10.0.0.1', 'signature_invalid')).toBe(true)
    expect(m.admit('10.0.0.2', 'own_account_signature_invalid')).toBe(true)
  })

  it('caps IP-refused classification instance-wide, however many prefixes the flood rotates through', () => {
    const c = clock()
    const m = new ProviderAuthMonitor({ now: c.now })
    let admitted = 0
    for (let i = 0; i < IP_REFUSED_CLASSIFICATIONS_PER_WINDOW + 500; i++) {
      if (m.admit(`10.${(i >> 8) & 0xff}.${i & 0xff}.1`, 'ip')) admitted++
    }
    expect(admitted).toBe(IP_REFUSED_CLASSIFICATIONS_PER_WINDOW)
    c.advance(REJECTION_DAMPING_MS)
    expect(m.admit('172.16.0.1', 'ip')).toBe(true)
  })

  it('a full damping table evicts rather than refusing every new source', () => {
    const m = new ProviderAuthMonitor({ now: clock().now })
    for (let i = 0; i < 5000; i++) m.admit(`10.${(i >> 8) & 0xff}.${i & 0xff}.1`, 'signature_invalid')
    expect(m.admit('172.16.5.5', 'signature_invalid')).toBe(true)
  })
})

describe('ProviderAuthMonitor.admitSignal', () => {
  it('writes at most once per interval per (hub, kind) and carries the held count with the next write', () => {
    const c = clock()
    const m = new ProviderAuthMonitor({ now: c.now })
    expect(m.admitSignal('hub-1', 'ip_rejected')).toBe(1)
    expect(m.admitSignal('hub-1', 'ip_rejected')).toBe(0)
    expect(m.admitSignal('hub-1', 'ip_rejected')).toBe(0)
    expect(m.admitSignal('hub-2', 'ip_rejected')).toBe(1)
    c.advance(SIGNAL_MIN_INTERVAL_MS)
    expect(m.admitSignal('hub-1', 'ip_rejected')).toBe(3)
  })
})

describe('ProviderAuthMonitor.trafficStopped', () => {
  it('is true only when accepted traffic flowed in the previous window and none in this one', () => {
    const c = clock()
    const m = new ProviderAuthMonitor({ now: c.now })
    expect(m.trafficStopped('hub-1'), 'never seen accepting: nothing to compare').toBe(false)
    m.recordAccepted('hub-1')
    c.advance(PROVIDER_AUTH_TRAFFIC_WINDOW_MS - 1)
    expect(m.trafficStopped('hub-1'), 'accepted traffic inside this window').toBe(false)
    c.advance(1)
    expect(m.trafficStopped('hub-1')).toBe(true)
    c.advance(PROVIDER_AUTH_TRAFFIC_WINDOW_MS)
    expect(m.trafficStopped('hub-1'), 'no traffic in the previous window either').toBe(false)
  })
})

describe('bodyWithinLimit', () => {
  /** A body stream that counts how many bytes anyone pulled from it. */
  function countingStream(totalBytes: number, chunk = 16 * 1024) {
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= totalBytes) return controller.close()
        const n = Math.min(chunk, totalBytes - pulled)
        pulled += n
        controller.enqueue(new Uint8Array(n))
      },
    })
    return { stream, pulled: () => pulled }
  }

  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request('http://localhost/api/telephony/incoming', { method: 'POST', body, headers, duplex: 'half' } as RequestInit)

  it('accepts a body at the limit and leaves it readable for the handler', async () => {
    const req = post('a'.repeat(WEBHOOK_BODY_LIMIT_BYTES))
    expect(await bodyWithinLimit(req)).toBe(true)
    expect((await req.text()).length).toBe(WEBHOOK_BODY_LIMIT_BYTES)
  })

  it('refuses a declared Content-Length over the limit without reading a byte', async () => {
    const body = countingStream(10 * 1024 * 1024)
    expect(await bodyWithinLimit(post(body.stream, { 'content-length': String(10 * 1024 * 1024) }))).toBe(false)
    expect(body.pulled()).toBeLessThanOrEqual(16 * 1024)
  })

  it('refuses an undeclared 10 MB body after reading barely past the limit — never the whole body', async () => {
    const body = countingStream(10 * 1024 * 1024)
    expect(await bodyWithinLimit(post(body.stream))).toBe(false)
    expect(body.pulled()).toBeLessThan(WEBHOOK_BODY_LIMIT_BYTES + 4 * 16 * 1024)
  })

  it('accepts an empty body', async () => {
    expect(await bodyWithinLimit(new Request('http://localhost/x', { method: 'GET' }))).toBe(true)
  })
})
