#!/usr/bin/env bun
/**
 * Bootstrap the first admin user (CLI method).
 *
 * Generates ONE 32-byte Ed25519 signing seed and derives BOTH public keys the
 * server needs from it — exactly the way the desktop client derives them when
 * the operator imports that seed (`device_import_and_load`,
 * apps/desktop/src/crypto.rs:1011-1038):
 *
 *   identityPubkey   = Ed25519(seed)
 *   encryptionSeed   = HKDF-SHA256(ikm = seed, salt = none,
 *                                  info = LABEL_DEVICE_ENCRYPTION_SEED)
 *   decryptionPubkey = X25519(encryptionSeed)
 *
 * There is exactly ONE secret: the signing seed. The identity key authenticates
 * requests (Ed25519 signatures, `apps/worker/lib/auth.ts`); the derived X25519
 * key is the HPKE recipient that note/message/hub-key envelopes are sealed to.
 * Deriving the second key rather than generating it independently is not a
 * convenience — the client has no way to import a second, unrelated seed, so an
 * independently generated decryption key produces envelopes nobody can open.
 *
 * The printed report puts the two PUBLIC values first, under labels that say
 * "public", and the secrets after a SECRET heading (#1040). The regression that
 * forces that layout: the script used to print the secret seed under the label
 * "PUBLIC KEY (hex)", so an operator following it configured the admin's secret
 * as ADMIN_PUBKEY — a value GET /api/auth/me serves to every authenticated user.
 *
 * NOTE: The recommended approach is in-app bootstrap — open the deployed app
 * and the setup wizard generates the keypair for you. This CLI script is for
 * headless/CI setups where that is not available.
 *
 * Usage:
 *   bun run scripts/bootstrap-admin.ts
 */

import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { LABEL_DEVICE_ENCRYPTION_SEED } from '@shared/crypto-labels'

/** The one secret and the two public values the server is configured with. */
export interface AdminBootstrapKeys {
  /** The ONLY secret. 32-byte Ed25519 signing seed, hex. Never leaves the operator. */
  seedHex: string
  /** `ADMIN_PUBKEY` — Ed25519 verifying key, hex. Safe to put in server config. */
  identityPubkey: string
  /** `ADMIN_DECRYPTION_PUBKEY` — X25519 HPKE recipient key, hex. Safe to put in server config. */
  decryptionPubkey: string
}

/**
 * Derive the admin's public keys from a signing seed.
 *
 * Kept separate from generation so the derivation can be tested against known
 * vectors: the bug this replaces returned the SEED as the public key, which no
 * test could catch while generation and derivation were the same step.
 */
export function deriveAdminKeys(seed: Uint8Array): AdminBootstrapKeys {
  if (seed.length !== 32) {
    throw new Error(`signing seed must be 32 bytes, got ${seed.length}`)
  }
  const encryptionSeed = hkdf(
    sha256,
    seed,
    new Uint8Array(0),
    new TextEncoder().encode(LABEL_DEVICE_ENCRYPTION_SEED),
    32,
  )
  return {
    seedHex: bytesToHex(seed),
    identityPubkey: bytesToHex(ed25519.getPublicKey(seed)),
    decryptionPubkey: bytesToHex(x25519.getPublicKey(encryptionSeed)),
  }
}

/** Generate a fresh admin signing seed and derive its public keys. */
export function generateAdminKeys(): AdminBootstrapKeys {
  return deriveAdminKeys(crypto.getRandomValues(new Uint8Array(32)))
}

/**
 * Render the operator-facing output.
 *
 * Returned as a string rather than printed so a test can assert on exactly what
 * an operator is told to copy — in particular that the secret seed is never
 * offered as a value to put in server config, and that nothing secret appears
 * before the SECRET heading.
 */
export function formatBootstrapOutput(keys: AdminBootstrapKeys, serverSecret: string): string {
  return `=== Llámenos Admin Bootstrap ===

Generated one admin signing seed and derived the public keys from it.

--- PUBLIC values — these go in the server config ---

ADMIN_PUBKEY (Ed25519 identity public key, hex):
  ${keys.identityPubkey}

ADMIN_DECRYPTION_PUBKEY (X25519 HPKE recipient public key, hex):
  ${keys.decryptionPubkey}

--- SECRET values — NEVER put these in server config, a vault, CI, or a ticket ---

ADMIN SECRET SEED (hex) — the admin logs in and decrypts with THIS:
  ${keys.seedHex}

SERVER_SECRET (hex) — server-side only; signs WebSocket relay events:
  ${serverSecret}

WARNING: the admin seed is the ONLY admin secret, and anyone holding it IS the
admin — they can impersonate them and read every note. The server never needs
it. Store it in the operator's password manager; it cannot be recovered.
SERVER_SECRET is different: it is a server secret, not an operator secret — the
server derives its own Ed25519 event-signing keypair from it, and it belongs in
the vault alongside the other server configuration.

--- Next Steps ---

1. Ansible-managed deploy — set these in the host vars / vault
   (deploy/ansible/templates/env/_worker-required-env.j2 renders them into the
   worker container's .env):

     admin_pubkey: ${keys.identityPubkey}
     server_secret: ${serverSecret}          # vault-encrypt this

   ADMIN_DECRYPTION_PUBKEY is not rendered by that template today; set it on the
   container directly (step 2) if you need a decryption key distinct from
   ADMIN_PUBKEY.

2. Plain Docker Compose deploy — add to the worker container's .env:

     ADMIN_PUBKEY=${keys.identityPubkey}
     ADMIN_DECRYPTION_PUBKEY=${keys.decryptionPubkey}
     SERVER_SECRET=${serverSecret}

3. Local development — the same three lines in the repo's .env (gitignored).

4. Log in: open the app and import the ADMIN SECRET SEED above. The client
   re-derives both public keys from it, so they will match the server config.

This backend is Bun + PostgreSQL, not a serverless edge runtime: no secrets are
pushed with a provider CLI, and there is no edge config under apps/worker.
`
}

if (import.meta.main) {
  const keys = generateAdminKeys()
  const serverSecret = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  console.log(formatBootstrapOutput(keys, serverSecret))
}
