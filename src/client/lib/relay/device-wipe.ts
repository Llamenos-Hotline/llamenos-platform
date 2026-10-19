/**
 * Remote device wipe: verification and execution (#1093).
 *
 * The server sends a wipe as a top-level relay frame, never as an encrypted hub
 * event (`apps/worker/lib/ws-manager.ts` `sendSignedWipeToUser`):
 *
 *   `{type:"device:wipe", targetUserId?, targetDevicePubkey?, reason, timestamp, sig, ts}`
 *
 * `sig` is the server's Ed25519 signature over the UTF-8 string
 * `"{WS_PROTOCOL_VERSION}:device:wipe:{target}:{ts}"`, where `target` is the key the
 * server routed the frame by — the signing pubkey this device authenticated the
 * relay socket with. Verifying against *our own* authenticated pubkey binds the
 * command to this device: a wipe signed for anyone else fails.
 *
 * Every check fails closed. A destructive command that cannot be verified — a bad
 * or missing signature, a stale or future timestamp, a target naming another
 * device — is dropped. Mirrors Android's `DeviceWipeVerifier`.
 */
import { z } from 'zod'
import { WS_PROTOCOL_VERSION } from '@protocol/schemas/ws-messages'
import { bytesToHex, utf8ToBytes } from '@shared/encoding'
import { wipeKey } from '../key-manager'

export const DEVICE_WIPE_REASONS = ['user-erasure', 'device-revocation', 'admin-erasure'] as const
export type DeviceWipeReason = (typeof DEVICE_WIPE_REASONS)[number]

/** A wipe older than this is refused, bounding replay of a captured frame. */
export const DEVICE_WIPE_MAX_AGE_MS = 5 * 60 * 1000

/** Tolerated clock skew for a timestamp in the future (matches `packages/crypto/src/erasure.rs`). */
export const DEVICE_WIPE_CLOCK_SKEW_MS = 30_000

const deviceWipeFrameSchema = z.object({
  type: z.literal('device:wipe'),
  sig: z.string().regex(/^[0-9a-f]{128}$/i),
  ts: z.number().int().nonnegative(),
  reason: z.string().optional(),
  targetUserId: z.string().optional(),
  targetDevicePubkey: z.string().optional(),
})

/** A wipe that passed {@link verifyDeviceWipe} — the only shape that reaches {@link executeDeviceWipe}. */
export interface DeviceWipeCommand {
  /** Display-only: the server's signature does not cover it. */
  reason: DeviceWipeReason
}

export interface DeviceWipeVerificationContext {
  /** The signing pubkey this device authenticated the relay socket with. */
  devicePubkey: string
  /** The server's Ed25519 key, from `GET /api/config`. */
  serverPubkey: string
  nowMs: number
  verify: (messageHex: string, signatureHex: string, pubkeyHex: string) => Promise<boolean>
}

/** True for any frame claiming to be a wipe, before any verification. */
export function isDeviceWipeFrame(data: unknown): boolean {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'device:wipe'
}

/** Returns the verified command, or null when any check fails. */
export async function verifyDeviceWipe(
  frame: unknown,
  ctx: DeviceWipeVerificationContext,
): Promise<DeviceWipeCommand | null> {
  if (!ctx.devicePubkey || !ctx.serverPubkey) return null

  const parsed = deviceWipeFrameSchema.safeParse(frame)
  if (!parsed.success) return null
  const { sig, ts, reason, targetUserId, targetDevicePubkey } = parsed.data

  // A target the frame names explicitly must be this device. Neither field is
  // covered by the signature, but a mismatch means the command is not for us.
  if (targetDevicePubkey !== undefined && targetDevicePubkey !== ctx.devicePubkey) return null
  if (targetUserId !== undefined && targetUserId !== ctx.devicePubkey) return null

  if (ts > ctx.nowMs + DEVICE_WIPE_CLOCK_SKEW_MS) return null
  if (ctx.nowMs - ts > DEVICE_WIPE_MAX_AGE_MS) return null

  const message = `${WS_PROTOCOL_VERSION}:device:wipe:${ctx.devicePubkey}:${ts}`
  let valid: boolean
  try {
    valid = await ctx.verify(bytesToHex(utf8ToBytes(message)), sig, ctx.serverPubkey)
  } catch {
    return null
  }
  if (!valid) return null

  return { reason: DEVICE_WIPE_REASONS.find((r) => r === reason) ?? 'admin-erasure' }
}

/**
 * Destroy this device's keys and local state, then tell the UI. Only ever called
 * with a {@link DeviceWipeCommand}.
 */
export async function executeDeviceWipe(command: DeviceWipeCommand): Promise<void> {
  try {
    await wipeKey()
  } catch (err) {
    console.error('[relay] Device wipe: key wipe failed', err)
  }

  try { localStorage.clear() } catch { /* storage unavailable */ }
  try { sessionStorage.clear() } catch { /* storage unavailable */ }

  try {
    if (typeof indexedDB !== 'undefined') {
      const dbs = await indexedDB.databases?.()
      for (const db of dbs ?? []) {
        if (db.name) indexedDB.deleteDatabase(db.name)
      }
    }
  } catch { /* IndexedDB unavailable */ }

  window.dispatchEvent(new CustomEvent('device:wiped', { detail: { reason: command.reason } }))
}
