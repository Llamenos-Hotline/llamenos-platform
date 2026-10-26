/**
 * Startup configuration validation for the Llamenos worker server.
 *
 * Call validateConfig() at Bun startup (before any service initialization)
 * to catch misconfigured deployments immediately with a clear error message.
 *
 * Required vars are asserted to be non-empty and well-formed.
 * Optional vars log a warning when absent — they disable specific features
 * (push, relay) without failing startup.
 *
 * This is the canonical validation implementation. See spec:
 * docs/superpowers/specs/2026-03-21-hardening-final.md Gap 4.
 */

import fs from 'node:fs'

const HEX_RE = /^[0-9a-f]+$/

/** Where a file-only secret is mounted unless `<NAME>_FILE` points elsewhere (dev, CI). */
const SECRETS_DIR = '/run/secrets'

/**
 * Read a secret that is delivered ONLY as a file, never as an environment
 * variable. The path is `${SECRETS_DIR}/<name>`, or the file named by
 * `<NAME>_FILE` (`ban-hash-key` → `BAN_HASH_KEY_FILE`, `messaging-hash-key` → `MESSAGING_HASH_KEY_FILE`) so dev and CI can point
 * at a scratch file without the value ever entering an env block. Returns
 * undefined when the file does not exist or is empty.
 */
export function readSecretFile(
  name: string,
  env: ConfigInput = process.env,
): string | undefined {
  const override = env[`${name.toUpperCase().replace(/-/g, '_')}_FILE`]?.trim()
  const path = override || `${SECRETS_DIR}/${name}`
  try {
    return fs.readFileSync(path, 'utf-8').trim() || undefined
  } catch {
    return undefined
  }
}

type ConfigInput = Partial<Record<string, string | undefined>>

function assertNonEmpty(env: ConfigInput, key: string): void {
  const val = env[key]
  if (!val || val.trim() === '') {
    throw new Error(
      `[llamenos] Required environment variable ${key} is missing or empty. ` +
      `Set it before starting the server.`
    )
  }
}

function assertHex64(env: ConfigInput, key: string): void {
  assertNonEmpty(env, key)
  const val = env[key]!.trim()
  if (val.length !== 64 || !HEX_RE.test(val)) {
    throw new Error(
      `[llamenos] ${key} must be exactly 64 lowercase hex characters (got length ${val.length}). ` +
      `Generate with: openssl rand -hex 32`
    )
  }
}

const ROLE_SECRETS = ['HMAC_SECRET', 'SERVER_SECRET', 'SERVER_KEK'] as const

/** No two role secrets may share a value: that is a secret with two roles. */
function assertDistinctSecrets(env: ConfigInput): void {
  for (let i = 0; i < ROLE_SECRETS.length; i++) {
    for (let j = i + 1; j < ROLE_SECRETS.length; j++) {
      const a = env[ROLE_SECRETS[i]!]?.trim()
      const b = env[ROLE_SECRETS[j]!]?.trim()
      if (a && a === b) {
        throw new Error(
          `[llamenos] ${ROLE_SECRETS[i]} and ${ROLE_SECRETS[j]} are identical. Each server ` +
          `secret has exactly one role; generate a separate value for each with: openssl rand -hex 32`
        )
      }
    }
  }
}

/**
 * Keys that are delivered only as a secret FILE, never as an environment
 * variable. Each keys one hash of a phone number or contact identifier; kept out
 * of `.env`, so out of every config backup, because a hash under a key the
 * database holds is reversible by anyone who reads the database. Supplying one
 * as an environment variable is refused rather than quietly accepted.
 */
const FILE_ONLY_KEYS = [
  { file: 'ban-hash-key', env: 'BAN_HASH_KEY', role: 'the ban-list hash' },
  { file: 'messaging-hash-key', env: 'MESSAGING_HASH_KEY', role: 'the messaging-thread hash' },
] as const

