/**
 * Reader-side guards for the v6 backup container.
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

function v6(): BackupFile {
  return {
    v: BACKUP_FORMAT_VERSION,
    id: 'a1b2c3',
    t: 1_760_000_400,
    d: { kv: 2, s: 'aa'.repeat(32), m: 65_536, i: 3, p: 4, n: 'bb'.repeat(12), c: 'cc'.repeat(112) },
    r: { kv: 1, s: 'dd'.repeat(32), n: 'ee'.repeat(12), c: 'ff'.repeat(112) },
  }
}

describe('readBackupFile', () => {
  it('accepts a v6 container', async () => {
    expect(await readBackupFile(asFile(v6()))).toEqual({ kind: 'backup', backup: v6() })
  })

  it('names a v5 container as missing the X-Wing seed (#3053)', async () => {
    expect(await readBackupFile(asFile({ ...v6(), v: 5 }))).toEqual({ kind: 'missing-xwing-seed' })
  })

  it('rejects the v1 container the old TypeScript writer produced', async () => {
    const v1 = {
      v: 1,
      id: 'a1b2c3',
      t: 1_760_000_400,
      d: { s: 'aa'.repeat(16), i: 600_000, n: 'bb'.repeat(12), c: 'cc'.repeat(48) },
      r: { s: 'dd'.repeat(16), i: 100_000, n: 'ee'.repeat(12), c: 'ff'.repeat(48) },
    }
    expect(await readBackupFile(asFile(v1))).toEqual({ kind: 'invalid' })
  })

  it('rejects the v3 container the old Rust writer produced', async () => {
    const v3 = {
      v: 3,
      deviceId: 'd3b07384-d9a0-4f1b-9c2e-000000000000',
      signingPubkeyHex: '11'.repeat(32),
      encryptionPubkeyHex: '22'.repeat(32),
      encryptedPayload: '33'.repeat(76),
    }
    expect(await readBackupFile(asFile(v3))).toEqual({ kind: 'invalid' })
  })

  it('rejects the v4 container, which held only the signing seed (#2140)', async () => {
    expect(await readBackupFile(asFile({ ...v6(), v: 4 }))).toEqual({ kind: 'invalid' })
  })

  it('rejects a v6 container with a missing or malformed block', async () => {
    const noRecovery: Record<string, unknown> = { ...v6() }
    delete noRecovery.r
    expect(await readBackupFile(asFile(noRecovery))).toEqual({ kind: 'invalid' })

    const badHex = { ...v6(), r: { ...v6().r, c: 'not hex at all' } }
    expect(await readBackupFile(asFile(badHex))).toEqual({ kind: 'invalid' })

    const missingArgonParams = { ...v6(), d: { kv: 2, s: 'aa', n: 'bb', c: 'cc' } }
    expect(await readBackupFile(asFile(missingArgonParams))).toEqual({ kind: 'invalid' })
  })

  it('rejects files that are not backups at all', async () => {
    expect(await readBackupFile(asFile('not json'))).toEqual({ kind: 'invalid' })
    expect(await readBackupFile(asFile(null))).toEqual({ kind: 'invalid' })
    expect(await readBackupFile(asFile([v6()]))).toEqual({ kind: 'invalid' })
    expect(await readBackupFile(asFile({}))).toEqual({ kind: 'invalid' })
  })
})
