/**
 * `apps/desktop/Cargo.lock` <-> `apps/desktop/Cargo.toml` consistency.
 *
 * PR #895 (pinning `tauri`/`@tauri-apps/api` to matching exact versions —
 * see `tauri-version-alignment.spec.ts`) was flagged in review because its
 * `Cargo.lock` diff dropped the openmls/hpke-rs/libcrux dependency closure
 * (648 deleted lines) while `packages/crypto/Cargo.toml` still declares
 * `openmls = "0.9"`. That looked like an unreproducible, out-of-scope
 * lockfile rewrite.
 *
 * It wasn't. `mls` is an explicitly default-off feature on `llamenos-core`
 * (`packages/crypto/Cargo.toml`, decision recorded in #708): the
 * openmls -> hpke-rs -> libcrux chain carries aarch64 constant-time-timing
 * RUSTSEC advisories, so it is gated out of every shipped binary — mobile,
 * server, and desktop alike — unless a consumer opts in with
 * `--features mls`. `apps/desktop/Cargo.toml`'s `llamenos-core = { path =
 * "../../packages/crypto" }` dependency requests no features, so it never
 * activates `mls`, and the closure was never reachable from
 * `apps/desktop/Cargo.lock`'s resolved graph in the first place.
 *
 * Verified empirically while fixing the review's follow-up: restoring
 * `apps/desktop/Cargo.lock` to its pre-PR content and re-running EITHER
 * `cargo generate-lockfile` (full regen) OR the minimal
 * `cargo update -p tauri --precise 2.11.1` (scoped, PR-appropriate update)
 * both reproduce the PR's committed lockfile byte-for-byte — the openmls
 * entries that main's stale lockfile carried were themselves inconsistent
 * with the manifest (locked at openmls 0.8.1 / openmls_rust_crypto 0.5.1,
 * which does not satisfy the "0.9"/"0.6" requirement `packages/crypto`
 * actually declares) and get pruned by any cargo operation that touches the
 * file, full regen or scoped update alike. So the PR's lockfile was already
 * the unique, reproducible, `--locked`-satisfying result — and it is also
 * the *secure* one, matching the mls exclusion `packages/crypto/CLAUDE.md`
 * documents.
 *
 * This is the rail that keeps it that way: `cargo metadata --locked` is
 * cargo's own consistency check, run without a full compile. It fails
 * loudly the moment `Cargo.lock` stops satisfying `Cargo.toml` for any
 * reason (a real dependency bump forgotten from the lockfile, not just this
 * specific incident) — the exact class of drift `cargo build --locked`
 * would also catch, at a fraction of the cost.
 *
 * Mutation check performed while authoring this test: temporarily bumping
 * `apps/desktop/Cargo.toml`'s `tauri` requirement to a version the
 * committed lockfile can't satisfy (`=2.99.0`, which doesn't exist) made
 * `cargo metadata --locked` fail with cargo's own
 * `failed to select a version for the requirement` error (exit 101);
 * restoring the real pin made it pass again (see PR body for output).
 *
 * Follow-up incident: this same rail then failed on #927 — a PR whose
 * lockfile was verifiably correct (`cargo metadata --locked` passed in <1s
 * on the operator's machine) — reporting "Cargo.lock no longer satisfies
 * Cargo.toml". The CI stderr it captured showed cargo mid-resolve
 * (downloading hundreds of crates, cloning the `hpke-rs` git patch
 * dependency), not failing: on a cold runner that legitimately exceeds the
 * old 60s `execFileSync` timeout, which kills the process and lands in the
 * same `catch` block as a genuine `--locked` violation. The message never
 * distinguished "cargo concluded the lockfile is wrong" from "we killed
 * cargo before it could conclude anything." Rewritten below to classify the
 * failure into `timeout` / `environment` / `drift` before deciding what to
 * say, using cargo's own distinctive `--locked`-violation wording
 * (`needs to be updated but --locked was passed`,
 * `failed to select a version for the requirement`) as the only signal for
 * `drift`, and `ETIMEDOUT`/no-exit-status as the signal for `timeout`.
 *
 * Both new branches were verified with the same inject-the-defect method as
 * the original mutation check above (see PR body for full output):
 *   - Reverting this rewrite (collapsing all three outcomes back into one
 *     `failure: string | null`) while re-running the `tauri = "=2.11.6"`
 *     mutation still fails the test — real drift is never swallowed.
 *   - Lowering `CARGO_METADATA_TIMEOUT_MS` to a value shorter than a cold
 *     resolve reproduces the original incident's shape but now fails with
 *     the `timeout` branch's message, not the lockfile-drift message.
 *
 * A second, independent bug surfaced while verifying the above: this
 * manifest's `cargo metadata --format-version 1` output is ~3.4MB of JSON on
 * stdout, but `execFileSync` defaults `maxBuffer` to 1MB. That overflow kills
 * the process with `ENOBUFS`/SIGTERM — the exact same shape (`err.signal` set,
 * `err.status: null`) as a real timeout, and it reproduces on EVERY run
 * regardless of cache state or network speed, since it depends only on output
 * size. Verified: the unmodified original code (and a naive `timeout`-only
 * fix that doesn't also raise `maxBuffer`) fails on this repo's manifest even
 * with a fully warm cache and a sub-second cargo run, misreporting a buffer
 * overflow as either lockfile drift (original code) or a timeout (if only the
 * timeout value were fixed). Fixed by setting `maxBuffer` generously and by
 * keying the `timeout` branch strictly on `err.code === 'ETIMEDOUT'` — the one
 * code Node/Bun's `child_process` uses for its own timeout kill — so a future
 * ENOBUFS-shaped failure still lands in `environment`, not `timeout`.
 */

