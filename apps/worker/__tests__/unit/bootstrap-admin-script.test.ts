/**
 * `bun run bootstrap-admin` must print PUBLIC keys as public keys and keep the
 * secret seed under a clearly marked secret heading (issue #1040).
 *
 * Regression: the script used to print each secret seed under the label
 * "PUBLIC KEY (hex)", so an operator following it configured the admin's
 * secret as ADMIN_PUBKEY / ADMIN_DECRYPTION_PUBKEY — values GET /api/auth/me
 * serves to every authenticated user.
 *
 * No key material is hard-coded: everything is generated per run.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { ed25519 } from '@noble/curves/ed25519.js'
import { hexToBytes } from '@noble/hashes/utils.js'
import { deriveAdminKeys, generateAdminKeys, formatBootstrapOutput } from '../../../../scripts/bootstrap-admin'
import { deviceEncryptionPubkeyFromSigningSeed } from '../../../../tests/crypto-helpers'

const SCRIPT = path.resolve(__dirname, '../../../../scripts/bootstrap-admin.ts')
const HEX64 = /^[0-9a-f]{64}$/

/** Value on the line after the first line that starts with `label`. */
function valueAfter(output: string, label: string): string {
  const lines = output.split('\n')
  const i = lines.findIndex(l => l.startsWith(label))
  expect(i, `label "${label}" missing from output`).toBeGreaterThanOrEqual(0)
  return lines[i + 1].trim()
}

function runScript(): string {
  const r = spawnSync('bun', [SCRIPT], { encoding: 'utf8' })
  expect(r.status, r.stderr).toBe(0)
  return r.stdout
}

/**
 * Label-agnostic regression for #1040: whatever the wording, a value printed
 * under a label that says "public" must not also be printed under a label that
 * says "secret"/"seed". The old script failed this — it printed one 64-hex
 * value under both "PUBLIC KEY (hex):" and "SECRET KEY (seed hex) ...:".
 */
describe('bootstrap-admin output: public vs secret labels (label-agnostic)', () => {
  it('never prints a value under both a public and a secret label', () => {
    const lines = runScript().split('\n')
    const labelled = (re: RegExp): string[] =>
      lines.flatMap((l, i) => (l.trim().endsWith(':') && re.test(l) && HEX64.test((lines[i + 1] ?? '').trim()) ? [lines[i + 1].trim()] : []))
    const publics = labelled(/public/i)
    const secrets = labelled(/secret|seed/i)
    expect(publics.length).toBeGreaterThan(0)
    expect(secrets.length).toBeGreaterThan(0)
    for (const v of publics) expect(secrets).not.toContain(v)
  })
})

describe('bootstrap-admin output (CLI)', () => {
  let out: string, pubkey: string, decryptionPubkey: string, seed: string, serverSecret: string
  beforeAll(() => {
    out = runScript()
    pubkey = valueAfter(out, 'ADMIN_PUBKEY (')
    decryptionPubkey = valueAfter(out, 'ADMIN_DECRYPTION_PUBKEY (')
    seed = valueAfter(out, 'ADMIN SECRET SEED')
    serverSecret = valueAfter(out, 'SERVER_SECRET (')
  })

  it('prints 64-hex values under every label', () => {
    for (const v of [pubkey, decryptionPubkey, seed, serverSecret]) expect(v).toMatch(HEX64)
  })

  it('never prints the secret seed as a public key', () => {
    expect(pubkey).not.toBe(seed)
    expect(decryptionPubkey).not.toBe(seed)
    expect(decryptionPubkey).not.toBe(pubkey)
  })

  it('prints the real Ed25519 public key for the printed seed', () => {
    expect(pubkey).toBe(Buffer.from(ed25519.getPublicKey(hexToBytes(seed))).toString('hex'))
  })

  it('prints the X25519 device-encryption pubkey the desktop client derives from that seed', () => {
    expect(decryptionPubkey).toBe(deviceEncryptionPubkeyFromSigningSeed(seed))
  })

  it('shows secrets only under the SECRET heading, never in the PUBLIC or config sections', () => {
    const secretHeading = out.indexOf('--- SECRET values')
    expect(secretHeading).toBeGreaterThan(0)
    const beforeSecrets = out.slice(0, secretHeading)
    expect(beforeSecrets).not.toContain(seed)
    expect(beforeSecrets).not.toContain(serverSecret)

    // The config block the operator copies into .env must carry no secret seed.
    const nextSteps = out.slice(out.indexOf('--- Next Steps ---'))
    expect(nextSteps).not.toContain(seed)
    expect(nextSteps).toContain(`ADMIN_PUBKEY=${pubkey}`)
    expect(nextSteps).toContain(`ADMIN_DECRYPTION_PUBKEY=${decryptionPubkey}`)
    expect(out).toMatch(/WARNING/)
  })

  it('no longer carries stale Cloudflare / ECIES guidance', () => {
    expect(out).not.toMatch(/wrangler|ECIES|nsec/i)
  })
})

describe('deriveAdminKeys', () => {
  it('derives both public keys from one seed, distinct from the seed and each other', () => {
    const keys = generateAdminKeys()
    expect(new Set([keys.seedHex, keys.identityPubkey, keys.decryptionPubkey]).size).toBe(3)
    expect(keys.identityPubkey).toMatch(HEX64)
    expect(keys.decryptionPubkey).toMatch(HEX64)
  })

  it('matches the client-side derivation for arbitrary seeds', () => {
    for (let i = 0; i < 5; i++) {
      const keys = generateAdminKeys()
      expect(keys.decryptionPubkey).toBe(deviceEncryptionPubkeyFromSigningSeed(keys.seedHex))
    }
  })

  it('rejects a seed that is not 32 bytes', () => {
    expect(() => deriveAdminKeys(new Uint8Array(31))).toThrow(/32 bytes/)
  })

  it('formatBootstrapOutput never places the seed before the SECRET heading', () => {
    const keys = generateAdminKeys()
    const text = formatBootstrapOutput(keys, 'f'.repeat(64))
    expect(text.slice(0, text.indexOf('--- SECRET values'))).not.toContain(keys.seedHex)
  })
})
