# Performance: what to measure, where, and what to improve first (epic #3014, stage 1)

**Status:** PROPOSAL, held as a draft pending operator sign-off. Part of #3014.
**Base:** `main` @ `e99e7b27c` (2026-11-24). Wire format: #2996 (D1–D16, signed off). Files: #3007
(F1–F8, draft).
**Measured:** 2026-11-25 02:39–02:45 UTC on one Linux workstation, **under concurrent load. Every
number here is indicative only** (§2 explains why, and §5 gives the conditions next to each table).

This spec does three things:

1. It says what to measure at each layer, with which tool, on which machine, and against which
   proposed budget (§3).
2. It says how regressions are tracked without adding load to the memory-bound iOS Mac (§4).
3. It records the first baselines of the crypto crate at **production** parameters (§5), and ranks
   improvement candidates by measured gain, cost and security analysis (§6, §7).

It changes no code. The benchmark harness that produced §5 was a throwaway crate outside the repo.
It is described in §5.1 so that stage 2 can rebuild it properly, and none of it is committed.

---

## 0. Decisions at a glance

| # | Decision | Recommendation | § |
|---|---|---|---|
| P1 | Where benchmarks gate PRs | Only **deterministic** metrics gate: instruction counts (callgrind) for the crate, and exact byte sizes for payloads. Wall-clock numbers only report. Nothing runs on the iOS Mac | 4 |
| P2 | Where wall-clock numbers come from | A scheduled run on a quiet Linux host (x86_64 and arm64), plus physical phones run by hand before each release. Never simulators, never the CI Mac, never a shared runner during the day | 4.3 |
| P3 | Where baselines live | Deterministic baselines are committed snapshot files, changed only by an explicit diff in a PR (the `label-registry.wire.snapshot` pattern). Wall-clock series are workflow artifacts. No third-party performance SaaS | 4.1 |
| P4 | **D2 amendment: binary encoding** | **OPERATOR DECISION.** Measurements in §6.4. This spec does not recommend an option | 6.4 |
| P5 | Compression before encryption | **Rejected** under constraint 5. It adds a length leak, and its only gains are at sizes where that leak is worst | 7.1 |
| P6 | First improvements to build | C1 (cache the expanded X-Wing key, −37% per decapsulation), C2 (parallel Argon2id lanes, −38% unlock, identical output), C3 (one batched, parallel crate call per list) | 6 |

---

## 1. Hard constraints

These come from #3014 and the root `CLAUDE.md`. They are not open to trade:

1. **No lower KDF cost.** Argon2id stays at m = 64 MiB, t = 3, p = 4 (`kdf_params.rs`). `test-kdf`
   never appears in a benchmark build: the bench binary asserts the production constants at start.
2. **No shorter keys,** and no smaller KEM. D16 (X-Wing) is the operator's decision. A speed-up that
   needs X25519-only is out of scope here.
3. **No skipped verification.** Every link, signature, AEAD tag and the D16 check 4
   (`suite.pk_from_sk(epoch_sk) == pk`) runs. Verifying a link once and remembering the result in
   integrity-protected local state is allowed (C8). Not verifying it is not allowed.
4. **No weaker randomness.** No reused nonces, no reused HPKE ephemerals, no deterministic
   encapsulation outside test vectors.
5. **No new length leak.** A ciphertext's length may depend on its plaintext only as D6 (tiers) and
   F3 (files) already allow.
6. **No plaintext anywhere new.** No new on-disk cache, log, trace, metric label or crash report may
   carry plaintext or a key. Performance instrumentation (§3, §4) records durations, counts and
   sizes only.

A candidate that needs any of these is listed under §7 (Rejected), with its reason.

---

## 2. Methodology rules

These are rules, not advice. A number that breaks one is not reported.

1. **Host conditions go with every number.** Every measurement records, at the moment it was taken:
   UTC time, load average (1/5/15 min), available memory, CPU model and core count, the frequency
   governor, the core the bench was pinned to, and the top CPU consumers on the host. A number
   without its conditions is not quoted, and a number taken beside a CPU-saturating job is labelled
   **indicative only**. All numbers in §5 are labelled that way.
2. **Production parameters and the shipped build profile.** Benchmarks build with the crate's
   `[profile.release]` (`lto = true`, `codegen-units = 1`), the toolchain from
   `packages/crypto/rust-toolchain.toml`, and the dependency versions in `packages/crypto/Cargo.lock`.
   The harness refuses to run if `ARGON2_M_COST_KIB != 65 536`.
3. **Statistics.** Report the minimum and the median of at least 15 rounds (7 for operations over
   50 ms), with the median absolute deviation (MAD). The median is the headline. The minimum shows the
   floor, and the MAD shows the noise. Never report a mean alone.
4. **One core, pinned,** for single-threaded operations (`taskset -c <n>`). Parallel candidates (C2,
   C3) are measured unpinned, and say so.
5. **A host that needs to be quiet is quiet, or the number is a TODO.** Wall-clock budgets (§3) are
   checked on a quiet host. Where this spec needed a quiet-host number and did not have one, it says
   **TODO (quiet host)** rather than reporting a contaminated figure.
6. **Name what was measured.** A projection built by adding measured parts says "projection", and
   lists its parts. Format 2 is not built yet, so every X-Wing end-to-end figure here is a projection.
7. **Phones are measured on phones.** Desktop numbers are never scaled into phone estimates in a
   budget. Phone figures are TODO until stage 2 measures them on a physical device (§3.7, §4.3).

---

## 3. Metrics per layer

Budgets are **proposals**, to be confirmed against the first quiet-host and physical-device
baselines in stage 2. "Reference phone" means one mid-range Android device and one iPhone the operator
nominates (proposed: a Pixel 6a-class device and an iPhone 12-class device, which are the oldest the
pilot is likely to see).

### 3.1 Crate microbenchmarks (production parameters)

