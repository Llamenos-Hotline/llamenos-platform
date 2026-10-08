import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const compose = readFileSync(path.resolve(__dirname, '../../docker-compose.dev.yml'), 'utf8')

function serviceBlock(name: string): string {
  const header = `  ${name}:\n`
  const start = compose.indexOf(header)
  if (start < 0) return ''
  const rest = compose.slice(start + header.length)
  const next = /^\s{2}[a-z][a-z0-9-]*:\s*$/m.exec(rest)
  return compose.slice(start, next ? start + header.length + next.index : compose.length)
}

describe('dev telephony profile uses Kamailio as its SIP edge', () => {
  it('starts Kamailio with the client-facing SIP transports and required config', () => {
    const kamailio = serviceBlock('kamailio')

    expect(kamailio).toContain('profiles: ["telephony"]')
    expect(kamailio).toContain('./kamailio/kamailio.cfg:/etc/kamailio/kamailio.cfg:ro')
    expect(kamailio).toContain('./kamailio/dispatcher.list:/etc/kamailio/dispatcher.list:ro')
    expect(kamailio).toContain('./kamailio/tls.cfg.template:/usr/local/share/llamenos/tls.cfg.template:ro')
    expect(kamailio).toContain('./kamailio/kamailio-entrypoint.sh:/usr/local/share/llamenos/kamailio-entrypoint.sh:ro')
    expect(kamailio).toContain('./sip-tls-cert.sh:/usr/local/share/llamenos/sip-tls-cert.sh:ro')
    expect(kamailio).toContain('"${SIP_UDP_PORT:-5060}:5060/udp"')
    expect(kamailio).toContain('"${SIP_TCP_PORT:-5060}:5060/tcp"')
    expect(kamailio).toContain('"${SIPS_PORT:-5061}:5061/tcp"')
    expect(kamailio).toContain('condition: service_healthy')
    expect(kamailio).toContain('asterisk:')
    expect(kamailio).toContain('["CMD", "kamcmd", "core.version"]')
  })

  it('does not publish Asterisk SIP transports around the edge', () => {
    const asterisk = serviceBlock('asterisk')

    expect(asterisk).not.toMatch(/^\s+-\s*"?\d+:5060\/udp"?$/m)
    expect(asterisk).not.toMatch(/^\s+-\s*"?\d+:5060\/tcp"?$/m)
    expect(asterisk).not.toMatch(/^\s+-\s*"?\d+:5061\/tcp"?$/m)
    expect(asterisk).toMatch(/^\s+-\s*"?\d+:8088"?\s*(?:#.*)?$/m)
  })
})