import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '..')
const DESKTOP_CARGO_TOML = resolve(REPO_ROOT, 'apps/desktop/Cargo.toml')

// `cargo metadata --locked` on a fully cold `~/.cargo/registry` + `~/.cargo/git`
// (no CI cache hit — first run after a lockfile-affecting cache-key change, an
// evicted cache, etc.) resolves the whole dependency graph (at the time of the
// incident it also cloned an `hpke-rs` git `[patch.crates-io]` dependency, since
// removed in #930). That observably took >60s on a cold GitHub Actions
// runner (the incident this rewrite fixes — see file docstring above for the
// full story: CI killed cargo mid-resolve and the old code reported the kill
// as "lockfile no longer satisfies manifest", which was false). CI now also
// warms this cache ahead of the Playwright run (see ci.yml's `desktop-e2e`
// job), so this
// number is a safety margin for a cache miss, not the expected path.
const CARGO_METADATA_TIMEOUT_MS = 300_000

// `cargo metadata --format-version 1` dumps the ENTIRE resolved dependency
// graph as one JSON document on stdout — ~3.4MB for apps/desktop's graph at
// time of writing, and growing with the dependency tree. `execFileSync`
// defaults `maxBuffer` to 1MB, well under that; hitting it kills the process
// with `ENOBUFS`, which looks identical to a timeout (signal set, no exit
// status) and is what silently broke this exact assertion. 64MB is headroom
// for graph growth without being large enough to mask a truly runaway output.
const MAX_BUFFER_BYTES = 64 * 1024 * 1024

// Cargo's own text when `--locked` finds real drift. Both were reproduced
// empirically against this repo's apps/desktop/Cargo.toml while authoring this
// test (see PR body): bumping `tauri`'s pin to a version that exists on
// crates.io but isn't what Cargo.lock resolved produces the first message;
// bumping it to a version that doesn't exist on crates.io at all (so no
// resolution is possible even ignoring the lock) produces the second. Either
// one means cargo reached an actual verdict about the lockfile — as opposed to
// being killed by our timeout, or failing for an unrelated reason (registry
// unreachable, git clone failure, etc.) before it could reach one.
const LOCKFILE_DRIFT_PATTERNS = [
  /needs to be updated but --locked was passed/i,
  /failed to select a version for the requirement/i,
]

type Outcome =
  | { kind: 'ok' }
  | { kind: 'timeout' }
  | { kind: 'drift'; stderr: string }
  | { kind: 'environment'; stderr: string }