| Metric | Tool | Runs on | Proposed budget (reference phone, p50) |
|---|---|---|---|
| HPKE seal / open of a 32-byte DEK, X25519 and X-Wing | criterion (wall clock), iai-callgrind (instruction count) | quiet Linux x86_64 + arm64 (report); callgrind on any Linux runner (gate) | X-Wing open ≤ 1 ms |
| X-Wing keygen from seed (D16 check 4, every grant open) | same | same | ≤ 0.5 ms |
| AES-256-GCM per KiB, 64 KiB, 1 MiB | same | same | ≥ 200 MiB/s |
| Argon2id unlock (device keys) | criterion, 7 rounds | quiet Linux + phones by hand | ≤ 1.0 s **without lowering cost** (§6.2) |
| Ed25519 sign / verify | same | same | — (component) |
| HKDF-SHA256, SHA-256 per MiB | same | same | — (component) |
| User sigchain verify, N = 10 / 100 / 1000 links | same | same | 100 links ≤ 50 ms |
| Hub chain verify, N links (#2963; not built — modelled in §5) | same | same | 1 year (≈ 470 links) ≤ 100 ms |
| File STREAM seal / open per 1 MiB segment (F2) | same | same | ≥ 100 MiB/s |
| Ciphertext Merkle root (F6), from leaves and from stored leaf hashes | same | same | — (server-side, see §3.3) |
| D6 `pad_to_bucket` / F3 Padmé | same | same | — (component) |
| Open N sealed records (list view), N = 50 / 500 | same | same | 50 summaries ≤ 60 ms |

### 3.2 FFI and IPC overhead

Each boundary is measured as **(time through the boundary) − (time of the same Rust call made
natively)**, on the same host and the same inputs.

| Boundary | What it costs today | Tool | Runs on |
|---|---|---|---|
| `bun:ffi` → `ffi_server` (`packages/crypto/ffi.ts`) | per-call floor, plus hex and JSON marshalling in `caseSeal` / `caseOpen` | `Bun.nanoseconds()` harness against a `--features server` build | quiet Linux, scheduled |
| Tauri IPC (`platform.ts` → `apps/desktop/src/crypto.rs`) | JSON serialisation of hex strings both ways | a Tauri test build that times `invoke` round trips in the real webview, under xvfb | quiet Linux, scheduled |
| UniFFI (Kotlin/JNI) | `RustBuffer` lowering of `String` hex fields | Jetpack Microbenchmark | physical Android device, by hand |
| UniFFI (Swift) | same | XCTest `measure(metrics: [XCTClockMetric()])` | physical iPhone, by hand (never the CI Mac) |
| Hex encode / decode at each boundary | per KiB and per MiB, Rust `hex` and JS `Buffer` | the crate bench and the Bun harness | quiet Linux |

The Playwright desktop suite cannot measure any of this: it aliases the Tauri IPC layer to the JS
mock in `tests/mocks/` and never loads the crate.

### 3.3 Worker

| Metric | Tool | Runs on | Proposed budget |
|---|---|---|---|
| p50 / p95 / p99 server time on hot routes: auth check, case list page, case get, message list, message ingest webhook (which seals server-side), inbound-call webhook to first ring, file segment PUT / GET | k6 (`tests/load/*.js`, extended), with `Server-Timing` headers carrying durations only | dev compose on a quiet Linux host, scheduled | list and get p95 ≤ 50 ms at 50 virtual users; message ingest p95 ≤ 30 ms; inbound-call webhook p95 ≤ 100 ms |
| Throughput at saturation | k6 ramp | same | report only |
| Query plans of the hot queries | `EXPLAIN (ANALYZE, BUFFERS)` against a seeded database (10 k cases, 100 k messages per hub) | same | no sequential scan on a hub-scoped list |
| Server-side crypto per request | spans around `ffi.ts` calls | same | report only |
| Merkle root at upload complete and in the scrub (F6) | crate bench + span | same | report only |

### 3.4 Payload sizes on the wire, per record type

Sizes are **deterministic**, so they gate PRs (§4.2). Each record type has a fixture built through
the crate at a fixed plaintext length. The test writes the serialised byte count of every shape to a
snapshot file, and the PR must change the snapshot to change a size.

| Shape | Measured in §5.5 | Under X25519 / X-Wing |
|---|---|---|
| Case record: 3 tiers (180 B, 1.4 KB, 250 B) × 2 groups | yes | 8 497 B / 21 553 B (hex-JSON) |
| Message: 1 tier (300 B), thread key | yes | 1 556 B / 3 732 B |
| Note: 1 tier (2 KB) × 3 groups | yes | 5 306 B / 11 834 B |
| Case list page: 50 summaries (180 B) × 2 groups | yes | 94 801 B / 312 401 B |
| Header, grant row, `group_epoch` link, thread-key record | #2996 §1.4 (not re-measured) | 338 / 777 / 824 / 342 B; 2 514 / 2 953 / 3 192 / 2 710 B |
| File segment (F2) | arithmetic | 1 MiB + 16 B, raw body |

### 3.5 Client scenarios

Scenarios are timed with named spans: `performance.mark` and `measure` in the webview, `tracing`
spans in Rust, `os_signpost` on iOS, and `androidx.tracing` sections on Android. A perf build writes
them to a local file. The spans record **only** names, durations and counts.

| Scenario | Start → end | Desktop tool | Android tool | iOS tool | Proposed budget (p95, reference device) |
|---|---|---|---|---|---|
| Cold start | process start → lock screen interactive | tauri-driver + spans | Macrobenchmark `StartupTimingMetric` | `XCTApplicationLaunchMetric` | ≤ 1.5 s desktop and Android, ≤ 1.0 s iOS |
| Unlock | PIN submit → keys usable | spans | Macrobenchmark + `TraceSectionMetric` | `XCTClockMetric` + signposts | ≤ 1.0 s (dominated by Argon2id, §6.2) |
| Hub switch | tap → first list row rendered | spans | `TraceSectionMetric` | signposts | ≤ 300 ms |
| Time to first case list | unlock done → 50 rows rendered | spans | `TraceSectionMetric` | signposts | ≤ 800 ms on a warm network |
| Decrypt N records | crate batch call (C3) start → end | crate spans | same | same | 50 ≤ 60 ms, 500 ≤ 600 ms |
| Open a file | tap → first segment displayed; and → last segment | spans | `TraceSectionMetric` | signposts | first segment ≤ 500 ms after its bytes arrive |
| Call setup to two-way audio | answer tap → first RTP packet decoded in **both** directions | liblinphone call-state log timestamps + RTP timestamps at the PBX | same | same | ≤ 1.0 s on the dev telephony stack |
| Ring fan-out | inbound webhook received → every on-shift client ringing | worker span + client span (push excluded and measured separately) | same | same | ≤ 2.0 s |

Call setup is measured on the dev compose `--profile telephony` stack (Kamailio, Asterisk) with
`sipp` as the caller, on Linux. The client end uses liblinphone's own call-state transitions
(`OutgoingInit` / `IncomingReceived` → `Connected` → `StreamsRunning`) plus the first decoded audio
frame. Hotline calls are hop-by-hop DTLS-SRTP, so the PBX side is measurable without any call key.

### 3.6 Memory

| Metric | Tool | Budget |
|---|---|---|
| Peak during unlock | `/proc/<pid>/status` VmHWM (desktop), `dumpsys meminfo` (Android), `XCTMemoryMetric` (iOS) | Argon2id needs 64 MiB, and that does not move. Peak ≤ baseline + 64 MiB + 10% |
| Resident after unlock, idle on shift | same, plus Perfetto heap profile (Android) and Instruments Allocations (iOS, by hand) | report only until baselined |
| Crate state | count and size of held secrets | X-Wing expanded keys cost about 2 400 B (ML-KEM-768 dk, serialised size) + 1 184 B (ek) per cached epoch (C1). 50 cached epochs ≈ 180 KB |
| JS heap copies of plaintext (desktop) | heap snapshot after opening 50 records | report only. Fewer copies is also a security property, because JS strings cannot be zeroised |

### 3.7 Mobile power

Power is measured on **physical devices only**, by hand, before each release and after any change to
background work, push handling, the SIP stack or the crypto batch path. No simulator and no emulator
numbers.

- **iOS:** the Xcode energy gauge (debug navigator) for a session attached to Xcode, and **MetricKit**
  in internal-testing builds: `MXCPUMetric`, `MXNetworkTransferMetric`, `MXCellularConditionMetric`,
  `MXDiskIOMetric`, `MXAppExitMetric` and `MXSignpostMetric` (the same signposts as §3.5).
  MetricKit payloads stay on the device. The internal build shows them on a debug screen and exports
  them only through the share sheet, by the tester's own action. Nothing is uploaded automatically.
  Attached Xcode sessions need a Mac that is **not** the CI host (§4.3).
- **Android:** `adb shell dumpsys batterystats --reset`, the scenario, then `dumpsys batterystats`
  into Battery Historian; **Perfetto** traces with the `power.rails.*` data source on devices that
  expose power rails (Pixel); and **Macrobenchmark** `PowerMetric` (energy and power categories,
  API 29+, a device with rails).
- **Scenarios:** one hour idle on shift (push only); 10 minutes of ringing and declined calls; a
  20-minute SRTP call; 10 minutes browsing case lists and opening records.
- **Proposed budgets:** idle on shift ≤ 2% battery per hour; a 20-minute call ≤ 6%; zero wake locks
  held while idle off shift. These are placeholders until the first device baseline.

---

## 4. Regression tracking

### 4.1 Baselines

- **Deterministic metrics** (instruction counts and byte sizes) are committed snapshot files next to
  the code they describe: `packages/crypto/benches/instructions.snapshot` and
  `packages/protocol/payload-sizes.snapshot` (names proposed). A PR that changes a number must change
  the snapshot, so the diff is reviewed. This is the `label-registry.wire.snapshot` pattern the repo
  already uses.
- **Wall-clock series** (criterion, k6, client spans) are workflow artifacts from the scheduled
  runs, each with its host-conditions header (§2 rule 1). A release records its own snapshot of them
  in the release PR.
- **No third-party performance service.** It would be a new outward-facing channel, and
  publishing is local only (root `CLAUDE.md`).

### 4.2 What fails a PR and what only reports

| Metric | Gate? | Rule |
|---|---|---|
| Crate instruction counts (iai-callgrind), all ops in §3.1 except Argon2id | **fails** | an op more than 2% above its snapshot fails, unless the PR updates the snapshot and says why. Callgrind counts repeat to well under 1%, so 2% is a real change |
| Argon2id parameters | **fails** (exists) | the `test-kdf` release guard in `kdf_params.rs`, plus the bench's own assert. Under callgrind Argon2id takes too long to run on every PR |
| Payload byte sizes (§3.4) | **fails** | any change needs a snapshot diff in the PR |
| Wall-clock crate numbers | reports | flag when the median is above baseline × (1 + max(5%, 3 × MAD / median)). Comment on the next PR that touches `packages/crypto/` |
| Worker k6 | reports | k6 `thresholds` fail the **scheduled** job, never a PR |
| Client scenarios, memory, power | reports | release checklist item, with the numbers in the release PR |

Why wall clock never gates: two back-to-back runs on the measurement host differed by up to 7%
(Ed25519 verify: 26.97 µs, then 25.08 µs). A 5% gate would fail at random.

### 4.3 Where each benchmark runs, and why not the Mac

The iOS Mac is memory-bound: 16 GiB, with the CI scratch volume at risk (#2401), and jetsam has
already killed a green PR's job (#2243). **Nothing in this spec runs on it.** Simulator timings are
not representative of phones anyway, because they run on the host CPU.

| Benchmark | Runs on | When |
|---|---|---|
| Crate callgrind gate | a GitHub-hosted Linux runner, path-filtered to `packages/crypto/**` | every PR touching the crate |
| Payload-size snapshot | the existing Linux test job | every PR touching `packages/crypto/**` or `packages/protocol/**` |
| Crate criterion, x86_64 | a quiet Linux host. A self-hosted runner only in an idle window, because the three Linux runners share capacity | scheduled, weekly |
| Crate criterion, arm64 | an arm64 Linux host (phone-class cores, no Mac needed) | scheduled, weekly |
| Crate on real phone silicon | the bench binary pushed over `adb` to a physical Android device, attached to a Linux host | by hand, before each release |
| `bun:ffi` and Tauri IPC | quiet Linux host | scheduled, weekly |
| Worker k6 + `EXPLAIN` | dev compose on a quiet Linux host | scheduled, weekly |
| Desktop scenarios | real Tauri build + tauri-driver under xvfb, Linux | scheduled, weekly |
| Android scenarios and power | physical device, Macrobenchmark + Perfetto, from a Linux host | by hand, before each release |
| iOS scenarios and power | physical iPhone. MetricKit needs no Mac. Attached Instruments sessions need a Mac that is **not** the CI host | by hand, before each release |

**Open question for the operator (Q1):** is there a Mac other than the CI host for attached iOS
Instruments sessions? If not, iOS power comes from MetricKit alone, and the energy gauge is skipped.

---

## 5. Baselines (measured, indicative only)

### 5.1 How they were taken

- **Host:** AMD Ryzen 7 5700G (8 cores, 16 threads), 78 GiB RAM, Linux 6.8. The frequency governor
  was `powersave` and could not be changed without root. That is one reason the numbers are
  indicative.
- **Build:** a throwaway crate in `/tmp` with a path dependency on `packages/crypto`. It used the
  same release profile (`lto`, `codegen-units = 1`) and toolchain (rustc 1.99.1 stable, per
  `rust-toolchain.toml`). Its lockfile resolved the same versions as `packages/crypto/Cargo.lock`
  for every crypto dependency checked: `hpke` 0.13.0, `aes-gcm` 0.10.3, `aes` 0.8.4, `polyval`
  0.6.2, `argon2` 0.5.3, `ed25519-dalek` 2.2.0, `x25519-dalek` 2.0.1, `curve25519-dalek` 4.1.3 and
  `sha2` 0.10.9. X-Wing is not in the crate yet: it came from RustCrypto `x-wing` 0.1.0 (over
  `ml-kem` 0.3.2), the candidate named in #2996 §1.4.
- **Method:** pinned to core 15. The headline is the median of 15 rounds (7 for Argon2id, 9 for
  chains and lists), each round averaging many calls. The harness asserted production Argon2id
  constants.
- **Concurrent load:** the host was shared with other agent sessions. The dispatching supervisor
  reported `unit9-1770` (a linphone-sdk Docker build plus Rust compiles, CPU-saturating by nature)
  and about 11 agent processes. During the first run, `rust-lld` and `rustc` processes were taking
  about 6 cores. **Every figure below is measured under concurrent load and is indicative only.**

Conditions at each run:

| Run | UTC | Load (1/5/15) | Available memory | Heaviest concurrent processes |
|---|---|---|---|---|
| A: primitives + composites | 02:39:21–02:39:49 | 5.49 / 4.02 / 3.46 → 4.61 / 3.95 / 3.46 | 65.4 GiB | `rust-lld` 262% + 235%, `rustc` 108% + 74% + 32%, `cargo` 55% |
| B: Argon2id, chains, files | 02:40:05–02:40:15 | 4.26 / 3.91 / 3.45 → 3.76 / 3.81 / 3.42 | 65.6 GiB | an agent process 23%, `java` 11% |
| C: Argon2 0.5.3 vs 0.6.0 (unpinned) | 02:40:44 | 3.34 / 3.70 / 3.40 | 65.7 GiB | `java` 11% |
| D: encodings, compression | 02:40:52–02:40:59 | 3.24 / 3.67 / 3.39 | 65.7 GiB | `java` 11% |
| E: compression on real text | 02:42:22 | 1.37 / 2.94 / 3.15 | — | — |
| F: `bun:ffi` (Bun 1.3.11) | 02:42:59 | 2.12 / 2.96 / 3.15 | 65.9 GiB | `java` 11% |
| G: X-Wing expanded key | 02:44:44–02:44:46 | 2.31 / 2.62 / 3.00 | 65.6 GiB | `flatpak-update` 27–29%, `revokefs-fuse` 7–13% |
| H: repeat of A (noise check) | 02:44:51–02:45:19 | 2.21 / 2.59 / 2.99 | 65.5 GiB | `flatpak-system` 15% |

Bun on the host was 1.3.11. `.mise.toml` pins 1.3.5, which the worker uses. Run F is therefore
**indicative of the boundary's shape, not of the pinned runtime**, and stage 2 reruns it under mise.

### 5.2 Primitives (run A; run H in brackets where it was repeated)

| Operation | Median | Min | MAD |
|---|---|---|---|
| HPKE X25519 seal, 32-byte key (crate `hpke_seal_key`) | 71.3 µs (70.1) | 70.4 µs | 0.4 µs |
| HPKE X25519 open, 32-byte key (crate `hpke_open_key`) | 56.8 µs (58.9) | 56.2 µs | 0.3 µs |
| X25519 DH | 41.7 µs | 41.6 µs | 0.1 µs |
| X25519 base-point multiply (pk from sk) | 12.7 µs | 12.7 µs | 0.0 µs |
| **X-Wing keygen from a 32-byte seed** (D16 check 4) | 84.2 µs (82.4) | 84.1 µs | 0.1 µs |
| **X-Wing encapsulate** | 135.7 µs (134.7) | 135.2 µs | 0.1 µs |
| **X-Wing decapsulate** (x-wing 0.1 re-expands the seed on every call) | 220.7 µs (218.6) | 220.4 µs | 0.2 µs |
| ML-KEM-768 decapsulate, expanded key held | 94.7 µs | 94.4 µs | 0.1 µs |
| ML-KEM-768 encapsulate | 69.4 µs | 69.1 µs | 0.1 µs |
| HPKE key schedule model (3 × HKDF + AES-GCM over 32 B) | 1.2 µs | 1.2 µs | 0.0 µs |
| AES-256-GCM encrypt 1 KiB / 64 KiB / 1 MiB | 0.72 / 42.1 / 686 µs (1 362 / 1 484 / 1 458 MiB/s) | | |
| AES-256-GCM decrypt 1 KiB / 64 KiB / 1 MiB | 0.73 / 42.0 / 681 µs (1 345 / 1 488 / 1 469 MiB/s) | | |
| Ed25519 sign, 32 B | 13.6 µs | 13.6 µs | 0.0 µs |
| Ed25519 verify, 32 B | 27.0 µs (25.1) | 26.6 µs | 0.2 µs |
| Ed25519 public-key decompress | 3.3 µs | 3.3 µs | 0.0 µs |
| HKDF-SHA256, extract + expand to 32 B | 0.31 µs | 0.30 µs | 0.0 µs |
| SHA-256, 1 MiB | 462 µs (2 164 MiB/s) | 459 µs | 1.5 µs |
| `padding::pad_to_bucket`, 1.4 KB → 2 KiB | 1.98 µs | 1.97 µs | 0.0 µs |
| Rust `hex` encode / decode, 1 KiB | 2.33 / 3.77 µs | | |
| Rust `hex` encode / decode, 1 MiB | 2.30 / 7.88 ms (435 / 127 MiB/s) | | |

What this shows:

- **An X25519 HPKE open is the X25519 DH (41.7 µs) plus a base-point multiply (12.7 µs).** `hpke`
  0.13 derives the recipient's public key from the secret on every open. The schedule and AEAD add
  about 2 µs.
- **An X-Wing decapsulation costs 3.9× an X25519 HPKE open.** #2996 §1.4 is right that one operation
  is "well under a millisecond". But a list view does one per record (§5.4), so it adds up.
- **x-wing 0.1 re-derives the ML-KEM key from the seed on every decapsulation.** Run G measured the
  same decapsulation with the expanded key held: **217.0 µs → 136.1 µs (−37%)**, with byte-identical
  shared secrets (C1).
- **AES-GCM, HKDF and SHA-256 are not the problem anywhere.** Hex is slower than the AEAD it wraps:
  decoding 1 MiB of hex takes 11.6× as long as decrypting 1 MiB.

### 5.3 Argon2id unlock, production parameters (runs B, C)

| Operation | Median | Min | MAD |
|---|---|---|---|
| `device_keys::unlock_device_keys`, correct PIN | 129.7 ms | 128.7 ms | 0.6 ms |
| same, wrong PIN | 130.6 ms | 128.4 ms | 2.2 ms |
| `argon2` 0.5.3 direct, m = 64 MiB, t = 3, p = 1 | 126.8 ms | 125.8 ms | 0.4 ms |
| `argon2` 0.5.3 direct, m = 64 MiB, t = 3, p = 4 | 130.6 ms | 128.8 ms | 0.5 ms |
| `argon2` 0.5.3, p = 4 (run C, unpinned) | 131.4 ms | 128.9 ms | — |
| **`argon2` 0.6.0 with `parallel`, p = 4 (run C, unpinned)** | **81.0 ms** | 80.2 ms | — |

- **p = 4 buys the device nothing today.** `argon2` 0.5.3 computes the four lanes one after
  another, so p = 4 costs the same wall time as p = 1. An attacker with a GPU or ASIC runs the lanes
  in parallel. The defender pays sequential time, and the attacker does not.
- **`argon2` 0.6.0 (released 2026-08-27) has a `parallel` feature.** Run C measured the same
  parameters on four threads: **131.4 ms → 81.0 ms (−38%)**. The 32-byte output was byte-identical
  (`79f8259b…5ce864` for both), as RFC 9106 requires (C2).
- **Phone unlock is the real budget, and it is unmeasured.** TODO (physical device).

### 5.4 Chains, lists and files (runs A, B)

| Operation | Median |
|---|---|
| User sigchain `verify_sigchain`, N = 10 / 100 / 1000 | 0.37 / 3.70 / 37.5 ms (≈ 37 µs per link) |
| `verify_sigchain_link` alone × N = 10 / 100 / 1000 | 0.35 / 3.57 / 35.6 ms |
| Hub-chain link verify, **model** (parse + canonical JSON + SHA-256 + Ed25519), X25519 `group_epoch` link of 917 B | 33.1 µs → 470 links (1 year, #2996 §1.4) = 15.5 ms; 5 years = 77.7 ms |
| same, X-Wing link of 3 285 B | 39.6 µs → 1 year = 18.6 ms; 5 years = 93.0 ms |
| `encrypt_note`, 2 KB, author + 2 admins | 214 µs |
| `decrypt_note`, 2 KB | 64.7 µs |
| `case_record::seal`, 1.4 KB, 1 / 2 / 5 / 10 readers | 75 / 145 / 355 / 719 µs (≈ 71 µs per reader) |
| `case_record::open`, 1.4 KB, 2 envelopes | 64.5 µs |
| **Open 50 / 500 case summaries (180 B), one after another** | **3.09 / 31.6 ms** (30.0 ms in run H) |
| Open-path re-encode (hex → bytes → base64url → bytes, `enc` + `ct`) | 0.56 µs |
| F2: seal / open one 1 MiB segment (AES-256-GCM, bound AAD) | 684 / 677 µs (1 462 / 1 478 MiB/s) |
| hex-encode one 1 MiB segment (what #2996 rules out by sending raw bodies) | 2 526 µs, **3.7× the AEAD** |
| F6: Merkle root over 100 × 1 MiB segments (leaf hashes + tree) | 46.6 ms |
| F6: Merkle root from 100 stored leaf hashes (tree only) | 8.0 µs |

The hub-chain model's link carries a few fields more than #2996 §5.1 (hub id, previous hash), so it
is 93 B larger than the spec's 824 B and 3 192 B. It is a model, not the #2963 implementation.

**Projection, format 2, X-Wing** (sum of measured parts, not an end-to-end measurement): one record
tier open ≈ X-Wing decapsulation 218.6 µs + schedule and AEAD ≈ 2 µs + hex-JSON parse ≈ 12 µs ≈
**233 µs**. That makes **50 summaries ≈ 11.6 ms and 500 ≈ 116 ms on one desktop core**, against
3.1 / 31.6 ms today. With C1 it is about 150 µs per record (500 ≈ 75 ms). With C3 across four cores
it is about 20 ms for 500. Phone figures are TODO (physical device).

### 5.5 Encodings on v2 shapes (run D)

Shapes follow #2996 §2.2 and §2.7: D6-padded tier blobs `u16 format ‖ nonce ‖ ct ‖ tag`, and headers
`{tier, rk, rid, epoch, head{seq, hash}, enc, ct}`, with UUID document and hub ids. CBOR is
`ciborium` 0.2, msgpack is `rmp-serde` 1 (named fields), and byte strings are native byte strings in
both. "Parse" for hex-JSON includes hex-decoding every byte field, because a reader has to.

| Shape | Suite | hex-JSON (D2) | base64url-JSON | CBOR | msgpack | hex-JSON + gzip 6 | hex-JSON + brotli 4 |
|---|---|---|---|---|---|---|---|
| Case record (3 tiers, 2 groups) | X25519 | 8 497 B | 5 886 B | 4 378 B | 4 384 B | 4 875 B | 4 278 B |
| | X-Wing | 21 553 B | 14 592 B | 10 912 B | 10 918 B | 12 573 B | 10 976 B |
| Message (1 tier, thread key) | X25519 | 1 556 B | 1 111 B | 842 B | 843 B | 937 B | 882 B |
| | X-Wing | 3 732 B | 2 562 B | 1 931 B | 1 932 B | 2 203 B | 1 994 B |
| Note (1 tier 2 KB, 3 groups) | X25519 | 5 306 B | 3 669 B | 2 742 B | 2 745 B | 3 075 B | 2 743 B |
| | X-Wing | 11 834 B | 8 022 B | 6 009 B | 6 012 B | 6 946 B | 6 078 B |
| List page, 50 summaries | X25519 | 94 801 B | — | 51 202 B | — | 48 524 B | — |
| | X-Wing | 312 401 B | — | 160 102 B | — | 173 097 B | — |

| Rust parse (and decode) time | Suite | hex-JSON | CBOR | msgpack |
|---|---|---|---|---|
| Case record | X25519 | 18.5 µs | 4.5 µs | 1.45 µs |
| | X-Wing | **74.3 µs** | **5.0 µs** | 1.60 µs |
| Message | X25519 | 3.4 µs | 1.2 µs | 0.35 µs |
| | X-Wing | 7.6 µs | 1.2 µs | 0.39 µs |
| Note | X-Wing | 27.5 µs | 2.6 µs | 0.89 µs |

| Rust serialise time | Suite | hex-JSON (incl. hex encode) | CBOR |
|---|---|---|---|
| Case record | X-Wing | 10.3 µs | 1.4 µs |
| Message | X-Wing | 2.6 µs | 0.5 µs |

The case-record sizes match #2996's own (8.4 KB and 21.4 KB), which is a check on the shapes.

### 5.6 The `bun:ffi` boundary (run F, Bun 1.3.11, server cdylib built with `--features server`)

| Call | Through `ffi.ts` | Native Rust (§5.2, §5.4) | Boundary cost |
|---|---|---|---|
| `sha256`, 32 B (the per-call floor) | 0.32 µs (min 0.17) | — | ≈ 0.3 µs |
| `hpkeSeal`, 32 B, raw bytes in and out | 71.3 µs | 71.3 µs | ≈ 0 |
| `hpkeOpen`, 32 B | 57.4 µs | 56.8 µs | ≈ 0.6 µs |
| `caseSeal`, 1.4 KB, 2 readers (hex in, JSON out, `JSON.parse`) | 162.7 µs | 144.9 µs | **≈ 18 µs (12%)** |
| `caseOpen`, 1.4 KB (`JSON.stringify` in, Rust parses JSON and hex) | 84.9 µs | 64.5 µs | **≈ 20 µs (32%)** |
| JS `Buffer.from(hex)`, 1 MiB / `toString('hex')`, 1 MiB | 759 µs / 492 µs | Rust `hex`: 7 882 µs / 2 299 µs | JS is 10× faster at decode |

A raw-bytes call costs nothing measurable. A JSON-and-hex call costs 12–32% of the operation. The
cost is in marshalling, not in the FFI.

### 5.7 Run-to-run noise

Run H repeated run A three minutes later, under lighter load. The medians moved by −1.7% (HPKE seal),
+3.8% (HPKE open), −2.2% (X-Wing keygen), −0.7% (X-Wing encapsulate), −1.0% (X-Wing decapsulate),
−7.0% (Ed25519 verify) and −5.1% (500 summaries). This is why §4.2 gates on instruction counts and
not on wall clock.

---

## 6. Ranked improvement candidates

Ranked by (user-visible gain) ÷ (cost), with security as a filter, not a weight. Every candidate
lands in stage 3 with before and after numbers taken under §2, plus the existing vectors and negative
tests passing unchanged (#3014's gate).

### C1. Hold the expanded X-Wing decapsulation key in crate state

- **Gain (measured, run G):** X-Wing decapsulation **217.0 → 136.1 µs (−37%)**, with byte-identical
  shared secrets. It applies to every v2 header open, which means every record tier a client reads.
  For a list of 500 that is about 40 ms of one desktop core, and more on a phone.
- **Cost:** low to medium. x-wing 0.1 re-runs `expand_key` (SHAKE-256 → ML-KEM-768 keygen + an
  X25519 base-point multiply) inside every `decapsulate`. The crate either holds the expanded
  ML-KEM-768 `DecapsulationKey` with the X25519 secret and public key in its own X-Wing wrapper (the
  same arithmetic, done once), or upstreams an "expanded" constructor to x-wing. It is decided in
  the D16 contract PR, which already chooses how X-Wing plugs into HPKE. The same applies to D16 check
  4: compute `pk_from_sk` once per epoch secret when the grant is opened, and keep the result.
- **Security:** the expanded key is the **same secret** as the seed, held for the **same lifetime**
  (the epoch secret is already in crate state after its grant is opened). It is larger (about 2 400 B
  instead of 32 B), so the zeroise-on-drop wrapper must cover the expanded form. The crate's
  `aes`/`zeroize` discipline (#1107) applies, and a test asserts the memory is wiped on drop. It does
  not change the KEM, the shared secret, or any wire byte. The D15 vectors prove that. ML-KEM
  decapsulation's implicit rejection is unchanged. **Accept.**

### C2. Run Argon2id's four lanes in parallel

- **Gain (measured, run C):** unlock KDF **131.4 → 81.0 ms (−38%)** on this host, with identical
  output. The gain on a phone depends on its big and little cores, and is TODO (physical device).
- **Cost:** low. Move `argon2` 0.5.3 → 0.6.0 with `features = ["parallel"]` (rayon). This is a major
  version bump: the API moved, and `default-features` changed. On mobile, it puts a rayon thread pool
  in the UniFFI library, so the stage 3 PR measures thread start-up on the phone.
- **Security:** parameters (m = 64 MiB, t = 3, p = 4) and output are unchanged, so an attacker's
  cost per guess is unchanged. The attacker could always parallelise the four lanes. This only lets
  the defender do the same. Memory is still 64 MiB in total, split across lanes. **Accept.** It also
  makes room for a later operator decision to **raise** t at the same wall time. That would be a
  hardening, and it is not proposed here.

### C3. One batched, parallel crate call per list, and decrypt only what is visible

- **Gain:** today 500 summaries take 31.6 ms one after another on one core. Under format 2 that
  projects to 116 ms (§5.4 projection). Batching removes N − 1 boundary crossings: each one costs
  12–32% of a call when the call marshals JSON and hex (§5.6). Working across four cores divides the
  rest by about 4. Decrypting only the rows on screen (≈ 20 on a phone) bounds first paint
  regardless of the list's length. Projection: 500 records ≈ 20 ms with C1 + C3. Measure in stage 3.
- **Cost:** medium. Add a crate entry point that takes a page of sealed tiers and returns the
  plaintexts. Expose it on all three bindings and in `ffi_server`. Wire the desktop and mobile list
  views to it. Then add virtualised rendering where it is missing.
- **Security:** each record still gets its own decapsulation, AEAD open, AAD check and `unpad`.
  Nothing is skipped and no key is shared across records. **Per-record failure must stay
  per-record:** one record failing is returned as that record's error, never as a silent skip (#2961
  A2's "visible alert" rule), and never as a failure of the whole batch that hides which record
  failed. An in-memory cache of opened DEKs, so a re-render does not re-decapsulate, is allowed only
  in crate state, bounded, and wiped on lock. A **plaintext cache on disk is rejected** (§7.4).
  **Accept.**

### C4. Stop re-encoding inside the crate, and keep parsed secret keys in state

- **Gain (measured):** small per call. The open path decodes hex, encodes base64url and decodes it
  again (0.56 µs). It also parses the recipient secret from hex on every open, and `hpke` re-derives
  the recipient public key (12.7 µs of every X25519 open). The seal path base64url-encodes inside
  `hpke_seal` and `seal_multi_reader` immediately decodes it and hex-encodes it again.
- **Cost:** low. It is part of #2771's single-encoding work (D1, D2): one internal byte form, with
  encoding only at the wire edge.
- **Security, a positive one:** `hex` 0.4's decoder branches on each character (`match` over
  `'A'..='F'`, `'a'..='f'`, `'0'..='9'`). Secret keys cross `ffi.rs`, Tauri IPC and `ffi_server` as
  hex and are decoded with it, so the timing depends on the secret's digits. It is not shown to be
  exploitable, but it is avoidable. Holding parsed keys in crate state, and passing handles rather
  than hex secrets, removes the secret from both the hex path and JS memory. Where a secret must cross
  as text, use a constant-time decoder (for example `base16ct`). **Accept.**

### C5. D2 amendment — binary encoding for sealed documents. OPERATOR DECISION

See §6.4. It is ranked here, after C1 to C4, because its cost is the largest of any candidate.

### C6. If D2 stays hex: a faster decoder for non-secret fields, and transport compression on the ingress

- **Gain (measured):** Rust `hex` decodes at 127 MiB/s; JS `Buffer` does 10× better on the same host
  (§5.6). A SIMD decoder (for example `faster-hex` or `const-hex`) would close most of that gap for
  ciphertext. Hex-JSON parsing is 74 µs of a 21.5 KB X-Wing case record, about a quarter of opening
  it. On the wire, gzip brings hex-JSON within 13% of CBOR for the X-Wing case record (12 573 B
  against 10 912 B), and **below** CBOR for the 50-summary X25519 list page (48 524 B against
  51 202 B).
- **Cost:** low.
- **Security:** a SIMD or table decoder is for **ciphertext and public fields only**, never for
  secrets (C4). Transport compression compresses ciphertext (incompressible beyond the hex alphabet,
  so its compressed length does not depend on the plaintext) and server-known clear fields. The
  BREACH condition is a secret and attacker-reflected input in one compressed response. That makes
  responses carrying session or auth tokens the case to exclude, by route, from `encode`. **Accept**,
  with that route exclusion.
- **Finding (outside this spec's scope, for a separate issue):** the two ingress configurations
  disagree. `deploy/docker/Caddyfile.production` has `encode gzip zstd` on the API origin.
  `deploy/ansible/roles/llamenos-caddy/templates/caddy.j2`, which the root `CLAUDE.md` names as the
  ingress, has no `encode` directive. One of them should be made to match the other, after the BREACH
  route review above.

### C7. Database: composite indexes and keyset pagination on hot lists — hypotheses, to be measured

Not measured here (no seeded database). They come from reading the schema and the services:

- `listCases` (`apps/worker/services/cases.ts`, around line 530) filters by `hub_id` (plus optional
  blind-index hashes), orders by `updated_at DESC`, and pages with `LIMIT/OFFSET`. It also runs a
  separate `count()` for every page. `case_records` has `hub_id` indexes, but none on
  `(hub_id, updated_at)`.
- `notes` has separate `hub_id` and `created_at DESC` indexes. The list orders by `created_at DESC`
  within a hub.
- `conversations` is indexed on `(hub_id, status)`, and the list orders by `last_message_at DESC`.
- **Stage 2** runs `EXPLAIN (ANALYZE, BUFFERS)` on a seeded database (§3.3) before any index is
  added.
- **Security:** each candidate index is on columns that are already clear to the server (`hub_id`,
  timestamps, status hashes). A keyset cursor carries `(updated_at, id)`, which are clear too. No
  index may be built on a value derived from plaintext beyond the blind indexes that already exist.
  An index on a timestamp adds no knowledge the server lacks. **Accept, if measured.**

### C8. Incremental chain verification from a locally sealed verified head

- **Gain (arithmetic from §5.4):** a full replay is ≈ 37 µs per user-sigchain link and ≈ 40 µs per
  X-Wing hub-chain link, so 5 years of one hub is ≈ 93 ms on a desktop core, every time. Verifying
  only the links added since the last verified head makes that roughly constant.
- **Cost:** medium. It belongs in #2963's client verifier: store `{chain id, seq, hash, derived
  state}` sealed with `seal_device_local` (a new purpose in `DEVICE_LOCAL_PURPOSES`), and resume
  from it.
- **Security:** every link is still verified, once, by this device. The cached head is AEAD-sealed
  under a key derived from the device's own secret, so tampering with it is detected, and a forged
  head needs the device key. The **fork check** (#2963 §2 head references) still compares the
  stored head with what the server serves now, so a server that rewrote history is still caught. A
  failed open of the cached state means a full replay, never trusting the server's chain without
  verifying it. **Accept.**

### C9. Ed25519 batch verification for chain replay — accept only with one verification equation everywhere

- **Gain:** not measured here. Batch verification typically halves the per-signature cost.
- **Security, which decides it:** batch verification uses the cofactored equation. Single
  verification in `ed25519-dalek` 2 uses the cofactorless one. A crafted signature can pass one and
  fail the other. If the Rust verifier batched and another verifier did not, two clients would
  disagree about whether a chain is valid. For an authority chain, that is a consensus split. **Accept
  only if** every verifier of the chain, on every platform (all of them go through the crate), uses
  the same equation, pinned by a negative vector with a small-order component. Otherwise reject.
  After C8, replay is rare, so the gain is small. **Low priority.**

### C10. Raw bytes at every boundary that carries a large blob

- **Gain (measured):** hex-encoding a 1 MiB segment costs 3.7× its AEAD (§5.4). JSON and hex
  marshalling cost 12–32% of a `bun:ffi` call (§5.6).
- **Cost:** low for files, which F2 and #2996 already specify as raw request and response bodies.
  On desktop, segments go through the Rust shell rather than JS memory, using Tauri v2's raw-bytes
  IPC responses and channels rather than JSON strings. On mobile they use UniFFI byte arrays.
- **Security, a positive one:** fewer plaintext copies in JS memory, which cannot be zeroised, and
  less plaintext in IPC serialisation buffers. **Accept.** This is a budget for the F2 contract PR,
  not new work.

### 6.4 The D2 question: binary encoding instead of hex-in-JSON — OPERATOR DECISION

D2 (signed off) chose lowercase hex for every byte string in JSON, refused base64url, and made large
binaries raw bodies. #3014 says a binary encoding would be **an operator decision that amends the
signed-off spec**. This section gives the measurements and the security analysis. It does not choose.

**Options:**

| Option | What changes | Wire size, X-Wing case record | Rust parse | Cost |
|---|---|---|---|---|
| **(a) Keep D2** (hex in JSON), plus C6 | nothing in the format. A faster hex decoder for ciphertext, transport compression on the ingress | 21 553 B (12 573 B gzip'd in transit) | 74.3 µs | low |
| (b) base64url in JSON | D2's refused alternative | 14 592 B | not measured | low to medium. It reopens #1649 and is harder to pin with a regex |
| **(c) CBOR (RFC 8949) for sealed-document bodies only** | `application/cbor` for tier blobs and headers on the record routes. JSON stays for everything else. Signed objects stay canonical JSON (D10) | **10 912 B (−49%)** | **5.0 µs (−93%)** | high: codecs on TS, Swift and Kotlin, schema validation on the server for decoded byte lengths, OpenAPI, test vectors in both forms |
| (d) msgpack, same scope as (c) | as (c) | 10 918 B | 1.6 µs | as (c), with no IETF standard and no deterministic encoding profile |

**Gain in context.** At the user, the parse saving is about 69 µs per X-Wing case record, which is
a quarter of opening one (C1 makes it a third). The wire saving is 49% where the response is
uncompressed, and 13% where gzip is on. Without C6, today's Ansible ingress sends uncompressed
(§6, C6 finding). The memory saving is the same 2× in every in-flight copy, in every language.

**Security analysis.**

- **No crypto property depends on the transport encoding.** AADs are defined over raw bytes (D3),
  and signatures over D10 canonical JSON. Changing how a blob travels changes no byte under a tag or
  a signature. The D15 vectors prove that in both forms.
- **Never sign or hash the CBOR form.** Two canonical forms for one signed object is how a
  signature-malleability bug starts. Under (c), D10 stays the only signing form. A CBOR document is a
  transport container whose contents are verified as bytes.
- **Parser attack surface.** CBOR adds a parser on every platform. Its classic failures are
  indefinite-length items, deep nesting, oversized declared lengths, duplicate map keys and tags.
  Under (c) the profile is strict: definite lengths only, no tags, no floats, a depth limit, a length
  cap per field, and duplicate keys refused. The negative vectors cover each rule. The JS side is a
  new dependency on the worker, so it adds supply-chain exposure.
- **Length checks are unchanged in strength.** D2's regex pins `enc` at 64 or 2 240 hex characters
  per suite. CBOR pins the decoded byte string at 32 or 1 120 bytes. Both are exact.
- **No new length leak.** Every record shrinks by the same deterministic factor. D6 padding happens
  inside the blob and is untouched.
- **Neutral on plaintext:** an encoding of ciphertext moves no plaintext anywhere.

**What signing (a) means:** the format stays as signed, and C6 recovers most of the wire size where
compression is on. **What signing (c) means:** an amendment to D2, made in the D16 contract PR
before any format-2 row exists. That is the only cheap moment, because afterwards every client reads
both forms.

---

## 7. Rejected, and why

### 7.1 Compression before encryption (P5)

**What it would gain (measured, run E: deflate level 6 and zstd level 3, averaged over 8 windows
of real text).** Prose is the repo's English specs and the Spanish locale file. JSON is the English
locale file.

| Plaintext | Size | zstd ratio | D6 bucket, raw → zstd | Padmé, raw → zstd |
|---|---|---|---|---|
| English prose | 180 B / 300 B | 1.15× / 1.28× | 512 → 512 / 512 → 512 | 192 → 160 / 304 → 240 |
| | 1 400 B | 1.70× | 2 048 → 1 024 | 1 408 → 832 |
| | 2 000 B | 1.79× | 2 048 → **1 024 or 2 048, depending on the text** | 2 048 → 1 152 |
| | 16 000 B | 2.30× | 16 384 → 8 192 | 16 384 → 7 168 |
| Spanish prose | 1 400 B / 16 000 B | 1.98× / 2.50× | 2 048 → 1 024 / 16 384 → 8 192 | |
| JSON | 1 400 B / 16 000 B | 2.33× / 3.06× | 2 048 → 1 024 / 16 384 → 8 192 | |

So compression gains **nothing** for tiers of 508 B or less (the D6 minimum bucket swallows it: case
summaries, messages, statuses). It halves the bucket for tiers above about 1 KB: case fields, long
notes, transcripts. For files it gains about nothing, because images, audio, video and PDFs are
already entropy-coded (not measured here).

**Why it is rejected.** Compressing before encrypting makes the ciphertext length depend on the
plaintext's **content**, not only its length. That is a new length leak, which constraint 5 forbids.
It is the CRIME/BREACH mechanism:

- **Who sees the length?** The server, which this design treats as an adversary for content, plus
  anyone who copies the database or a backup, and a network observer through TLS record sizes.
- **Where attacker-influenced content meets secrets in one plaintext:**
  - **transcripts** (the caller's words and the responder's in one blob);
  - **notes** (a responder writes down what a caller said, next to names and addresses);
  - **case fields** that hold caller-supplied text beside PII;
  - **conversation exports**.

  A hostile caller who can also see ciphertext lengths, such as a state actor holding the server, can
  choose words and watch whether the bucket moves. Each call is one sample. A transcript tier above
  1 KB is exactly where compression would have helped.
- **Padding quantises the leak; it does not remove it.** The table shows it: 2 000-byte windows of
  the same English text land in the 1 024 bucket or the 2 048 bucket **depending on what they say**.
  D6 hides length within a power of two. Once compression is applied, the bucket reflects
  compressibility, which is a function of content. F3 Padmé leaks O(log log L) bits of length.
  With compression, those bits describe the content too.
- **The only leak-free form gains nothing.** Compress, then pad to the bucket the **uncompressed**
  length would have used: the wire size is unchanged and CPU is spent. Padding to a size derived from
  public metadata (for example call duration) leaks an overflow bit whenever the content compresses
  worse than the bound.

**Where it would be safe:** only where no attacker-influenced byte shares a compression context with
any secret, **and** nobody who matters can see the length. Neither holds for any sealed tier or file
in this system. **Rejected everywhere, for every sealed tier and file.**

Transport compression of **ciphertext** (C6) is a different thing. Ciphertext is random, so its
compressed length does not depend on the plaintext, and C6 is accepted with its route exclusion.

### 7.2 Lowering Argon2id cost, or using `test-kdf` parameters in any release

Rejected by constraint 1. Unlock time is cut by C2 instead, and the parameters do not move.

### 7.3 Smaller D6 buckets for small tiers

This would shrink the 42% padding overhead #2996 §2.6 measured on X25519 records. It was D6's own
alternative, and the operator declined it. A smaller minimum bucket leaks more about short notes and
status displays. Rejected by constraint 5.

### 7.4 A plaintext cache on disk (decrypted lists, search index)

It would make second opens instant. It puts plaintext somewhere new: a file that outlives the
session and the lock. Rejected by constraint 6. The in-memory DEK cache in C3 is the allowed form.

### 7.5 One HPKE ephemeral for several recipients, deterministic encapsulation, a DEK for a document's lifetime

- **A shared ephemeral** saves one base-point multiply per extra X25519 recipient, and cannot work
  at all for X-Wing. RFC 9180's analysis assumes a fresh encapsulation for each recipient.
- **Deterministic encapsulation** is a hidden, warned-against API in x-wing (`encapsulate_deterministic`), meant for test vectors.
- **A lifetime DEK** is D5's declined alternative: a device that once read a document would keep
  reading every later edit.

All three are rejected by constraint 4, and the last by D5 as well.

### 7.6 Skipping chain or signature verification for server-asserted state

"The server already checked it" is precisely the trust the hub chain exists to remove. Rejected by
constraint 3. C8 is the allowed form: verify once, then remember the result under the device's own
seal.

### 7.7 Dropping X-Wing (D16 (b)) to save bytes and time

It would save 2.5× in record size and 3.9× in decapsulation time. It is the operator's signed-off
D16 decision, made for harvest-now-decrypt-later, and it is outside a performance spec's authority.
Rejected by constraint 2. C1 and C3 cut the time instead, and the D2 question (§6.4) is where the size is decided.

---

## 8. Stage 2 work, as issues to file under #3014

1. Crate benches in `packages/crypto/benches/`: criterion for wall clock and iai-callgrind for the
   gate, covering every §3.1 row, with the production-parameter assert. Add the instruction snapshot
   and the PR gate (§4.2).
2. The payload-size snapshot through the crate for every §3.4 shape (X25519 and X-Wing), as a PR
   gate.
3. The `bun:ffi` and Tauri IPC boundary harnesses (§3.2), scheduled weekly on a quiet Linux host.
4. k6 extensions for the hot routes in §3.3, a seeded-database fixture, and `EXPLAIN` capture.
   Scheduled.
5. Client scenario spans on all three clients (§3.5), plus Macrobenchmark (Android) and XCTest
   metrics (iOS), run on physical devices.
6. The mobile power protocol (§3.7) as a release checklist item, and a MetricKit debug screen in
   internal builds.
7. The arm64 crate run over `adb` on a physical Android phone.
8. Separate issues for the findings: the ingress `encode` mismatch (C6), and hex decoding of secrets
   at the boundaries (C4).

**Stage 3** takes C1, C2, C3, C4, C8, C10, C6 or C5 (whichever the operator signs for D2) and C7
(once measured), in that order. Each lands with before and after numbers.

## 9. Sign-off

The operator signs off P1–P6, answers Q1 (§4.3), and chooses an option for the D2 question (§6.4).
Until then this spec is a held draft.
