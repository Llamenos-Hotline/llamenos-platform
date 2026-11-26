/**
 * The closed set of HPKE envelope shapes (spec D1) — `packages/crypto/src/shape.rs`
 * `Shape`, in C-ABI byte order (the index IS the byte the server's `bun:ffi`
 * binding passes). The names are the crate's serde (kebab-case) names, which the
 * Tauri IPC carries.
 *
 * A host names a shape and nothing else: the crate maps each shape to its label
 * (HPKE `info`) and its AAD. No TypeScript in this repo spells a crypto label or
 * builds an AAD for an envelope.
 *
 * The order is pinned against the crate by `packages/crypto/tests/fixtures/v2/
 * hpke-wrap.json` (its positives list every shape in this order), asserted by
 * `apps/worker/__tests__/integration-bun/v2-vectors.test.ts`.
 */
export const SHAPES = [
  'note-key',
  'file-key',
  'file-metadata-key',
  'contact-profile-key',
  'contact-id-key',
  'hub-key',
  'firehose-window-key',
  'message-key',
  'call-meta-key',
  'puk-seed',
  'audit-user-key',
  'push-wake',
  'push-full',
  'platform-role-name',
  'platform-role-description',
  'recovery-group-share',
  'recovery-share-contribution',
  'recovery-puk-seed',
] as const

export type Shape = (typeof SHAPES)[number]
