/**
 * Key backup & recovery — container types and the restore-side file reader.
 *
 * The backup format, both KDFs and the cipher are defined once, in Rust:
 * `packages/crypto/src/backup.rs` (container v4). That module's doc comment is
 * the specification; read it before changing anything here.
 *
 * This file deliberately contains **no cryptography**. It used to hold a second,
 * incompatible implementation (PBKDF2 over the recovery key, `v: 1` container)
 * while Rust wrote a third (HKDF over a hex decode of the key, `v: 3`) — the
 * writer could never produce a file this reader would accept, and the hex decode
 * made the download fail outright (#1709). Reinstating any crypto here
 * re-creates that divergence, and would put device key material back in the
 * webview, which the architecture forbids.
 *
 * Writing a backup:  `generateRecoveryKey()` + `generateBackupFromState()`, then
 *                    `saveBackupFile()`, all from `@/lib/platform`. Rust shows the
 *                    native save dialog and writes the file; an `<a download>`
 *                    click is NOT an option — WebKitGTK writes it silently into
 *                    the process's cwd, with no dialog and no path (#2111).
 * Reading a backup:  `readBackupFile()` here, then `verifyBackupCredential()` /
 *                    `restoreBackupAndLoad()` from `@/lib/platform`.
 *
 * Field names in the file are generic and carry no plaintext device identifier,
 * so a backup found on a seized device does not reveal which application wrote
 * it or whose key it holds.
 */

/** Container version this build reads and writes. Must match Rust's `BACKUP_FORMAT_VERSION`. */
export const BACKUP_FORMAT_VERSION = 4

/** PIN-protected block: Argon2id over the credential, AES-256-GCM. */
interface PinBlock {
  kv: number // KDF version (2 = Argon2id)
  s: string // Argon2id salt (hex)
  m: number // Argon2id memory cost (KiB)
  i: number // Argon2id time cost
  p: number // Argon2id parallelism
  n: string // AES-256-GCM nonce (hex)
  c: string // AES-256-GCM ciphertext (hex)
}

/** Recovery-key-protected block: HKDF-SHA256 over the normalized key, AES-256-GCM. */
interface RecoveryBlock {
  kv: number // KDF version (1 = HKDF-SHA256)
  s: string // HKDF salt (hex)
  n: string // AES-256-GCM nonce (hex)
  c: string // AES-256-GCM ciphertext (hex)
}

export interface BackupFile {
  v: typeof BACKUP_FORMAT_VERSION
  id: string // first 6 hex chars of SHA-256(signing pubkey hex) — identification only
  t: number // unix seconds, rounded to the nearest hour
  d: PinBlock // PIN-protected copy of the signing seed
  r: RecoveryBlock // recovery-key-protected copy of the signing seed
}

function isHex(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && /^[0-9a-f]+$/i.test(value)
}

function isPinBlock(block: unknown): block is PinBlock {
  if (typeof block !== 'object' || block === null) return false
  const b = block as Record<string, unknown>
  return typeof b.kv === 'number' && isHex(b.s) && isHex(b.n) && isHex(b.c)
    && typeof b.m === 'number' && typeof b.i === 'number' && typeof b.p === 'number'
}

function isRecoveryBlock(block: unknown): block is RecoveryBlock {
  if (typeof block !== 'object' || block === null) return false
  const b = block as Record<string, unknown>
  return typeof b.kv === 'number' && isHex(b.s) && isHex(b.n) && isHex(b.c)
}

/**
 * Parse a user-selected backup file.
 *
 * Shape and version are validated here so a wrong or truncated file is rejected
 * before a credential is asked for; the credential itself is checked in Rust.
 * Returns null for anything that is not a v4 backup — including the v1 and v3
 * files older builds could produce, which are not readable by any build (see
 * `packages/crypto/src/backup.rs`, "Compatibility").
 */
export async function readBackupFile(file: File): Promise<BackupFile | null> {
  try {
    const data: unknown = JSON.parse(await file.text())
    if (typeof data !== 'object' || data === null) return null
    const candidate = data as Record<string, unknown>
    if (candidate.v !== BACKUP_FORMAT_VERSION) return null
    if (typeof candidate.id !== 'string' || typeof candidate.t !== 'number') return null
    if (!isPinBlock(candidate.d) || !isRecoveryBlock(candidate.r)) return null
    return candidate as unknown as BackupFile
  } catch {
    return null
  }
}