function assertFileOnlyKey(
  key: (typeof FILE_ONLY_KEYS)[number],
  env: ConfigInput,
  readFile: (name: string) => string | undefined,
): string {
  if (env[key.env]?.trim()) {
    throw new Error(
      `[llamenos] ${key.env} must not be set as an environment variable. Deliver it only as ` +
      `the /run/secrets/${key.file} secret file, so it never lands in .env or a config backup.`
    )
  }
  const val = readFile(key.file)
  if (!val) {
    throw new Error(
      `[llamenos] Required secret file ${key.file} is missing or empty. Mount it at ` +
      `/run/secrets/${key.file} (or point ${key.env}_FILE at it). Generate with: openssl rand -hex 32`
    )
  }
  if (val.length !== 64 || !HEX_RE.test(val)) {
    throw new Error(
      `[llamenos] ${key.file} must be exactly 64 lowercase hex characters (got length ${val.length}). ` +
      `Generate with: openssl rand -hex 32`
    )
  }
  for (const other of ROLE_SECRETS) {
    if (env[other]?.trim() === val) {
      throw new Error(`[llamenos] ${key.file} and ${other} are identical. Each server secret has exactly one role.`)
    }
  }
  return val
}

/** Every file-only key, validated, and no two of them equal: each keys one hash and nothing else. */
function assertFileOnlyKeys(env: ConfigInput, readFile: (name: string) => string | undefined): void {
  const seen = new Map<string, string>()
  for (const key of FILE_ONLY_KEYS) {
    const val = assertFileOnlyKey(key, env, readFile)
    const clash = seen.get(val)
    if (clash) {
      throw new Error(`[llamenos] ${clash} and ${key.file} are identical. Each server secret has exactly one role.`)
    }
    seen.set(val, key.file)
  }
}

function assertDatabaseUrl(env: ConfigInput): void {
  assertNonEmpty(env, 'DATABASE_URL')
  const val = env['DATABASE_URL']!.trim()
  if (!val.startsWith('postgres://') && !val.startsWith('postgresql://')) {
    throw new Error(
      `[llamenos] DATABASE_URL must start with postgres:// or postgresql:// (got: ${val.slice(0, 20)}...)`
    )
  }
}

import { createLogger } from './logger'
import { MIN_DEPLOYED_SECRET_LENGTH } from './dev-surfaces'

const logger = createLogger('config')

function warnIfAbsent(env: ConfigInput, key: string, featureNote: string): void {
  if (!env[key]?.trim()) {
    logger.warn(`Optional ${key} not set — ${featureNote}`)
  }
}

/**
 * Validate all required environment variables for the Llamenos worker server.
 * Throws a descriptive Error for any missing or malformed required var.
 * Logs warnings for absent optional vars.
 *
 * @param env - Environment object to validate (defaults to process.env).
 */
