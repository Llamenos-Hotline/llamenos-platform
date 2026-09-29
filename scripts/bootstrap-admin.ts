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
 * offered as a value to put in server config.
 */
export function formatBootstrapOutput(keys: AdminBootstrapKeys, serverSecret: string): string {
  return `=== Llámenos Admin Bootstrap ===

Generated one admin signing seed and derived the public keys from it.

--- SECRET — keep on this machine only ---

ADMIN SIGNING SEED (hex) — the admin logs in and decrypts with THIS:
  ${keys.seedHex}

  This is the ONLY secret. Do NOT put it in the server's environment, the
  Ansible vault, a .env file, CI, or a ticket. The server never needs it, and
  anything holding it can impersonate the admin and read every note.
  Store it in the operator's password manager. It cannot be recovered.

--- PUBLIC — these go in the server config ---

ADMIN_PUBKEY (Ed25519 identity, hex):
  ${keys.identityPubkey}

ADMIN_DECRYPTION_PUBKEY (X25519 HPKE recipient, hex):
  ${keys.decryptionPubkey}

SERVER_SECRET (hex) — server-side only; signs WebSocket relay events:
  ${serverSecret}

  SERVER_SECRET is a server secret, not an operator secret: the server derives
  its own Ed25519 event-signing keypair from it. It belongs in the vault.

--- Next Steps ---

1. Ansible-managed deploy — set these in the host vars / vault
   (deploy/ansible/templates/env/_worker-required-env.j2 renders them into the
   worker container's .env):

     admin_pubkey: ${keys.identityPubkey}
     admin_decryption_pubkey: ${keys.decryptionPubkey}
     server_secret: ${serverSecret}          # vault-encrypt this

   Both public keys are required: the server refuses to start with admin_pubkey
   set and admin_decryption_pubkey missing, rather than seal admin envelopes to
   the Ed25519 signing key and produce ciphertext nobody can decrypt (#1283).

2. Plain Docker Compose deploy — add to the worker container's .env:

     ADMIN_PUBKEY=${keys.identityPubkey}
     ADMIN_DECRYPTION_PUBKEY=${keys.decryptionPubkey}
     SERVER_SECRET=${serverSecret}

3. Local development — the same three lines in the repo's .env (gitignored).

4. Log in: open the app and import the ADMIN SIGNING SEED above. The client
   re-derives both public keys from it, so they will match the server config.

This backend is Bun + PostgreSQL. It is not a Cloudflare Worker, there is no
wrangler config under apps/worker, and no secrets are pushed with wrangler.
`
}

if (import.meta.main) {
  const keys = generateAdminKeys()
  const serverSecret = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  console.log(formatBootstrapOutput(keys, serverSecret))
}
