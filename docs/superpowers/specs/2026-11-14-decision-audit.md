# Decision audit: the 27 items labelled `needs-decision` / `needs-human` (2026-11-14)

Read-only pass, checked against `origin/main` @ `986ff2340`, the full issue threads, and the operator rulings
recorded in memory and `~/tier-overnight-status/` (operator-questions-2026-10-27 / -10-30,
product-direction-2026-10-30, bundles-d2-d3-d4, bundles-d5-d7-d8).

**Status:** the audit itself was a read-only pass. Its recommended actions were then applied through the GitHub API on 2026-11-14 (see *Applied* at the end), after each row's evidence was re-checked against `origin/main` @ `b2e4a35a2`.

## The count

| Verdict | n | Items |
|---|---|---|
| **Needs the operator** | **6** | #1342, #1674, #1495, #741, #719, #745 |
| Already answered (label is stale) | 6 | #2170, #2175, #2179, #2177, #1229, #1142 |
| Dead: fixed, superseded, or regressive | 4 | #1245, #1388, #954, #1314 |
| Engineer decides | 11 | #1008, #1194, #1204, #1209, #1240, #1331, #1332, #1568, #1592, #2780, #1030 |

Of the 6 operator items, only **3 are real choices** (#1342, #1674, #1495). The other three (#741, #719, #745)
are **credential or account actions** the operator alone can perform, each with at most one small yes/no
attached. One "already answered" item, **#1229**, also leaves an operator *action*: make the GHCR package public.
So the operator's list is **3 decisions + 4 actions**, not 27.

## Table

| # | Verdict | Evidence | Recommended action |
|---|---|---|---|
| **#2170** provider fallback | already-answered | D8 (2026-10-25, plus an addendum) and the 2026-10-29 decisions in the thread: reuse `voice.unavailableMessage`, an optional per-hub outage prompt, play every enabled language in turn, no forwarding, rsync to the second VPS, Telnyx→TeXML, co-located PBX only. | Remove `needs-decision`. Dispatchable per `bundles-d5-d7-d8.md` (B-D8-*). |
| **#2175** rollback vs forward-only migrations | already-answered | Operator, 2026-10-29: *"design migrations as expand/contract … A backup before every upgrade is mandatory."* Also 2026-10-30: the pre-upgrade snapshot is kept unencrypted, only on FDE hosts, so automatic rollback can restore it. | Remove `needs-decision`. Engineer: a CI rejection of destructive DDL outside a "contract" release, plus the snapshot restore in `update.yml`'s rescue. |
| **#2179** CAPTCHA failures | already-answered | 2026-10-29: two attempts, star to repeat, metric only with no caller number, off by default. 05:04: *"CAPTCHA failures never auto-ban a number."* The residue is #2302. | Remove `needs-decision`. Engineer implements the attempts and the metric. |
| **#2177** single platform admin key | already-answered / superseded | D1 (2026-10-24) removes `ADMIN_DECRYPTION_PUBKEY`. The thread's own 2026-10-29 comment says the issue "would make things worse" as written. #2307 (merged 2026-11-02) landed `readersFor` and the per-hub escrow (`hubs.escrow_pubkey`). | Remove `needs-decision`. Propose closing as superseded by D1/#2307, or retitle it to the escrow re-wrap/handover flow (engineer work under D1). |
| **#1229** release image address | already-answered (+ operator action) | Operator, 2026-11-10: *"the GHCR image should be pushed"* and the GHCR package must be public for anonymous self-hoster pulls. `site/src/config.ts:56` already derives `ghcr.io/llamenos-hotline/llamenos-platform`, matching `docker-stable`. An anonymous pull of that address returns **403**. The registry gives the same answer for a nonexistent name, so "private" and "never created" can't be told apart from outside. | Replace `needs-decision` with `needs-human`. **Operator action:** set the org package to public, then confirm `verify-release-live` surface 6 goes green. |
| **#1142** cleanupStale has no caller | already-answered | The ringing semantics were the only decision, and the operator made it: `ring = scheduled_now ∩ clocked_in` (#1469, merged 2026-10-04). 2026-10-24 triage: *"the only thing left is that cleanupStale has no caller."* Still true: `active-shifts.ts:190` has no caller. | Remove `needs-human`. **Dispatchable**, backend/linux: a scheduler runs `cleanupStale`, with one timeout constant shared with the heartbeat. |
| **#1245** AdminSidebar/Events UI tests | dead (fixed) | `AdminSidebarUITests` was replaced by `AdminNavigationUITests` (#1776), and `AdminSidebarView` was deleted. `EventsUITests.navigateToEvents()` now goes Admin → `admin-events`, enables case management, and creates its own event. `ci-quarantine.txt` is empty. | Propose close. |
| **#1388** nightly iOS start time | dead (premise wrong) | 2026-11-09 measurement: the delay is GitHub's scheduled-dispatch latency, not runner starvation (0 min queue wait in 38 of 39 runs), and PR iOS job waits inside and outside the nightly window don't differ. The label was added only so it would "stop reading as dispatchable". | Remove `needs-decision`. Propose close as mitigated. (Mac-runner contention is a separate question for the Mac host.) |
| **#954** staging/demo backend | dead / **regressive** | `deploy-demo.yml` and demo mode were removed (#1651). `verify-release-live.yml` retired Surface 2 because it needed staging hostnames in GitHub. The issue asks for `DEMO_SSH_PRIVATE_KEY`, inventory, vault password and `STAGING_*` vars in Actions, which breaks the standing rule that GitHub must not know deployment internals. | Remove `needs-human`. Propose close. If a tester backend is still wanted, that is a local Ansible deploy and a new issue. |
| **#1314** iOS triage/event Givens | dead (superseded by #2033) | The Events half is fixed on main (it creates the event through the real sheet). The three triage tests `XCTSkip` with *"needs the typed report form, unreachable on iOS (#2033)"*, so the residue lives in #2033. ⚠ Salvage commit `5995e5181` (`salvage/fleet/ios/1314-…`) holds an **iOS-side decode shim** for #2033. That is a client workaround for a server/codegen defect (the server mapper omits `allowFileAttachments`/`numberingEnabled`), so do not land it as-is (fix upstream). | Remove `needs-human`. Propose close in favour of #2033. Route the salvage to #2033's worker as reference, not as the fix. |
| **#1008** window-global BDD state | engineer (hold expired) | The 2026-11-11 hold said *"Lift it when #2706 merges."* #2706 merged 2026-11-12. Salvage `e50d39124` (32 files) still exists locally. | Remove `needs-human`. **Dispatchable** (desktop/linux) from the salvage commit, rebased onto `origin/main`. The 2026-11-11 brief already exists. |
| **#1194** 27 env/clock scenarios | engineer | The "decision" is which test tier hosts each scenario (unit with injected env/clock, a serial Playwright project, or a rewrite). That is test architecture. The three features are still `@wip` → #1194. | Remove `needs-decision`. Engineer picks per scenario. Rule: no empty-body steps (#709), and event-based clocks, not padding. |
| **#1204** template catalogue vs EntityTemplatesService | engineer | The bundled catalogue (Epic 317, `packages/protocol/templates/*.json`) is the shipped contract and the carrier for Templates v2 (product direction 2026-10-30). The scenario is `@fixme` → #1204. | Remove `needs-decision`. Rewrite the scenario against the catalogue. Remove `EntityTemplatesService` only if every capability it has survives in the catalogue (de-duplication). Otherwise keep it and report, per "unused is not dead". |
| **#1209** platform tags no runner collects | engineer | Validator design. Still live: there is no collection model in `validate-coverage.ts`, and Android copies only `platform/mobile/`. | Remove `needs-decision`. Engineer adds the runner-collection model and retags. Runner work stays with #765. |
| **#1240** iPhone six tabs | engineer / superseded | The "accept More" branch is already on main: `testAllTabsExist` asserts reachability (#2057/#2058). The permanent answer is P6/§5.1, which the operator adopted 2026-10-30: one navigation definition in `packages/protocol`, filtered by permission, rendered by all three platforms (M2). | Remove `needs-decision`. Fold "Shifts (clock-in) and panic wipe reachable in one tap on compact width" into the §5.1 navigation spec. **No issue exists for §5.1 nav-as-data** (for m1-strategy's register). |
| **#1331** two DID stores | engineer | Design work. The constraints are already set: one store keyed by provider config (Q6/org model 2026-10-30, where numbers belong to org/hub provider accounts), and E.164 normalised at the webhook boundary. The issue's "DID in E2EE hub state?" question is answered by the standing rule plus the D2 precedent: encrypt at rest and look it up through a keyed blind index. The number arrives in plaintext on every webhook anyway. Still live: no `hub_numbers` table, and `getHubByPhone` sits at `settings.ts:2885`. | Remove `needs-decision`. Backend/linux, shared schema first if the protocol changes. |
| **#1332** PBX-wide trunk provisioned per hub | engineer | Settled in substance. 2026-10-29: *"A PBX on a different host from the server is not supported for now (co-located only)"*, which means the PBX is deployment configuration. 2026-10-30: the organisation owns PBX accounts. Still live: `/create-sip-trunk` (`provider-setup.ts:737`) takes a hub-supplied ARI URL. | Remove `needs-decision`. Engineer: ARI comes from env as in sip-bridge, gated on a **platform permission** (never a role name), and the SSRF guard question goes away. Named per-hub trunks wait for the org epic (#2294). |
| **#1568** telephony creds unredacted | engineer, GATED | Still live: `GET /telephony-provider` (`settings.ts:463-486`) returns `getTelephonyProvider()` decrypted. The issue itself rules out option 3. Redact-on-read (write-only secret) is the standard and fits the threat model, so there is no tradeoff to escalate. | Remove `needs-decision`. Engineer: mask on read, and give #1565's oracle a sanctioned way to get the credential it seeded. Verify by breaking it. Needs `crypto-security-reviewer`, not `PASS:carried`. |
| **#1592** CodeQL per-branch dismissals | engineer | Tooling choice, and the symptom is gone (`paths-ignore: deploy/docker/tests` since #2077). `query-filters` can't scope by path, but a SARIF post-filter step can scope rule *and* path. That is the engineer's call. The inert `// codeql[...]` comments are still at `sip-register.ts:23` and `asterisk-register.e2e.ts:157`. | Remove `needs-decision`. Engineer picks: keep `paths-ignore`, or a path-scoped SARIF filter with a break-test. Mechanical: delete the inert comments. ⚑ `codeql.yml` serialises. |
| **#2780** role names plaintext | engineer | Three standing rulings settle it. **2026-11-04** no hubless data in M1, so a deployment-wide custom role is the defect and roles become hub-scoped (`LABEL_HUB_ROLE_ENCRYPT` fits). **D1**: no per-super-admin sealing of hub vocabulary. **D11/C3 (2026-10-29)**: encrypting vocabulary is deferred to M2 behind #1042. Where an org catalogue sits (org-model B5) is already in the operator's org-model queue (#2294). Don't re-ask it here. | Remove `needs-decision`. Engineer, M2 behind #1042. Slug must be random, not derived from the name. Note for m1-strategy: `roles` sits in `CROSS_HUB_TABLES`, which is in tension with the 2026-11-04 ruling. |
| **#1030** revocation rotates nothing | engineer (M2) | The design is specified: PROTOCOL.md "On member departure" (:1071), and CLAUDE.md's cascading lazy rotation. "Keep PUK or remove it" is answered by the operator's 2026-11-14 "unused is not dead" ruling: the PUK layer is finished work waiting for its consumer. M2 per D4 and the milestone. | Remove `needs-decision`. COUPLED: crypto/protocol first, then desktop/iOS/Android. **mac** cost, GATED crypto review. Matches `m2-phase:C-revocation-rotates`. |
| **#1342** Volunteer call history | **OPERATOR** | Clock-in, schedule and request-join are fixed (`permissions.ts:364`). Still open: `calls:read-history` is not in the default bundle, and under D2 every holder of it sees caller numbers. That is a "what may a user see" call. | Keep the label. Post the `## Decision needed` comment below. |
| **#1674** single review runner | **OPERATOR** | Still exactly one `fleet-review` runner (`llamenos-review-box`, busy). More capacity means hardware, or credentials on another host. The absent-context detection already exists (#1673 `ABSENT_PENDING`/`ABSENT_SETTLED`). | Keep. Comment below. |
| **#1495** invariant #17 | **OPERATOR (sign-off)** | The principle is already canonical in the spec. §11, "The defect class behind most of these" (#1645, 2026-10-07), says "a signal that is absent … rendering as success". It is **not** in `.claude/agents/fragments/_worker-rules.md`, which is deliberately unowned worker-behaviour authority. | Keep. Comment below. |
| **#741** macOS Developer ID | **OPERATOR (account action / scope)** | `tauri-release.yml:236-251` waits on `APPLE_*`. The Mac holds only Distribution/Development identities. | Keep `needs-human`. Comment below. |
| **#719** RustFS + PAT + updater key custody | **OPERATOR (credentials + one conflict)** | 2026-11-10: *"rustfs should be uploaded"* (decided). Still no `RUSTFS_*` or `RELEASES_REPO_PAT` secrets. `tauri-release.yml:538-546` refuses without all five, one of which is `RUSTFS_ENDPOINT`. | Keep `needs-human`. Comment below. |
| **#745** iOS signing secrets + APNs | **OPERATOR (account action)** | `mobile-release.yml:456-504` consumes the four secrets. Building the IPA and attaching it to a GH Release is inside the 2026-11-10 boundary. TestFlight upload stays local (fastlane, #744). | Keep `needs-human`. Comment below. |

## `## Decision needed` comments (for the 6 kept; posted verbatim)

### #1342

## Decision needed
**Should the default Volunteer permission bundle let a volunteer see call history, given that under D2 anyone holding call-history permission sees caller numbers?**
- **(a) Add `calls:read-history` to the default Volunteer bundle.** A one-line change in `packages/shared/permissions.ts`. Every volunteer can read every call and caller number in their hub.
- **(b) Add a new `calls:read-history-own`** that covers only calls the volunteer answered, with those records also sealed to the answering volunteer. This needs reader-set work (a `readersFor` purpose), so it is M2-sized.
- **(c) Grant nothing.** Clients render the 403 as a permission state, not "No call history" (#2121). Volunteers find their own calls through their notes.

**Recommendation: (c) for M1, revisit (b) in M2 if pilots ask.** Least privilege, and (a) widens caller-number exposure to the largest group of users. Nothing functional depends on it now that #1341 (saving a note) is closed.
**Blocked:** #2121 (how to render it). **Deferrable:** no. The default bundle ships in M1.
*Board:* Urgency = Decide for M1 · Area = roles/permissions · Blocks = 1 · Blocked items = #2121

### #1674

## Decision needed
**Do you want a second review runner, which means a second host holding the review engine's credential, to raise merge throughput?**
- **(a) Keep one runner.** The ceiling stays about one review per 5–10 min, and every merge group serialises behind it.
- **(b) Add a second credentialed review host.** Roughly doubles review throughput. Costs one machine (or VM) and a second copy of the engine credential to custody and rotate.
- **Never:** relabel the hetzner runners without the credential. A review that "succeeds" without reviewing is worse than a slow queue.

**Recommendation:** first a 5-minute engineer check of whether the credential is already reachable from the hetzner box. If it isn't, **(a) for now** and spend engineering on fewer reviews (`PASS:cached`, no speculative re-reviews). Choose (b) only if the queue stays the bottleneck after that. Stuck-run detection already exists (#1673).
**Blocked:** nothing directly. This is the merge-throughput ceiling. **Deferrable:** yes.
*Board:* Urgency = Can defer past M1 · Area = fleet/CI · Blocks = 0

### #1495

## Decision needed
**May a non-fleet PR add one paragraph to `.claude/agents/fragments/_worker-rules.md` saying "a success signal must be distinguishable from an absent one (satisfied / unsatisfied / could-not-ask)"?**
The principle has been canonical in the spec's §11 since #1645, so this is about whether workers inherit it in their prompt. Yes = one small PR, operator-reviewed because the path is deliberately unowned. No = it stays spec-only.
**Recommendation: yes.** It is already policy, and the fragment is the only place a worker reads it.
**Blocked:** nothing. **Deferrable:** yes.
*Board:* Urgency = Can defer past M1 · Area = fleet governance · Blocks = 0

### #741

## Decision needed
**Will you create a Developer ID Application certificate and notarization credentials, or should macOS testers wait until after M1?**
- **(a) Create it.** No extra cost on the existing Developer Program membership. Six `APPLE_*` secrets. Store them in a protected `release` environment, not at repo level (#2135).
- **(b) "macOS later".** Linux and Windows installers ship. macOS testers get nothing.

**Recommendation:** (a) if any M1 tester is on macOS, otherwise (b).
**Blocked:** macOS installers only. **Deferrable:** yes, if the cohort has no macOS testers.
*Board:* Area = release/desktop · Blocks = 1 (macOS `.dmg`) · Urgency left empty (it depends on the cohort)

### #719

## Operator action needed (one yes/no inside)
1. **Yes/no:** the 2026-11-10 ruling keeps the RustFS updater upload in CI. `tauri-release.yml` requires `RUSTFS_ENDPOINT` as an Actions secret, and the 2026-10-30 rule says no object-store endpoint goes into CI. **Is the updater endpoint an accepted exception?** If it isn't, the upload has to move local and the workflow changes (engineer).
2. If yes: set `RELEASES_REPO_PAT` (Contents: write on `Llamenos-Hotline/llamenos-releases` only) and `RUSTFS_ACCESS_KEY`/`SECRET_KEY`/`ENDPOINT`/`STAGING_BUCKET` (staging prefix only), in a protected environment (#2135). Record scopes and expiry here.
**Recommendation:** accept the exception, scoped to a staging-prefix-only key in a protected environment.
**Blocked:** the self-hosted auto-update channel (#714/#715). **Deferrable:** yes. Not a first-release blocker.
*Board:* Urgency = Can defer past M1 · Area = release/infra · Blocks = 2 · Blocked items = #714, #715

### #745

## Operator action needed
Set `IOS_CERTIFICATE_BASE64`, `IOS_CERTIFICATE_PASSWORD`, `IOS_PROVISIONING_PROFILE_BASE64` and `APPLE_TEAM_ID` in a protected environment. Confirm the App Store Connect record and the Internal Testing group. Create the APNs key and put `APNS_*` in the backend's vars (local, never in GitHub). No decision is involved. TestFlight upload stays local (#744).
*Board:* Area = release/iOS · Blocks = 1 · Blocked items = #744 · Urgency left empty (it depends on whether the M1 cohort includes iOS)

## Notes for m1-strategy's register (not duplicated here)
- No issue exists for §5.1 nav-as-data (adopted 2026-10-30). #1240's compact-width requirement belongs in it.
- `roles` is in `CROSS_HUB_TABLES`, which conflicts with the 2026-11-04 no-hubless-data ruling (#2780). Org-model B5 placement is still open under #2294.
- Salvage `5995e5181` is a client-side shim for #2033 and must not be landed as #2033's fix.

## Applied (2026-11-14)

Before acting, every row's evidence was re-checked against `origin/main` @ `b2e4a35a2`. All 27 still held, so no item was skipped.

- **Labels.** `needs-decision` removed from #2170, #2175, #2179, #2177, #1245, #1388, #1194, #1204, #1209, #1240, #1331, #1332, #1568, #1592, #2780 and #1030. `needs-human` removed from #1142, #954, #1314 and #1008. #1229 changed from `needs-decision` to `needs-human`. Each of those 21 got one comment saying why the label came off and who decides now, with the evidence quoted from this table.
- **Decision comments.** The six drafts above were posted verbatim on #1342, #1674, #1495, #741, #719 and #745. Their labels were kept.
- **Closed.** #1245 (completed), #1388, #954 and #1314 (not planned). #2033 got a note that salvage `5995e5181` is reference material only: it is a client-side decode shim, and the fix belongs upstream in the server mapper or codegen.
- **Board** (project #1, "Decisions & M1 Strategy"). The 20 items that no longer need the operator were removed, leaving 7: #1342, #1674, #1495, #741, #719, #745 and #1229. `Urgency`, `Area`, `Blocks`, `Blocked items` and `Recommendation` were set from the *Board:* lines above. Fields the table leaves empty stayed empty: Urgency on #741, #745 and #1229, and Blocks on #1229. `Area` is mapped onto the board's fixed options: roles/permissions → Roles & permissions, fleet/CI and fleet governance → CI & pipeline, release/* → Release & publishing.
- **Result.** The open issues carrying `needs-decision` are now exactly #1342, #1674 and #1495. Those carrying `needs-human` are exactly #741, #719, #745 and #1229.
