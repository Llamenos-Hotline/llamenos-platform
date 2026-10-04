/**
 * The device-auth message has exactly one construction path per language.
 *
 * `fleet/review` rejected #1390 because Kotlin hand-built
 * `"$LABEL_DEVICE_AUTH:$pubkey:$timestamp:POST:$path"` instead of calling the
 * canonical builder — byte-equivalent at the time, but two sources of truth for
 * a signed message's layout is the hazard domain separation exists to prevent.
 * Byte-equality vectors (`tests/crypto-interop.spec.ts`,
 * `crypto-interop.feature`) prove the implementations agree *today*; this test
 * is what stops a third one from appearing tomorrow.
 *
 * The rule: only the canonical builders may read `LABEL_DEVICE_AUTH` or
 * `LABEL_DEVICE_AUTH_NO_NONCE`. Everything else — app code, platform code,
 * harnesses — goes through them.
 *
 *   Rust:       packages/crypto/src/auth.rs::build_auth_message
 *   TypeScript: packages/shared/auth-message.ts::buildAuthMessage
 *   Kotlin/Swift: the UniFFI export of the Rust builder
 *                 (`mobileBuildAuthMessage`) — generated, never hand-written
 *
 * `trackedFiles`, never a bare git call: fleet/verify runs this suite in a
 * `git archive` export with no `.git`, where the helper walks the export.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, statSync } from 'fs'
import path from 'path'
import { trackedFiles } from '../../../../tests/orchestrator/codeowners'

/**
 * Files allowed to name the device-auth labels, each with the reason.
 * Adding an entry here is a deliberate act that a reviewer will see.
 */
const ALLOWED = new Map<string, string>([
  ['packages/crypto/src/auth.rs', 'the canonical Rust builder'],
  ['packages/crypto/src/labels.rs', 'the label registry itself'],
  ['packages/shared/auth-message.ts', 'the canonical TypeScript builder'],
  ['packages/shared/crypto-labels.ts', 'generated label constants'],
  ['packages/protocol/crypto-labels.json', 'the source of truth for labels'],
  [
    'apps/worker/routes/invites.ts',
    'comment only: names the nonce-less label to explain why the route opts in',
  ],
  [
    'src/client/lib/platform.ts',
    'comment only: names the nonce-less label on createNoncelessAuthToken',
  ],
  [
    'apps/worker/__tests__/unit/auth-utils.test.ts',
    'asserts the canonical builder emits each label — the pinning test',
  ],
  [
    'apps/worker/lib/auth.test.ts',
    'comment only: describes which message verifyAuthToken accepts',
  ],
  [
    'tests/crypto-interop.spec.ts',
    'asserts the Rust-generated vectors carry the expected label per shape',
  ],
  [
    'tests/steps/backend/network-security.steps.ts',
    'signs a DELIBERATELY malformed message (no method/path) to assert rejection — ' +
      'the canonical builder cannot express a malformed shape, by design',
  ],
  [
    'apps/ios/Tests/UI/Helpers/TestAdminAPI.swift',
    'XCUITest harness: no UniFFI binding is linked into the UI test target',
  ],
  [
    'packages/crypto/src/ffi_v3.rs',
    'comment only: names the nonce-less label on the UniFFI exports',
  ],
  [
    'packages/crypto/tests/interop.rs',
    'comment only: names the nonce-less label when emitting both shapes',
  ],
  [
    'apps/desktop/src/crypto.rs',
    'comment only: names the nonce-less label on the nonce-less IPC command',
  ],
  [
    'tests/steps/crypto/crypto-steps.ts',
    'comment only: names the nonce-less label to explain why the nonce is required',
  ],
  [
    'tests/mocks/hpke-mock.ts',
    'mirrors the numeric label registry for the browser mock — a label-to-id map, ' +
      'not a message builder',
  ],
  [
    'apps/worker/__tests__/unit/auth-message-single-source.test.ts',
    'this test',
  ],
])

/**
 * Both the constant names AND their literal values. The first sweep only looked
 * for the identifiers and missed `tests/steps/crypto/crypto-steps.ts`, which
 * rebuilt the message from a hardcoded 'llamenos:device-auth:v1' string — the
 * raw-literal form CLAUDE.md forbids outright for crypto contexts.
 */
const LABEL_REFERENCE = /LABEL_DEVICE_AUTH(_NO_NONCE)?\b|llamenos:device-auth/

const SOURCE_EXT = new Set(['.ts', '.tsx', '.rs', '.kt', '.swift', '.json'])

describe('the device-auth message has one construction path', () => {
  const root = path.resolve(__dirname, '../../../..')

  it('names the canonical builders and nothing else', () => {
    const files = trackedFiles(root)
    expect(files.length).toBeGreaterThan(1000)

    const offenders: string[] = []
    let scanned = 0
    for (const file of files) {
      if (!SOURCE_EXT.has(path.extname(file))) continue
      // Generated bindings are the UniFFI projection of the Rust builder.
      if (file.startsWith('packages/crypto/bindings/')) continue
      if (file.includes('/org/llamenos/core/')) continue
      if (file.includes('/generated/')) continue

      const full = path.join(root, file)
      let size: number
      try { size = statSync(full).size } catch { continue } // deleted in the working tree
      if (size > 5_000_000) continue
      scanned++
      const text = readFileSync(full, 'utf8')
      if (!LABEL_REFERENCE.test(text)) continue
      if (ALLOWED.has(file)) continue
      offenders.push(file)
    }

    // A scan that found nothing would make this assertion vacuous.
    expect(scanned).toBeGreaterThan(500)
    expect(
      offenders,
      'These files name a device-auth domain-separation label. Build the message ' +
        'with buildAuthMessage (@shared/auth-message), build_auth_message (Rust) or ' +
        'mobileBuildAuthMessage (Kotlin/Swift) instead — or add an entry to ALLOWED ' +
        'with the reason.',
    ).toEqual([])
  })

  it('has every allowlisted file still present and still naming a label', () => {
    // An allowlist that silently rots stops describing the real exceptions.
    for (const [file, reason] of ALLOWED) {
      const full = path.join(root, file)
      const text = readFileSync(full, 'utf8')
      expect(LABEL_REFERENCE.test(text), `${file} (${reason}) no longer names a label — drop it from ALLOWED`).toBe(true)
    }
  })
})
