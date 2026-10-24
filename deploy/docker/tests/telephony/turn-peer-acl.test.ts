/**
 * The TURN relay's peer ACL must say the same thing in all four places it is
 * written (#2136).
 *
 * Every volunteer holds working TURN credentials and coturn runs on the host
 * network, so an allocation is a socket on the host that the volunteer can aim
 * anywhere the host can reach: the app, signal-cli, postgres and Asterisk's ARI
 * on the docker bridges, the cloud metadata service, the host's own address.
 * coturn refuses loopback by default and nothing else. A rule that exists in the
 * Ansible template but not in the dev compose file is discovered the hard way,
 * so the four definitions are compared here:
 *
 *   deploy/ansible/roles/llamenos-coturn/templates/compose/coturn.j2   (production)
 *   deploy/docker/docker-compose.yml                                   (compose path)
 *   deploy/docker/docker-compose.dev.yml                               (dev)
 *   deploy/docker/docker-compose.ci.yml                                (CI; `command`
 *       replaces the base file's, it does not merge, so it restates the ACL)
 *
 * What the ACL does when coturn runs — private peers refused, the media server
 * relayed, a real WebRTC leg carrying RTP both ways — was measured live and is
 * recorded in the PR; this test only keeps the four files from drifting apart,
 * and keeps coturn from aborting at start-up on a value it cannot parse.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const DEPLOY = path.resolve(__dirname, '../../..')
const read = (rel: string) => readFileSync(path.join(DEPLOY, rel), 'utf8')

/** Ranges that must be denied. coturn takes `ip-ip`, never CIDR. */
const REQUIRED_DENIED_RANGES = [
  '0.0.0.0-0.255.255.255',
  '10.0.0.0-10.255.255.255', // RFC 1918
  '100.64.0.0-100.127.255.255', // CGNAT, RFC 6598
  '127.0.0.0-127.255.255.255', // loopback
  '169.254.0.0-169.254.255.255', // link-local, incl. the cloud metadata service
  '172.16.0.0-172.31.255.255', // RFC 1918 — every docker bridge
  '192.168.0.0-192.168.255.255', // RFC 1918
  'fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', // ULA
  'fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff', // IPv6 link-local
  '::-::1', // unspecified + loopback
]

interface Acl {
  /** Literal ranges, in file order. */
  ranges: string[]
  /** Denied entries that are a variable/template expression (the relay's own address). */
  denied: string[]
  /** Denied entries written out in the file: every one must be a range coturn can parse. */
  literal: string[]
  allowed: string[]
  flags: string[]
}

/** The `coturn:` service block of a compose file, or the whole template. */
function coturnBlock(text: string): string {
  const start = text.search(/^ {2}coturn:\s*$/m)
  if (start === -1) return text
  const rest = text.slice(start + 1)
  const next = rest.search(/^ {2}[A-Za-z0-9_-]+:\s*$/m)
  return next === -1 ? rest : rest.slice(0, next)
}

