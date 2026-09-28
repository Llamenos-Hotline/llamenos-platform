# Assurance gap inventory — 2026-09-27/28

**Status:** findings record. Not a design. The remediation design for the identity
layer is a separate document.

## Why this exists

A single session found **eight** places where something reported success while asserting
nothing, plus an entire subsystem that is built, tested, and never called. The
2026-05-18 security audit (197+ findings, 9 epics) flagged none of this class.

That was structural rather than sloppy. `.claude/skills/security-audit-pipeline/SKILL.md`
enumerates its finding categories as action pinning, schema validation, KDF upgrades,
zeroization, auth, rate limiting, webhook validation, CSP, IPC, keychain, cert pinning,
StrongBox and deep links. Grep it for `vacuous`, `cannot fail`, `fail open`, `assert`,
`coverage` or `green` and you get **zero matches**.

Every category asks *"is this code vulnerable?"* None asks *"is the evidence that it is
safe real?"* The instruments were never audited.

## Part 1 — the assurance layer

Each of these reported success while asserting nothing. Several are fixed; issue numbers
are given for the rest.

| # | Defect | Where |
|---|---|---|
| 1 | A required check satisfied by being **skipped** — branch protection treats skip as pass | #848 (historical) |
| 2 | **397 of 398** Android assertions could not fail — `assertAnyTagDisplayed` caught `Throwable` and *returned* a Boolean that call sites discarded | #1222, fixed in #1224 |
| 3 | A rail comparing two equally-stale literals — structurally unable to fail | fixed in #1220 |
| 4 | A coverage gate reporting **100% before and after** deleting a feature's coverage entirely | #1221 |
| 5 | A filter assertion green precisely when seeding **failed** — an empty list was a vacuous pass | #1259, fixed in #1261 |
| 6 | **51 of 81** crypto interop step bodies comment-only | #1222, #1235 |
| 7 | A test asserting `toHaveBeenCalledWith('hub-123')` — one argument — which would have **failed if someone fixed the bug it pinned** | fixed in #1253 |
| 8 | The deploy pipeline exiting **0 having touched nothing** — an unset secret produced a 0-byte inventory, Ansible matched no hosts, and preflight/setup/smoke all "passed" | fixed in #1253 |

Adjacent, same family:

- **Five of six assembled agent definitions had drifted from their fragments.** `build-agents.sh`
  output is committed and nothing rebuilt it, so a supervisor was told *"Does NOT own
  `tests/steps/`"* long after its fragment granted it. The gate honoured a grant the
  supervisor never read. Fixed in #1266.
- **The desktop test mock implements different cryptography than production** — hand-rolled
  X25519+HKDF+AES-GCM, not RFC 9180 — so cross-platform envelope tests compared the mock to
  itself. It also accepts credentials production rejects. #1236.
- **`tests/db-helpers.ts` silently fell back to a shared database**, so direct-DB assertions
  could pass or fail for reasons unrelated to the code. #1263.
