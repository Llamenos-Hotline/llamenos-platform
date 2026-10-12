import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../types'
import { createLogger } from '../lib/logger'
import { getClientIp } from '../lib/client-ip'

const logger = createLogger('webhook-ip')

function ipToNum(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0
}

function isIpInCidr(ip: string, cidr: string): boolean {
  const [range, bits] = cidr.split('/')
  const mask = ~(2 ** (32 - parseInt(bits, 10)) - 1) >>> 0
  return (ipToNum(ip) & mask) === (ipToNum(range) & mask)
}

export function isIpInCidrs(ip: string, cidrs: string[]): boolean {
  return cidrs.some((cidr) => isIpInCidr(ip, cidr))
}

export function webhookIpAllowlist(provider: string) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const cidrKey = `${provider.toUpperCase()}_WEBHOOK_IPS`
    const cidrs = (c.env as unknown as Record<string, string | undefined>)[cidrKey]
    if (!cidrs) return next()

    const cidrList = cidrs.split(',').map(s => s.trim()).filter(Boolean)
    const clientIp = getClientIp(c.req.raw)
    if (!clientIp || !isIpInCidrs(clientIp, cidrList)) {
      logger.warn('Webhook IP not in allowlist', { provider })
      return c.text('Forbidden', 403)
    }
    return next()
  })
}