function runCargoMetadataLocked(): Outcome {
  try {
    execFileSync(
      'cargo',
      ['metadata', '--locked', '--format-version', '1', '--manifest-path', DESKTOP_CARGO_TOML],
      { stdio: 'pipe', timeout: CARGO_METADATA_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
    )
    return { kind: 'ok' }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string; status?: number | null }
    const stderr = e.stderr !== undefined ? String(e.stderr) : String(e)

    // Node's own timeout kill sets `code: 'ETIMEDOUT'` specifically — this is
    // the one shape that means "cargo never got to finish, there is no
    // verdict to read." Deliberately NOT matched on `signal`/`status` alone:
    // that generic shape (signal set, status null) is ALSO what an
    // `ENOBUFS` maxBuffer overflow looks like, and conflating the two is what
    // originally hid the true buffer-overflow bug behind a "timeout"
    // diagnosis. Anything else signal-killed falls through to `environment`.
    if (e.code === 'ETIMEDOUT') {
      return { kind: 'timeout' }
    }

    if (LOCKFILE_DRIFT_PATTERNS.some((pattern) => pattern.test(stderr))) {
      return { kind: 'drift', stderr }
    }

    // cargo exited non-zero but not with a recognized --locked-violation
    // message — a registry/network/git-fetch failure or some other
    // environment problem cargo itself couldn't get past. Not lockfile drift.
    return { kind: 'environment', stderr }
  }
}

test.describe('Tauri desktop Cargo.lock consistency', () => {
  test('apps/desktop/Cargo.lock satisfies apps/desktop/Cargo.toml under --locked', () => {
    // Playwright's own per-test timeout (playwright.config.ts: 60s in CI, 30s
    // locally) would otherwise kill this test — and get misreported by the
    // reporter as a bare timeout with none of the classification below —
    // before CARGO_METADATA_TIMEOUT_MS is ever reached. Give the test itself
    // enough headroom to let `runCargoMetadataLocked` reach its own verdict.
    test.setTimeout(CARGO_METADATA_TIMEOUT_MS + 30_000)

    const outcome = runCargoMetadataLocked()

    if (outcome.kind === 'timeout') {
      expect(
        false,
        `\`cargo metadata --locked\` did not finish within ${CARGO_METADATA_TIMEOUT_MS}ms and was killed — ` +
          `this is an ENVIRONMENT/TIMEOUT failure, not evidence of lockfile drift (cargo never reached a ` +
          `verdict). Likely a cold \`~/.cargo/registry\`/\`~/.cargo/git\` (no cache hit) resolving the full ` +
          `dependency graph. Check whether CI's cache-warm ` +
          `step for apps/desktop ran and hit, or whether the registry/git host was slow/unreachable. This does ` +
          `NOT mean Cargo.lock needs updating.`,
      ).toBe(true)
      return
    }

    if (outcome.kind === 'environment') {
      expect(
        false,
        `\`cargo metadata --locked\` exited non-zero for a reason other than lockfile drift — this is an ` +
          `ENVIRONMENT failure (registry unreachable, git clone failure, etc.), not evidence that ` +
          `apps/desktop/Cargo.lock no longer satisfies apps/desktop/Cargo.toml. Cargo's own drift message ` +
          `(\`... needs to be updated but --locked was passed\` or \`failed to select a version for the ` +
          `requirement\`) was NOT present in the output below. Investigate the environment, not the ` +
          `lockfile.\n\ncargo stderr:\n${outcome.stderr}`,
      ).toBe(true)
      return
    }

    // Only 'ok' and 'drift' remain here — 'timeout' and 'environment' returned above.
    expect(
      outcome.kind === 'ok',
      `apps/desktop/Cargo.lock no longer satisfies apps/desktop/Cargo.toml under ` +
        `\`cargo metadata --locked\` (the same check \`cargo build --locked\` performs). ` +
        `Run \`cargo update -p <changed-crate> --precise <version>\` (a scoped update, ` +
        `never a bare \`cargo generate-lockfile\`, which re-resolves everything and ` +
        `produces an unreviewable diff) from apps/desktop/, then commit the resulting ` +
        `Cargo.lock alongside the manifest change.\n\ncargo stderr:\n${outcome.kind === 'drift' ? outcome.stderr : ''}`,
    ).toBe(true)
  })
})
