#!/usr/bin/env bun
/**
 * Record a file's content layer, sealed by every implementation that seals one,
 * as a cross-platform fixture (#3003).
 *
 *   bash packages/crypto/scripts/build-server.sh   # the real FFI library
 *   bun packages/crypto/scripts/gen-file-content-vectors.ts
 *
 * Writes `packages/crypto/tests/fixtures/file-content-vectors.json`.
 *
 * A file's content layer is AES-256-GCM over the RAW BYTES of the file under
 * the canonical `LABEL_FILE_KEY` content AAD, packed `nonce_12 || ct || tag_16`.
 * The desktop used to seal the hex TEXT of the file instead — a ciphertext of
 * 2n+28 bytes that opened to ASCII on every other client — and nothing noticed,
 * because no client other than the one that wrote it ever read a file back.
 * These vectors are the reader every platform shares:
 *
 *  - `desktop`: sealed by the desktop's production primitive
 *    (`aesGcmSealBytes` in `src/client/lib/platform.ts`, WebCrypto), the one
 *    `encryptFile` uses;
 *  - `crate`: sealed by the crate through its C-ABI (`symmetricEncrypt`), the
 *    same AES-256-GCM `mobile_symmetric_encrypt` runs for iOS and Android.
 *
 * Every consumer opens BOTH, so "a file sealed on desktop opens on iOS and
 * Android, and the reverse" is a byte comparison rather than an assumption:
 * the Rust test (`mobile_symmetric_decrypt`, the exact function the mobile
 * bindings call) and the desktop test (`aesGcmOpenBytes`). The plaintext holds
 * every byte value, so a reader that treats it as text cannot pass.
 *
 * The key, AAD and plaintext are fixed; the nonces are random per run, so
 * regenerating rewrites the ciphertexts and consumers open whatever is recorded.
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { symmetricDecrypt, symmetricEncrypt } from '@llamenos/crypto/ffi'
import { LABEL_FILE_KEY } from '../../shared/crypto-labels'
import { contentAadHex } from '../../shared/envelope-aad'
import { bytesToHex, hexToBytes } from '../../shared/encoding'
import { aesGcmOpenBytes, aesGcmSealBytes } from '../../../src/client/lib/platform'

const OUT = resolve(import.meta.dir, '../tests/fixtures/file-content-vectors.json')

/** A fixed test key. It guards nothing. */
const KEY_HEX = 'f1'.repeat(32)

/** Every byte value, twice, plus a run that is itself valid hex text. */
const PLAINTEXT = new Uint8Array([
  ...Array.from({ length: 256 }, (_, i) => i),
  ...Array.from({ length: 256 }, (_, i) => 255 - i),
  ...new TextEncoder().encode('deadbeef00ff'),
])

const aadHex = contentAadHex(LABEL_FILE_KEY)

const desktop = await aesGcmSealBytes(PLAINTEXT, KEY_HEX, aadHex)
const crate = symmetricEncrypt(hexToBytes(KEY_HEX), PLAINTEXT, hexToBytes(aadHex))

// Each side must already open the other's output before it is recorded.
const same = (a: Uint8Array, b: Uint8Array) => bytesToHex(a) === bytesToHex(b)
if (!same(await aesGcmOpenBytes(crate, KEY_HEX, aadHex), PLAINTEXT)) throw new Error('desktop cannot open the crate seal')
if (!same(symmetricDecrypt(hexToBytes(KEY_HEX), desktop, hexToBytes(aadHex)), PLAINTEXT)) throw new Error('crate cannot open the desktop seal')

writeFileSync(OUT, JSON.stringify({
  description: 'A file content layer sealed by the desktop and by the crate. See scripts/gen-file-content-vectors.ts.',
  label: LABEL_FILE_KEY,
  keyHex: KEY_HEX,
  aadHex,
  plaintextHex: bytesToHex(PLAINTEXT),
  desktopCiphertextHex: bytesToHex(desktop),
  crateCiphertextHex: bytesToHex(crate),
}, null, 2) + '\n')
console.log(`wrote ${OUT} (${PLAINTEXT.length} plaintext bytes, ${desktop.length} ciphertext bytes)`)