export function validateConfig(
  env: ConfigInput = process.env,
  readFile: (name: string) => string | undefined = (name) => readSecretFile(name, env),
): void {
  // --- Required vars ---
  assertDatabaseUrl(env)
  // One role per secret (D6, #2171): HMAC_SECRET only hashes, SERVER_KEK only
  // encrypts data the server must read back, SERVER_SECRET derives the relay and
  // server identity keys. A deployment that supplies one value for two roles
  // couples their rotations and their blast radius.
  assertHex64(env, 'HMAC_SECRET')
  assertHex64(env, 'SERVER_SECRET')
  assertHex64(env, 'SERVER_KEK')
  assertDistinctSecrets(env)
  assertFileOnlyKeys(env, readFile)

  // ADMIN_PUBKEY: 64 hex chars (Ed25519 public key, hex-encoded)
  // Optional: if not set, the first admin is bootstrapped via the Tauri desktop app.
  const adminPubkey = env['ADMIN_PUBKEY']?.trim() ?? ''
  if (adminPubkey.length > 0 && (adminPubkey.length !== 64 || !HEX_RE.test(adminPubkey))) {
    throw new Error(
      `[llamenos] ADMIN_PUBKEY must be exactly 64 hex characters (Ed25519 public key). Got length ${adminPubkey.length}. ` +
      `Generate with: bun run bootstrap-admin`
    )
  }
  if (adminPubkey.length === 0) {
    logger.warn('ADMIN_PUBKEY not set — first admin must be bootstrapped via the Tauri desktop app')
  }

  // --- The admin's HPKE recipient key (#1283) ---
  //
  // ADMIN_PUBKEY is Ed25519: it verifies the admin's request signatures.
  // ADMIN_DECRYPTION_PUBKEY is X25519: it is the HPKE recipient that note,
  // message and hub-key envelopes are sealed to. `bun run bootstrap-admin`
  // derives both from one seed and prints both.
  //
  // These assertions exist because the consequence of getting it wrong is
  // invisible. DHKEM(X25519) accepts any 32 bytes as a recipient key, so
  // sealing to the Ed25519 key succeeds and yields an envelope no secret key
  // can open — every note written on such a deployment is lost, with no error
  // at write time and none at read time. A server that cannot name a correct
  // recipient must refuse to start rather than accept work it will destroy.
  const adminDecryptionPubkey = env['ADMIN_DECRYPTION_PUBKEY']?.trim() ?? ''
  if (adminDecryptionPubkey.length > 0 &&
      (adminDecryptionPubkey.length !== 64 || !HEX_RE.test(adminDecryptionPubkey))) {
    throw new Error(
      `[llamenos] ADMIN_DECRYPTION_PUBKEY must be exactly 64 lowercase hex characters ` +
      `(the admin's X25519 encryption public key). Got length ${adminDecryptionPubkey.length}. ` +
      `Generate with: bun run bootstrap-admin`
    )
  }
  // Equal values mean one key was copied into both slots. Whichever it is, one
  // of the two uses is wrong, and if it is the Ed25519 key then every admin
  // envelope on this deployment is unopenable.
  if (adminDecryptionPubkey.length > 0 && adminDecryptionPubkey === adminPubkey) {
    throw new Error(
      `[llamenos] ADMIN_DECRYPTION_PUBKEY is identical to ADMIN_PUBKEY. They are different ` +
      `keys for different algorithms: ADMIN_PUBKEY is Ed25519 (signature verification), ` +
      `ADMIN_DECRYPTION_PUBKEY is X25519 (the HPKE recipient admin envelopes are sealed to). ` +
      `Sealing to the Ed25519 key produces envelopes nobody can decrypt. ` +
      `Run: bun run bootstrap-admin — it prints both values, derived from one seed.`
    )
  }
  if (adminPubkey.length > 0 && adminDecryptionPubkey.length === 0) {
    throw new Error(
      `[llamenos] ADMIN_PUBKEY is set but ADMIN_DECRYPTION_PUBKEY is missing or empty. ` +
      `The admin cannot be a recipient of any encrypted note, message or hub key without it, ` +
      `and the server will not substitute ADMIN_PUBKEY — that is an Ed25519 signing key, not ` +
      `an X25519 HPKE recipient, and envelopes sealed to it are silently undecryptable forever. ` +
      `Run: bun run bootstrap-admin and set BOTH values it prints.`
    )
  }

  assertNonEmpty(env, 'HOTLINE_NAME')
  assertNonEmpty(env, 'ENVIRONMENT')

  // Required because the server cannot boot without them, not because a
  // feature wants them: `src/server/index.ts` builds its env with
  // `BLOB_STORAGE: createBlobStorage()` as a plain property, and
  // `createBlobStorage` (lib/blob-storage.ts) throws outright when either is
  // absent.
  //
  // Before this, they were absent from the validator, so a deployment missing
  // them passed every check here, logged "Database initialized", "Services
  // initialized" and "Default settings, roles and platform admin ensured" —
  // i.e. ran its migrations and seeded its admin — and only THEN died with a
  // raw stack trace from a factory. The three preceding lines read as
  // success and the only warnings were about unrelated optional features
  // (webhooks, push), so it did not look like a configuration problem at all.
  // Deployed configs all set these (docker-compose, Helm, the Ansible env
  // template), which is why it never bit in CI: it bites whoever assembles
  // their own env, i.e. a self-hoster. #1438.
  //
  // STORAGE_ENDPOINT stays optional — `createBlobStorage` defaults it to
  // http://localhost:9000 and that default is harmless.
  assertNonEmpty(env, 'STORAGE_ACCESS_KEY')
  assertNonEmpty(env, 'STORAGE_SECRET_KEY')

  const environment = env['ENVIRONMENT']?.trim() ?? ''

  // --- Dev-surface production gate ---
  // The /api/test-* routes reset the database, delete the admin and promote
  // arbitrary pubkeys. lib/dev-surfaces.ts already refuses to SERVE them under
  // ENVIRONMENT=production, and deploy/ansible refuses to RENDER the vars for a
  // production host. This is the third, independent layer: a production process
  // configured with them refuses to start at all, rather than running with a
  // disabled-but-configured backdoor nobody notices until the guard regresses.
  const devRoutesEnabled = env['DEV_ROUTES_ENABLED']?.trim() === 'true'
  const devSecret = (env['DEV_RESET_SECRET'] ?? env['E2E_TEST_SECRET'] ?? '').trim()
  if (environment === 'production' && (devRoutesEnabled || devSecret.length > 0)) {
    const offenders = [
      devRoutesEnabled ? 'DEV_ROUTES_ENABLED=true' : null,
      env['DEV_RESET_SECRET']?.trim() ? 'DEV_RESET_SECRET' : null,
      env['E2E_TEST_SECRET']?.trim() ? 'E2E_TEST_SECRET' : null,
    ].filter(Boolean).join(', ')
    throw new Error(
      `[llamenos] CRITICAL: ${offenders} is set in a production environment. ` +
      'Those variables exist only to let the end-to-end suite reset a throwaway ' +
      'staging target; on production they configure a destructive backdoor. ' +
      'Remove them, or set ENVIRONMENT=staging if this host really is the test target.',
    )
  }
  // A reachable dev surface without a strong secret is the failure mode the
  // length minimum exists for; say so at startup rather than letting every
  // /api/test-* request 404 for a reason nobody can see.
  if (devRoutesEnabled && environment !== 'development' && devSecret.length < MIN_DEPLOYED_SECRET_LENGTH) {
    throw new Error(
      `[llamenos] DEV_ROUTES_ENABLED=true on ENVIRONMENT=${environment} requires ` +
      `DEV_RESET_SECRET of at least ${MIN_DEPLOYED_SECRET_LENGTH} characters ` +
      `(got ${devSecret.length}). The /api/test-* surface is reachable on a deployed ` +
      'host, so it may not be served without a strong shared secret. ' +
      'Generate one with: openssl rand -hex 32',
    )
  }

  // --- Production-required vars ---
  if (environment === 'production' && !env['WEBHOOK_BASE_URL']?.trim()) {
    throw new Error(
      '[llamenos] WEBHOOK_BASE_URL is required in production. ' +
      'Without it, webhook signature validation falls back to the spoofable Host header. ' +
      'Set WEBHOOK_BASE_URL to your public base URL (e.g. https://api.llamenos-hotline.org).'
    )
  }

  // --- Optional vars (warn when absent, do not fail) ---
  warnIfAbsent(env, 'WEBHOOK_BASE_URL', 'webhook signature validation uses request Host header (vulnerable to Host header spoofing — set WEBHOOK_BASE_URL in production)')
  // WebSocket relay is in-process — no external relay URL needed
  warnIfAbsent(env, 'NTFY_URL', 'Android push notifications disabled (ntfy/UnifiedPush); also set NTFY_PUBLIC_URL when NTFY_URL is an internal address — device endpoints are only accepted on configured origins')
  warnIfAbsent(env, 'APNS_KEY_P8', 'iOS push notifications disabled')
  warnIfAbsent(env, 'APNS_KEY_ID', 'iOS push notifications disabled')
  warnIfAbsent(env, 'APNS_TEAM_ID', 'iOS push notifications disabled')

  // --- Webhook IP allowlist (#1622) ---
  // middleware/webhook-auth.ts, middleware/webhook-ip-allowlist.ts and
  // messaging/router.ts each read `<PROVIDER>_WEBHOOK_IPS` and return next()
  // when it is absent, so an unconfigured allowlist is indistinguishable at
  // request time from one that passed. Nothing rendered the var on any deploy
  // path before #1624, so the control had never run anywhere, and nothing
  // said so. This does not change the semantics -- whether unset should fail
  // closed, or require an explicit opt-out, is #1622's decision -- it only
  // makes the state visible at boot, where an operator can act on it.
  if (!Object.keys(env).some((k) => k.endsWith('_WEBHOOK_IPS') && env[k]?.trim())) {
    logger.warn(
      'No <PROVIDER>_WEBHOOK_IPS configured — inbound webhooks are authenticated by ' +
      'provider signature alone and the IP allowlist middleware is inert. Set it per ' +
      'provider (Ansible: webhook_ip_allowlists) to switch the control on.',
    )
  }
}
