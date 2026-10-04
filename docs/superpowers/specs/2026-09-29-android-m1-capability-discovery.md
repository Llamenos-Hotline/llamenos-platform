# Android M1 capability discovery: what the app does against a live server, and the route to real coverage

**Date:** 2026-09-29 · **Measured at:** `origin/main` `774143876` · **Follows:** #1323 (audit), #765 (feature subset)
**Siblings:** iOS #1271 → #1290 (found #1293), desktop #1276 → #1291

## The question, and the short answer

*Does Android save a note, take a shift, handle a call, and unlock with a PIN against a live server?*

**No, not as a volunteer, and not after the first lock.** The real app was driven on an emulator against a live server, as the pilot persona (Volunteer) and as a hub admin. Results:

- **PIN:** the unlock pad submits at 6 digits, but the PIN is 8. After any restart, activity recreation or lock, the correct PIN cannot unlock the app (#1338). The Lock button itself is a no-op: it drops the keys and leaves the dashboard on screen (#1339).
- **Notes:** no reachable screen saves a note the server accepts (#1341). A saved note would not be shown back to its author (#1024, confirmed live).
- **Shifts:** the Android shift UI works end-to-end **for a hub admin**. A **volunteer** gets 403 on clock-in, on the schedule and on call history, because the default Volunteer role lacks those permissions (#1342).
- **Calls:** an answered call that already exists when the dashboard loads is shown and can be hung up. A live ring or answer never reaches the app (the relay is dead, #1016). There is no in-app answer control (#1188). Call History cannot decode for any role (#1343).
- **Hubs:** listing and switching hubs **work**. The app never selects a hub by itself, so a new user is scoped to nothing until they find Hub Management (#1340).
- **Conversations:** the app bypasses the active hub, and the list fails to decode (#1344).
- **Enrolment:** absent. A fresh install creates an identity the server never learns about. Every probe had to enrol through a dev backdoor (#1345, the M1 framing of #766).

**Auth does change the picture.** Four of the six areas fail first on an auth or scoping defect (enrolment, active-hub choice, permissions, PIN), before their own logic runs. The fixes are ordered accordingly (below).

## Method

**Instrument.** `apps/android/app/src/androidTest/java/org/llamenos/hotline/discovery/M1CapabilityProbe.kt` (this PR): ten JUnit flows that drive the real Compose UI.

- Every step either succeeds or fails the test with the state it saw (visible test tags and on-screen text). Nothing is caught.
- Evidence goes to `adb logcat -s PROBE` and the server's request log (method, path, status).
- Backdoors are limited to what the app has no UI for, each logged `BACKDOOR`: identity enrolment (`test-add-hub-member`), shift seeding, and telephony/SMS simulation.
- Unlike `ScenarioHooks`, the probe **does not write `ActiveHubState`**. It lets the app choose a hub, records the choice, and falls back to the user's path (Dashboard → Hub Management → tap) only when the app chose nothing.

**Environment.** A server on its own port (3171) and its own Postgres database (per-worktree DB, `ENVIRONMENT=development`, `ADMIN_PUBKEY` = CI's test admin), started fresh for each batch. Emulator `test-emu-3` (API 34 x86_64, animations off, `-no-snapshot-save`) was booted per batch. Each probe method ran in its own `am instrument` process after `pm clear org.llamenos.hotline.debug`. The one exception is `notesAfterRestart`, which must inherit phase 1's data. Roles: `probeRole=role-volunteer` (default) and `probeRole=role-hub-admin`.

**Runs.** Fourteen batches: eleven while the probe was being built, one counterfactual (below), and two final runs of record with the committed probe: volunteer (10 flows) and hub admin (7 flows). Every non-counterfactual result below reproduced in both the development batches and the runs of record.

**Counterfactual (disclosed).** To see past the two blockers that hide everything behind them, one batch used **local-only patches that were reverted immediately and never committed**:

- `PINUnlockScreen.kt:238` `maxLength = 6 → 8`, in a separately-copied APK;
- the `callId || conversationId` refine removed from `createNoteBodySchema`, for the server of that batch.

Results from that batch are labelled *counterfactual* and are never counted as the app's behaviour.

```sh
adb shell pm clear org.llamenos.hotline.debug
adb shell am instrument -w -e cucumberUseAndroidJUnitRunner true \
  -e class org.llamenos.hotline.discovery.M1CapabilityProbe#<method> \
  -e testHubUrl http://10.0.2.2:<port> -e testSecret test-reset-secret [-e probeRole role-hub-admin] \
  org.llamenos.hotline/org.llamenos.hotline.CucumberHiltRunner
```

CI does not run the probe. `CucumberAndroidJUnitRunner` runs JUnit classes only when `cucumberUseAndroidJUnitRunner=true` is passed. Stage 0 below turns it into a ratcheting gate.

## Phase 1 — evidence

States: **WORKS** / **BROKEN** (present, fails; failure given) / **ABSENT** (never built) / **UNKNOWN** (could not determine; reason given).

### 1. Auth

| Flow | State | Evidence | Issue |
|---|---|---|---|
| Create local identity + set PIN | **WORKS** | Fresh install → hub URL → Create identity → 8-digit PIN ×2 → dashboard, in every run. | — |
| Enrol the device with the server | **ABSENT** | No invite entry or redemption; `invites/redeem` has no Android caller. The first `GET /api/auth/me` is **401** (logged as `signature_verification_failed`; the pubkey is simply unknown). The only route to a registered identity is a dev backdoor. | #1345 (#766, #1047) |
| PIN lock | **BROKEN** | Dashboard Lock and Settings → Lock both return to the dashboard: `PIN pad shown=false; keys unlocked=false dashboard shown=true`. After "locking", Notes shows "No notes" rather than a lock screen. | #1339 |
| PIN unlock | **BROKEN** | After activity recreation or cold start the unlock pad appears, and the correct PIN fails: `correct 8-digit PIN: unlocked=false`, `6-digit prefix: unlocked=false`. The set pad has `maxLength = 8`, the unlock pad 6. *Counterfactual* with the pad at 8: `unlocked=true`, and a wrong PIN shows "Incorrect PIN". | #1338 |
| Logout | **WORKS** (locally) | Settings → Logout → confirm → login screen (`create-identity`). The app sent no server request (no `/api/auth/me/logout`). Whether the encrypted keys leave the disk was not checked (the desktop half is #1305). | — |

### 2. Notes

| Flow | State | Evidence | Issue |
|---|---|---|---|
| Create from the Notes tab | **BROKEN** | `POST /api/hubs/<hub>/notes` **400** `callId or conversationId is required`. The editor stays open and prints the raw 400 body, which **echoes the ciphertext and envelopes onto the screen**. | #1341 |
| Create during a call (active-call "quick note") | **BROKEN** | `onQuickNote = onNavigateToNotes`: it switches to the Notes list, and no editor opens with the `callId`. | #1341 |
| Create from Call History | **BROKEN** | "Add note" sits behind Call History, which fails for every role (next rows). | #1343, #1342 |
| Server accepts, app confirms (*counterfactual*) | **BROKEN** | Refine removed: `POST … 201`, and the app cannot decode the `{note:…}` reply (`Fields [authorPubkey, createdAt, encryptedContent, id, updatedAt] are required … at path: $`). The editor reports failure for a saved note. | #1341 |
| Read back own note (*counterfactual*) | **BROKEN** | The stored note has `author_pubkey` = the device **signing** key (`64dcdd17…`, from the DB). `NotesViewModel.decryptNote` compares it to the **encryption** key and silently drops the note. After restart: `GET …/notes 200`, the list shows "No notes", and no error appears. | #1024 |
| Admin can read a volunteer's note | **UNKNOWN** | Both notes whose bodies were observed carried `adminEnvelopes: []`: the hub admin's rejected POST (on screen) and the volunteer's counterfactual row (in the DB). So neither note is readable by any admin. This environment sets no `ADMIN_DECRYPTION_PUBKEY`, and it was not established whether a production-configured server changes that. | #1035, #1023 |
| Read back after app restart | **BROKEN** | The PIN cannot unlock (#1338), so the flow stops there. With the pad fixed, it hits the own-note defect above. | #1338, #1024 |

### 3. Shifts

| Flow | State | Evidence | Issue |
|---|---|---|---|
| View schedule (volunteer) | **BROKEN** | `GET …/shifts` **403** `required: shifts:read`. The Forbidden JSON, including `debug` role counts, is shown to the user. | #1342 |
| Clock in / out (volunteer) | **BROKEN** | `POST …/shifts/clock-in` **403** (`shifts:set-availability` is not in the Volunteer role). | #1342 |
| View schedule, clock in, clock out (hub admin) | **WORKS** | Seeded shift listed; clock-in 200 → Clock Out shown; clock-out 200 → Clock In shown. `M1CapabilityProbe#shifts` **passes**. | — |

The Android shift UI is sound. The gap is the permission contract, and it affects every client.

### 4. Calls

| Flow | State | Evidence | Issue |
|---|---|---|---|
| Receive a live ring | **BROKEN** | Ring simulated into the active hub: the dashboard never reacts, and `connection-status` stays "Reconnecting…". The app dials `ws://…/relay`, which the server answers with **404**. The server's socket is `/ws` (101). | #1016 |
| Answer in the app | **ABSENT** | No answer control appears while ringing. Answering happens on the volunteer's phone through the provider, and in-app SIP never registers. | #1188, #955 |
| See an answered call | **WORKS** only if it already exists at dashboard load | A call answered (via telephony) *before* the dashboard loaded hub data shows `active-call-card`. The same call answered *after* load never shows. | #1016 |
| Hang up | **WORKS** | `POST …/calls/<id>/hangup` **200** and the card clears (volunteer and hub admin). | — |
| See it in history | **BROKEN** | Volunteer: `GET …/calls/history` **403** (`calls:read-history`). Hub admin: 200, then `Field 'id' is required … SharedCall … $.calls[0]`. | #1342, #1343 (#1129) |

### 5. Hubs

| Flow | State | Evidence | Issue |
|---|---|---|---|
| List hubs | **WORKS** | Two member hubs listed (`hub-row` ×2), volunteer and hub admin. | — |
| Switch active hub | **WORKS** | Tap → `activeHubId` = tapped hub, `hub-active-indicator` shown. The choice persists across a process restart. | — |
| App chooses a hub after login | **BROKEN** | `activeHubId the app chose by itself: null` in every run. `HubRepository.loadInitialHub` has no caller. | #1340 |
| Events from a non-active hub | **UNKNOWN** | The relay delivers nothing from *any* hub (control ring into the active hub: `reacted=false`), so the axiom cannot be tested. By code, `fetchServerEventKey` loads only the active hub's key, and every `GET /hubs/<id>/key` was **404**. Both would need checking once #1016 lands. | #1016, #1042, #731 |

### 6. Conversations

| Flow | State | Evidence | Issue |
|---|---|---|---|
| List | **BROKEN** | The app requests unscoped `GET /api/conversations` (never `/hubs/<id>/…`). Volunteer: `Field 'contactHash' is required … $.conversations[0]`. Hub admin: an empty list, although an SMS was just delivered to the active hub. | #1344 |
| Open / read / send | **UNKNOWN** | Not reached: the list never shows a card. Inbound server-sealed text is independently undecryptable (#1020). | #1344, #1020 |

### Not exercised (say so, don't guess)

These were not exercised:

- biometric unlock;
- PIN lockout and wipe escalation;
- auto-lock timing;
- push/UnifiedPush ringing (#955);
- hub creation from Android;
- every admin-only surface (invites #1047, shift admin #1131/#1149, bans, audit);
- device linking (#1300 hides it for the pilot).

## Harness findings (they explain why none of this was visible)

1. **`ScenarioHooks.setActiveHubForScenario` writes `ActiveHubState` through Hilt before every scenario.** That masks #1340 in every scenario that has ever run.
2. **`ScenarioHooks.clearIdentityState` wipes keys after every scenario**, so no scenario ever reaches the PIN-unlock branch of `BaseSteps.navigateToMainScreen`. #1338 has been live since 2026-05-03.
3. **`SimulationClient.addHubMember` defaults to `roleIds = ["role-admin"]`, which does not exist** (the role is `role-hub-admin`). A user added that way gets `GET /api/hubs` **403** and cannot select any hub. Observed on the first admin batch of this survey.
4. **The suite never runs as a registered volunteer.** `I am logged in as an admin` promotes the identity to super-admin (`test-promote-admin`). `I am logged in as a volunteer` registers nothing at all (`NavigationSteps.kt`), so its scenarios run unregistered. The Volunteer-role 403s (#1342) are invisible either way.
5. **The server logs an unknown pubkey as `signature_verification_failed`** (`middleware/auth.ts:60` labels every null auth result that way). That sends debugging towards crypto when the cause is registration.
6. **Error text is the raw response body.** Forbidden JSON with `debug` role counts, and a 400 body echoing note ciphertext, are rendered on screen. That is a leak and a UX defect, and it is how this survey read the errors without a debugger.

## Phase 2 — the route to real Android M1 coverage

Each stage is independently landable, ordered by dependency, and tagged by kind of work:

- **(a)** fix the app (or server);
- **(b)** write missing step definitions;
- **(c)** make existing steps capable of failing;
- **(d)** build a feature that does not exist.

Sizes: **S** ≤ 1 day, **M** 2–4 days, **L** ≥ 1 week.

**The rule that prevents the 304 swallowing `catch` blocks from recurring:** a flow gets Cucumber coverage only after its probe method passes against a live server. Tests are never written ahead of the app work for flows that are BROKEN or ABSENT today. Only four flows could have a passing strict test today: logout, hub list/switch, admin shifts, and hang-up of a pre-loaded call.

### Stage 0 — make the probe a ratcheting gate · (c) · M
- Run `M1CapabilityProbe` in the Android E2E job, one method per process, against the job's backend.
- The job asserts a **required list** of methods and adds a method in the same PR that makes it pass. There is no exemption list; a method not yet on the list is simply not yet claimed. Initial list: `logout`, plus `shifts` with `probeRole=role-hub-admin`.
- Fix `SimulationClient.addHubMember`'s default role (`role-hub-admin`).
- No app work. It lands first so every later stage has a gate that can fail.

### Stage 1 — auth foundation · (a) + (d)
| Item | Kind | Size | Unblocks |
|---|---|---|---|
| #1338 PIN pad length | (a) | S | every flow across a restart; `#auth`, `#notesAfterRestart` |
| #1339 Lock leaves the UI unlocked | (a) | S | `#auth` |
| #1340 choose an active hub after login; re-fetch `/auth/me` after registration | (a) | S–M | every hub-scoped flow without the manual workaround. Delete the `ScenarioHooks` hub write in the same PR. |
| #1345 enrolment by invite (Android redemption + onboarding, #766) | (d) | L | a real volunteer. Needs invites to exist: desktop admins can create them today, and Android admin invites are #1047. |

The first three are app bugs with no test prerequisites. **No auth Cucumber step can pass before they land.** Enrolment is a feature build. Until it lands, every test (probe included) enrols through a backdoor, and the plan says so.

### Stage 2 — realtime · (a) · L
- **#1016**: the relay client must speak the server's `/ws` protocol. Without it there is no live ring, answer, message or multi-hub signal on Android.
- **#1042** (hub keys never generated) and **#731** (one global event key) decide whether events can be attributed to a non-active hub. Verify the multi-hub axiom once all three land: a ring in a non-active member hub must reach the app without switching hubs.
- **Exit:** `#calls` reports `liveRing=true liveAnswer=true`, and `#hubs` passes both rings.

### Stage 3 — notes · (a) + decision
- **#1341**: decide whether standalone notes exist. Then quick-note opens the editor with the active `callId`, and the client decodes the `{note}` reply. Size M; the decision gates it.
- **#1024**: own-note detection by signing key. (a), S.
- **#1035 / #1023**: admin envelopes. Server + client, M. **#1022** (envelope encoding interop) belongs to the same PR series if cross-client reading is in M1 scope.
- **Exit:** `#notesDuringCall` passes; after Stage 1, `#notesAfterRestart` passes.

### Stage 4 — shifts for volunteers · (a) server + decision · S
- **#1342**: the Volunteer role's permission contract (clock in/out, schedule, own call history). The Android UI already passes as hub admin.
- #1142 (clock-in doesn't affect routing) is server-side and M1, but it doesn't gate the Android test.
- **Exit:** `#shifts` passes with `probeRole=role-volunteer`.

### Stage 5 — calls · (a) · S–M after Stage 2
- **#1343**: history decodes. Fix it in the schema/server (the #1129 family), not with a client shim.
- **Decide whether in-app answer is M1** (#1188/#955, (d), L). If answering on the volunteer's own phone is the pilot path, the M1 Android requirement is: see the ring, see the answered call, hang up, find it in history. The plan assumes that reading.
- **Exit:** `#calls` passes.

### Stage 6 — conversations · (a) · M
- **#1344**: hub scoping for all conversation calls, and decoding the list. Then **#1020** (server-sealed message decryption), before a thread can be read.
- **Exit:** `#conversations` passes. Open, read and send are UNKNOWN today and get measured then.

### Stage 7 — Cucumber coverage, per area, after its stage · (b) + delete
For each area whose probe method passes:
1. Add its shared `core/`/`shifts/`/… features to the Android asset copy (#765), scoped to that area only.
2. Write **new, strict** step definitions for the scenarios that bind.
3. **Delete** the old, unbound step definitions for that area in the same PR.

Size: M per area, six areas. Scenarios for areas whose stage has not landed stay out of the asset copy. Undefined steps are the correct state for a feature the app does not have.

## Are the 828 unbound step definitions worth keeping?

**No. Delete them area by area, in the PR that lands each area's strict replacement. Do not repair them.**

- **They assert substitutes, by design, not by accident.** Sampled from the dead set:
  - `the save button should be visible` → `assertAnyTagDisplayed("note-save-button", "note-text-input", "notes-list", "dashboard-title")`;
  - `the text {string} should be displayed` → `try { assertIsDisplayed } catch (_: Throwable) {}`;
  - `custom fields are configured for notes` → an empty body.

  Per file: `NoteSteps` 19 defs / 6 swallowing `catch`, `ShiftSteps` 30 / 14, `PinSteps` 29 / 9, `ConversationSteps` 49 / 15. The "assertions" that remain mostly accept the dashboard as proof of the subject.
- **Repairing them means rewriting them.** Making a step capable of failing requires deciding what state it must observe. That is the same work as writing it fresh, but done against a body that encodes the wrong answer.
- **They were written against flows that never worked.** Notes cannot be saved, the PIN pad cannot unlock, and conversations cannot list. No step in those areas has ever run a green path it could be checked against.
- **Deleting per area, not wholesale, keeps what is worth keeping.** The Gherkin in `packages/test-specs` is shared with desktop, iOS and backend, and stays. The Kotlin step phrases are a useful inventory while an area's strict steps are written, so each area's dead file goes in the same PR as its replacement. That keeps the deletion reviewable and leaves nothing half-migrated.

The 25 vacuous *live* definitions from #1323 are a different case: they bind today's 46 scenarios. Fix them in place ((c)) in Stage 0's PR series, where the probe provides the ground truth for what each should observe.
