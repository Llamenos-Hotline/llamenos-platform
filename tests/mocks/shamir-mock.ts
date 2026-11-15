/**
 * Shamir share commitment, mirrored from `packages/crypto/src/shamir.rs`
 * `commit` for the Playwright IPC mock (which cannot call Rust).
 *
 * `SHA-256(LABEL_SHAMIR_COMMIT || x || y)`. Desktop used to hash `x || y` with
 * no label — a format no other platform accepted, and one with no domain
 * separation (#2764). `tests/provisioning-mock.spec.ts` pins the same vector
 * the Rust crate (`commitment_matches_the_pinned_cross_platform_vector`) and
 * the desktop command (`shamir_commit_is_the_domain_separated_commitment_…`)
 * pin, so a change to the format on any one side fails a test on all three.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { LABEL_SHAMIR_COMMIT } from '@shared/crypto-labels'

export function shamirCommitment(x: number, yHex: string): string {
  return bytesToHex(sha256(new Uint8Array([...utf8ToBytes(LABEL_SHAMIR_COMMIT), x, ...hexToBytes(yHex)])))
}
