/**
 * Reader-side guards for the v4 backup container.
 *
 * This file deliberately does NOT test backup cryptography: there is none in
 * the webview any more. The format round-trip — generate a recovery key, write
 * a backup, read it back, recover the seed — is proven against the real Rust
 * codec in `packages/crypto/src/backup.rs` (`mod tests`), because a test that
 * can pass under the Tauri IPC mock cannot see the defect this fixed (#1709).
 *
 * What is testable here is the file gate: `readBackupFile` must reject the v1
 * and v3 containers older builds emitted, so a user who finds one is told the
 * file is unreadable instead of being asked for a credential that can never
 * work.
 */

import { describe, it, expect } from 'vitest'
import { readBackupFile, BACKUP_FORMAT_VERSION, type BackupFile } from './backup'

function asFile(content: unknown): File {
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  return new File([text], 'backup-deadbeef.json', { type: 'application/json' })
}

function v4(): BackupFile {
  return {
    v: BACKUP_FORMAT_VERSION,
    id: 'a1b2c3',
    t: 1_760_000_400,
    d: { kv: 2, s: 'aa'.repeat(32), m: 65_536, i: 3, p: 4, n: 'bb'.repeat(12), c: 'cc'.repeat(48) },
    r: { kv: 1, s: 'dd'.repeat(32), n: 'ee'.repeat(12), c: 'ff'.repeat(48) },
  }
}

describe('readBackupFile', () => {
  it('accepts a v4 container', async () => {
    expect(await readBackupFile(asFile(v4()))).toEqual(v4())
  })

  it('rejects the v1 container the old TypeScript writer produced', async () => {
    const v1 = {
      v: 1,
      id: 'a1b2c3',
      t: 1_760_000_400,
      d: { s: 'aa'.repeat(16), i: 600_000, n: 'bb'.repeat(12), c: 'cc'.repeat(48) },
      r: { s: 'dd'.repeat(16), i: 100_000, n: 'ee'.repeat(12), c: 'ff'.repeat(48) },
    }
    expect(await readBackupFile(asFile(v1))).toBeNull()
  })

  it('rejects the v3 container the old Rust writer produced', async () => {
    const v3 = {
      v: 3,
      deviceId: 'd3b07384-d9a0-4f1b-9c2e-000000000000',
      signingPubkeyHex: '11'.repeat(32),
      encryptionPubkeyHex: '22'.repeat(32),
      encryptedPayload: '33'.repeat(76),
    }
    expect(await readBackupFile(asFile(v3))).toBeNull()
  })

  it('rejects a v4 container with a missing or malformed block', async () => {
    const noRecovery: Record<string, unknown> = { ...v4() }
    delete noRecovery.r
    expect(await readBackupFile(asFile(noRecovery))).toBeNull()

    const badHex = { ...v4(), r: { ...v4().r, c: 'not hex at all' } }
    expect(await readBackupFile(asFile(badHex))).toBeNull()

    const missingArgonParams = { ...v4(), d: { kv: 2, s: 'aa', n: 'bb', c: 'cc' } }
    expect(await readBackupFile(asFile(missingArgonParams))).toBeNull()
  })

  it('rejects files that are not backups at all', async () => {
    expect(await readBackupFile(asFile('not json'))).toBeNull()
    expect(await readBackupFile(asFile(null))).toBeNull()
    expect(await readBackupFile(asFile([v4()]))).toBeNull()
    expect(await readBackupFile(asFile({}))).toBeNull()
  })
})