- **Two harness defects that make correct code look broken**: `worktree-setup.sh` reports
  "Server crypto built" while building the wrong thing (#1234), and `PG_POOL_SIZE=5` locally
  against CI's 40 wedges the server with timeouts shaped like regressions (#1264).

### What the assurance defects were hiding

Making the suites honest surfaced **fourteen real day-one defects** in the clients:

**Android (6)** — the hub-communications API client broken end to end; onboarding structurally
unable to complete; channel toggles inert; a feature file running entirely as an unregistered
user; the admin sidebar never routed; event detail missing sub-events.

**iOS (8)** — on its first honest run, **173 of 326 UI tests failed**. Every request carrying a
query string returned 401, covering notes, cases, contacts, reports, events, call history and
the audit log; Call History crashed on open; tapping a hub never switched the active hub
(#1262). The suite had not run anywhere since 2026-05-04.

Its reported coverage was **30/569**; the honest number was **15/569**, the difference being
fuzzy substring matching that credited `Switch active hub` to a test asserting the hub is *not*
switched.

## Part 2 — the identity layer is unwired

This is the root cause beneath the cryptographic findings, and it is not a bug.

**Built, tested, and reachable at every tier:** `POST /api/users/:pubkey/sigchain` with real
Ed25519 verification and hash-chain continuity; `sigchain_create_link_from_state` over IPC and
wrapped in `platform.ts`; `create_initial_puk` / `rotate_puk` wrapping per-device with AAD bound
to `device_id`; `POST /api/devices/register` and a revoke route.

**Application call sites: zero.**

- `sigchainCreateLinkFromState` — one caller, a recovery-group component, never for device auth
- `pukCreateFromState` / `pukRotateFromState` / `pukUnwrapSeedFromState` — none outside `platform.ts`
- `/api/devices/register` — none in `src/client/` (mobile uses it for a wake/push key only)
- `git grep genesis src/client/` — none

With no working device-authorisation mechanism wired up, every flow that needed one improvised,
and the only substitute available was **move the seed**:

- **#1231** — admin-created volunteers have their raw Ed25519 seed rendered in the admin UI.
  Worse than non-repudiation: desktop derives the X25519 key from the Ed25519 seed via unsalted
  HKDF, so the admin also holds the volunteer's **decryption** key. This contradicts
  `PROTOCOL.md` §2.11, which mandates two independent randoms.
- **#1026** — desktop linking encrypts the primary's X25519 encryption seed and the new device
  imports it as an Ed25519 signing seed. The linked device's identity matches neither of the
  primary's pubkeys and is never registered.
- **#1027** — desktop sends 32 raw bytes; iOS parses a JSON bundle. Cross-platform linking
  cannot work.

`PROTOCOL.md` §6.1 transports **no seed at all** — two pubkeys and one HPKE-wrapped PUK. Both
implementations are wrong against the spec, not merely different from each other.

**Sequencing consequence:** the correct linking design cannot be built until PUK bootstrap
exists. Fixing #1231 and #1026 as separate bugs yields two patches that still cannot authorise
a device — there is no PUK to wrap and no chain to append to. **PUK bootstrap plus sigchain
genesis is the first work item, and neither issue mentions it.**

## Part 3 — promise status

| Promise (CLAUDE.md) | Status |
|---|---|
| Device private keys never enter the webview | **False** — #1231 |
| Per-device keys, sigchain-authorised | **False in practice** — the layer has no call sites |
| Multi-device support | **Broken** — #1026, #1027 |
| E2EE cross-platform interop | **Unverified** — #1236; the mock is not RFC 9180 |
| Audit-log non-repudiation (Epic 77) | **Void** — downstream of #1231 |
| Per-hub telephony isolation | **Was inert** — #1260, fixed in #1253 |
| Multi-hub routing axiom | **Verified** — all three clients assert it (#1221) |

## Part 4 — priority

1. **Demo-seed gating.** Hours. Enabling demo mode at setup seeds accounts whose private keys
   are committed to a public repository, including a super-admin. Persisted in the database, so
   a single checkbox at setup makes it permanent. Must land before any server exists.
2. **Deploy prerequisites.** Operator-only: eight secrets, the `production` GitHub Environment,
   two vault files, DNS records.
3. **Remaining client fixes.** iOS #1225; crypto interop #1235.
4. **PUK bootstrap + sigchain genesis.** 1-2 weeks. Unblocks everything below.
5. **Flow A** — route admin-created volunteers through invites. 3-5 days.
6. **Flow B** — implement §6.1 linking properly. 3-5 weeks, plus 2-3 for mobile parity.
7. **Audit methodology.** Add an assurance dimension to `security-audit-pipeline`: for each
   guarantee, ask what proves it and whether that proof can fail.

Identity layer total: **8-12 weeks single-engineer**, 5-7 parallel. Overwhelmingly wiring —
the Rust primitives, server routes and sigchain verification are built and tested.

## The transferable rule

The generalisable tell is **a test that is green when the system is broken and red when it
works.** Several of the eight had exactly that inversion. Mutate the code a test covers and
confirm it goes red; verify a required check reports on every ref that can merge; confirm a
harness mock implements the same algorithm as production; and check that a success report
corresponds to work performed rather than to a command that returned 0.
