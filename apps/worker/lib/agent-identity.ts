/**
 * Agent identity management — generate and unseal X25519 keypairs for
 * automated agents (firehose inference agents).
 *
 * The agent's one job with its key is to OPEN HPKE envelopes (window keys and
 * legacy buffer envelopes sealed to `agentPubkey`), so it is an X25519
 * encryption key, never an Ed25519 signing key. DHKEM(X25519) accepts any 32
 * bytes as a recipient key, so sealing to an Ed25519 pubkey "works" and yields
 * ciphertext no secret key can open (#1288, same class as #1283). The agent
 * never signs anything, so it has no Ed25519 key at all — PROTOCOL §2.11
 * forbids deriving one key from the other.
 *
 * Agent private keys are sealed using a deploy-level secret key via HKDF + AES-256-GCM.
 * The agentId is used as HKDF salt for key isolation between agents.
 */
import { gcm } from '@noble/ciphers/aes.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { hpkeRecipientPubkey, type HpkeRecipientPubkey } from './hpke-recipient'

/**
 * Generate a random X25519 keypair for an agent, sealing the private key
 * under a deploy-level secret key.
 *
 * @param agentId   Stable identifier for this agent instance (e.g. connection UUID)
 * @param sealKey   Hex-encoded 32-byte deploy secret (FIREHOSE_AGENT_SEAL_KEY)
 * @param sealLabel Domain separation constant (from crypto-labels.ts)
 * @returns pubkey (hex, 32 bytes, an HPKE recipient) and sealedAgentKey (hex nonce || ciphertext)
 */
export function generateAgentKeypair(
  agentId: string,
  sealKey: string,
  sealLabel: string,
): { pubkey: HpkeRecipientPubkey; sealedAgentKey: string } {
  // Generate a random X25519 keypair — the key HPKE seals to and opens with
  const agentSecretKey = x25519.utils.randomSecretKey()
  const pubkeyBytes = x25519.getPublicKey(agentSecretKey)
  const pubkey = hpkeRecipientPubkey(bytesToHex(pubkeyBytes))
  if (!pubkey) throw new Error('generateAgentKeypair: X25519 public key is not 32 bytes')
  const agentSecretKeyHex = bytesToHex(agentSecretKey)

  // Derive per-agent seal key via HKDF
  const sealKeyBytes = hexToBytes(sealKey)
  const derivedKey = hkdf(
    sha256,
    sealKeyBytes,
    new TextEncoder().encode(agentId),
    new TextEncoder().encode(sealLabel),
    32,
  )

  // Seal the X25519 secret key (hex) with AES-256-GCM
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const cipher = gcm(derivedKey, nonce)
  const sealed = cipher.encrypt(new TextEncoder().encode(agentSecretKeyHex))

  // Encode as hex: nonce || ciphertext
  const sealedAgentKey = bytesToHex(nonce) + bytesToHex(sealed)

  // Zero the raw secret key from memory
  agentSecretKey.fill(0)

  return { pubkey, sealedAgentKey }
}

/**
 * Unseal an agent X25519 secret key that was previously sealed with generateAgentKeypair.
 *
 * @param agentId        Must match the agentId used during sealing
 * @param sealedAgentKey  Hex-encoded nonce || ciphertext blob
 * @param sealKey        Hex-encoded 32-byte deploy secret
 * @param sealLabel      Must match the sealLabel used during sealing
 * @returns Hex-encoded X25519 secret key (32 bytes)
 * @throws If authentication tag verification fails
 */
export function unsealAgentKey(
  agentId: string,
  sealedAgentKey: string,
  sealKey: string,
  sealLabel: string,
): string {
  const sealKeyBytes = hexToBytes(sealKey)
  const derivedKey = hkdf(
    sha256,
    sealKeyBytes,
    new TextEncoder().encode(agentId),
    new TextEncoder().encode(sealLabel),
    32,
  )

  const combined = hexToBytes(sealedAgentKey)
  const nonce = combined.slice(0, 12)
  const ciphertext = combined.slice(12)

  const cipher = gcm(derivedKey, nonce)
  const decrypted = cipher.decrypt(ciphertext)
  return new TextDecoder().decode(decrypted)
}
