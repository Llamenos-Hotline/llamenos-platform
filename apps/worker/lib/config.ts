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

const HEX_RE = /^[0-9a-f]+$/

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
export function validateConfig(env: ConfigInput = process.env): void {
  // --- Required vars ---
  assertDatabaseUrl(env)
  assertHex64(env, 'HMAC_SECRET')
  assertHex64(env, 'SERVER_SECRET')

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

  // --- Demo mode production gate ---
  // DEMO_MODE=true in a production environment would allow scheduled data destruction.
  // Hard-fail at startup to prevent accidental misconfiguration.
  const demoMode = env['DEMO_MODE']?.trim() === 'true'
  const environment = env['ENVIRONMENT']?.trim() ?? ''
  if (demoMode) {
    if (environment === 'production') {
      throw new Error(
        '[llamenos] CRITICAL: DEMO_MODE=true is set in a production environment. ' +
        'This would allow scheduled destruction of all application data. ' +
        'Remove DEMO_MODE from your production environment configuration immediately.',
      )
    }
    if (environment !== 'development' && environment !== 'staging' && environment !== 'demo') {
      logger.error(
        'CRITICAL: DEMO_MODE=true detected in unrecognized environment "%s". ' +
        'Demo mode should only run in development, staging, or demo environments. ' +
        'Verify your environment configuration before proceeding.',
        environment,
      )
    }
    const confirm = env['DEMO_MODE_CONFIRM']?.trim()
    if (confirm !== 'DESTROY_ALL_DATA') {
      throw new Error(
        '[llamenos] DEMO_MODE=true requires DEMO_MODE_CONFIRM=DESTROY_ALL_DATA. ' +
        'This two-factor confirmation prevents accidental data destruction. ' +
        'Set DEMO_MODE_CONFIRM=DESTROY_ALL_DATA alongside DEMO_MODE=true.',
      )
    }
    logger.warn(
      'DEMO_MODE is enabled — scheduled data resets are active. ' +
      'This server will periodically destroy all application data.',
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
}