function aclOf(text: string): Acl {
  // The command, not the prose around it: comments discuss these flags.
  const code = coturnBlock(text)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#') && !line.trimStart().startsWith('{%'))
    .join('\n')
  // A compose line is `${VAR:+--allowed-peer-ip=${VAR}}`: the flag, without the wrapper.
  const unwrapped = code.replace(/\$\{\w+:\+(--allowed-peer-ip=\$\{\w+\})\}/g, '$1')
  const denied = [...code.matchAll(/--denied-peer-ip=(.+?)\s*$/gm)].map((m) => m[1])
  return {
    ranges: denied.filter((d) => /^[0-9a-f:.]+-[0-9a-f:.]+$/i.test(d)),
    denied: denied.filter((d) => /[${]/.test(d)),
    literal: denied.filter((d) => !/[${]/.test(d)),
    allowed: [...unwrapped.matchAll(/--allowed-peer-ip=(.+?)\s*$/gm)].map((m) => m[1]),
    flags: [...code.matchAll(/(--no-tcp-relay|--no-multicast-peers)\b/g)].map((m) => m[1]),
  }
}

const SOURCES = {
  'ansible coturn.j2': 'ansible/roles/llamenos-coturn/templates/compose/coturn.j2',
  'docker-compose.yml': 'docker/docker-compose.yml',
  'docker-compose.dev.yml': 'docker/docker-compose.dev.yml',
  'docker-compose.ci.yml': 'docker/docker-compose.ci.yml',
} as const

describe('TURN relay peer ACL (#2136)', () => {
  const acls = Object.fromEntries(
    Object.entries(SOURCES).map(([name, rel]) => [name, aclOf(read(rel))]),
  ) as Record<keyof typeof SOURCES, Acl>

  for (const [name, acl] of Object.entries(acls)) {
    describe(name, () => {
      it('denies every private, loopback, link-local and ULA range', () => {
        for (const range of REQUIRED_DENIED_RANGES) expect(acl.ranges).toContain(range)
      })

      it('denies only ranges coturn can parse — it aborts at start-up on CIDR', () => {
        expect(acl.ranges.length).toBeGreaterThan(0)
        // Template/variable entries (the relay's own address) are exempt: a
        // Jinja expression may contain a slash that the rendered value does not.
        for (const entry of acl.literal) expect(entry).not.toContain('/')
      })

      it("denies the relay's own address", () => {
        expect(acl.denied.some((d) => /turn_relay_ip|TURN_RELAY_IP/.test(d))).toBe(true)
      })

      it('turns off TCP relay (RFC 6062) and multicast peers', () => {
        expect(acl.flags).toContain('--no-tcp-relay')
        expect(acl.flags).toContain('--no-multicast-peers')
      })

      it('allows at most one peer — the media server, never a range', () => {
        expect(acl.allowed.length).toBeLessThanOrEqual(1)
        for (const a of acl.allowed) expect(a).not.toMatch(/[-/]/)
      })
    })
  }

  it('denies the same ranges in all four files', () => {
    const reference = [...acls['ansible coturn.j2'].ranges].sort()
    for (const acl of Object.values(acls)) expect([...acl.ranges].sort()).toEqual(reference)
  })

  it('Ansible always names the media server; compose names it when TURN_MEDIA_PEER_IP is set', () => {
    expect(acls['ansible coturn.j2'].allowed).toEqual(['{{ turn_media_peer_ip }}'])
    for (const name of ['docker-compose.yml', 'docker-compose.dev.yml', 'docker-compose.ci.yml'] as const) {
      expect(acls[name].allowed).toEqual(['${TURN_MEDIA_PEER_IP}'])
    }
  })

  it('pins the address the Ansible relay allows to the one Asterisk is given', () => {
    // The relay allows turn_media_peer_ip; if Asterisk's address could drift
    // from it, the allowance would name a container that is not the media
    // server and every relayed call would carry no audio.
    expect(read('ansible/roles/llamenos-asterisk/templates/compose/asterisk.j2')).toMatch(
      /ipv4_address:\s*"\{\{ asterisk_internal_ip \}\}"/,
    )
    for (const vars of ['ansible/vars.yml', 'ansible/vars.example.yml']) {
      const text = read(vars)
      expect(text).toMatch(/^turn_media_peer_ip:\s*"\{\{ asterisk_internal_ip \}\}"/m)
      expect(text).toMatch(/^asterisk_internal_ip:\s*"(\d{1,3}\.){3}\d{1,3}"/m)
      expect(text).toMatch(/^llamenos_internal_subnet:\s*"(\d{1,3}\.){3}\d{1,3}\/\d{1,2}"/m)
    }
    expect(read('ansible/roles/llamenos-coturn/defaults/main.yml')).toMatch(
      /^turn_media_peer_ip:\s*"\{\{ asterisk_internal_ip \}\}"/m,
    )
  })

  it("keeps Asterisk's pinned address inside the subnet and OUTSIDE the dynamic range", () => {
    // Unpinned containers are handed addresses from the range only. If the
    // pinned address were inside it, a container that started first could be
    // given Asterisk's address and inherit the relay's allowance.
    const toInt = (ip: string) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0)
    const inside = (ip: string, cidr: string) => {
      const [base, bits] = cidr.split('/')
      const size = 2 ** (32 - Number(bits))
      return toInt(ip) >= toInt(base) && toInt(ip) < toInt(base) + size
    }
    for (const vars of ['ansible/vars.yml', 'ansible/vars.example.yml']) {
      const text = read(vars)
      const get = (key: string) => text.match(new RegExp(`^${key}:\\s*"([^"]+)"`, 'm'))?.[1] ?? ''
      const subnet = get('llamenos_internal_subnet')
      const range = get('llamenos_internal_ip_range')
      const asterisk = get('asterisk_internal_ip')
      expect(inside(asterisk, subnet)).toBe(true)
      expect(inside(asterisk, range)).toBe(false)
      expect(inside(range.split('/')[0], subnet)).toBe(true)
    }
  })
})
