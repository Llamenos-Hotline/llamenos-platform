package org.llamenos.hotline.discovery

import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dagger.hilt.android.EntryPointAccessors
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.llamenos.hotline.LlamenosApp
import org.llamenos.hotline.MainActivity
import org.llamenos.hotline.R
import org.llamenos.hotline.di.ActiveHubEntryPoint
import org.llamenos.hotline.di.CryptoEntryPoint
import org.llamenos.hotline.helpers.TestPermissions
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * M1 capability probe — discovery instrument, not a regression suite.
 *
 * Drives the real app UI against a live backend to establish, per M1 flow,
 * whether it WORKS / is BROKEN / is ABSENT. Every step either succeeds or fails
 * the test with the exact state it saw; nothing is caught and nothing is skipped.
 * Enrollment is the real path: an admin creates an invite and grants hub membership
 * through the admin API (as the desktop admin UI does), and the volunteer redeems the
 * invite in the Android UI. The only backdoors are for what no client can do here (hub
 * creation, the test admin's own registration, shift seeding, telephony and messaging
 * simulation) — each is marked `BACKDOOR`.
 *
 * Required flows are enforced by the `m1ProbeGate` Gradle task
 * (`src/androidTest/m1-probe-required.txt`).
 *
 * Deliberately NOT done: [org.llamenos.hotline.steps.ScenarioHooks]' write of the
 * active hub into ActiveHubState. A real user has no such hook, so the probe lets the
 * app choose its own hub and records what it chose.
 *
 * Run one method per process, after `pm clear org.llamenos.hotline.debug` (except the
 * restart phase, which must inherit phase 1's data):
 *
 *   adb shell am instrument -w -e cucumberUseAndroidJUnitRunner true \
 *     -e class org.llamenos.hotline.discovery.M1CapabilityProbe#auth \
 *     -e testHubUrl http://10.0.2.2:3171 -e testSecret test-reset-secret \
 *     org.llamenos.hotline/org.llamenos.hotline.CucumberHiltRunner
 *
 * Evidence: `adb logcat -s PROBE` plus the server's request log.
 */
@RunWith(AndroidJUnit4::class)
class M1CapabilityProbe {

    @get:Rule
    val compose = createEmptyComposeRule()

    private var scenario: ActivityScenario<MainActivity>? = null
    private val args = InstrumentationRegistry.getArguments()
    private val hubUrl: String = args.getString("testHubUrl", "http://10.0.2.2:3171")
    private val testSecret: String = args.getString("testSecret", "test-reset-secret")
    private val json = Json { ignoreUnknownKeys = true }

    /** Hub role the probe user is enrolled with (`-e probeRole role-hub-admin` to separate permission gaps from app gaps). */
    private val role: String = args.getString("probeRole", "role-volunteer")

    /** Survives `am instrument` process boundaries (the restart phase skips `pm clear`). */
    private val stateFile = File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "m1-probe-state")

    /**
     * The runtime permissions the app asks for mid-flow, granted before the app starts.
     *
     * Clocking in asks for `RECORD_AUDIO` ([org.llamenos.hotline.telephony.rememberMicrophoneRequest]),
     * and the system dialog is an overlay the Compose harness can neither see nor dismiss — the
     * clock-in callback would never fire and the shifts flow would stall. The gate runs
     * `pm clear` before every flow, so this grant has to happen in-process, here.
     */
    @Before
    fun grantPermissions() {
        TestPermissions.grant()
    }

    @After
    fun tearDown() {
        scenario?.close()
    }

    // ─── Flows ──────────────────────────────────────────────────────────────

    /**
     * Enroll by invite, get a hub without visiting Hub Management, then lock from both entry
     * points and after the activity is recreated: every lock shows the PIN pad, a wrong
     * PIN is rejected, and the PIN that was set unlocks.
     */
    @Test
    fun auth() {
        val (pubkey, hub) = enrollViaInvite("auth", "probe-auth")
        probe("auth", "enrolled by invite, signing pubkey ${pubkey.take(12)}…")
        ensureActiveHub("auth", hub)

        compose.onNodeWithTag("lock-button").performClick()
        val lockedFromDashboard = pollFor(10_000) { has("pin-pad") && !has("dashboard-title") }
        probe("auth", "dashboard lock-button → PIN pad shown=$lockedFromDashboard; keys unlocked=${crypto().isUnlocked}")
        check(lockedFromDashboard) { fail("auth", "the lock button left the dashboard on screen; tags=${visibleTags()}") }

        enterPin("87654321")
        val wrongRejected = pollFor(5_000) { has("pin-error") } && !has("dashboard-title")
        probe("auth", "wrong PIN rejected=$wrongRejected texts=${screenTexts()}")
        check(wrongRejected) { fail("auth", "a wrong PIN was not rejected with an error") }
        unlockWithPin("auth", "after dashboard lock")

        tapTab("nav-settings")
        scrollClick("auth", "settings-lock-button")
        val lockedFromSettings = pollFor(10_000) { has("pin-pad") && !has("dashboard-title") }
        probe("auth", "Settings → Lock → PIN pad shown=$lockedFromSettings; keys unlocked=${crypto().isUnlocked}")
        check(lockedFromSettings) { fail("auth", "Settings → Lock left the app unlocked on screen; tags=${visibleTags()}") }
        unlockWithPin("auth", "after Settings lock")

        scenario?.close()
        launch()
        waitForTag("auth", "pin-pad", 20_000)
        unlockWithPin("auth", "after the activity was recreated")
        probe("auth", "activeHubId after unlock: ${activeHubId()}")
        check(activeHubId() == hub) { fail("auth", "active hub lost across lock/unlock: ${activeHubId()} (expected $hub)") }
        probe("auth", "RESULT enrolled by invite, hub chosen by the app, both locks show the PIN pad, the PIN unlocks")
    }

    /** An invite code the server does not know is refused on the login screen. */
    @Test
    fun enrollmentRejectsUnknownInvite() {
        launch()
        waitForTag("invite", "create-identity", 20_000)
        compose.onNodeWithTag("hub-url-input").performTextReplacement(hubUrl)
        compose.onNodeWithTag("invite-code-input").performTextReplacement(java.util.UUID.randomUUID().toString())
        compose.onNodeWithTag("create-identity").performClick()
        waitForTag("invite", "invite-error", 15_000)
        val error = textOf("invite-error")
        probe("invite", "unknown invite: error=$error tags=${visibleTags()}")
        // Any error would do for "refused" — an unreachable hub shows one too. Only the server's
        // verdict on the code (not a transport failure or a rate limit) is a refusal.
        val invalidCode = InstrumentationRegistry.getInstrumentation().targetContext.getString(R.string.onboarding_invalid_code)
        check(error == invalidCode) { fail("invite", "the error was '$error', not the invalid-code verdict '$invalidCode'") }
        check(!has("pin-pad")) { fail("invite", "an unknown invite continued to PIN set") }
        check(crypto().signingPubkeyHex == null) { fail("invite", "a device key was created for an unknown invite") }
        probe("invite", "RESULT unknown invite refused before any key was created")
    }

    /**
     * Enroll by pasting the whole invite link (which also names the hub), then log out from
     * Settings: must land back on the login screen.
     */
    @Test
    fun logout() {
        enrollViaInvite("logout", "probe-logout", asLink = true)
        tapTab("nav-settings")
        scrollClick("logout", "settings-logout-button")
        waitForTag("logout", "confirm-logout-button", 5_000)
        compose.onNodeWithTag("confirm-logout-button").performClick()
        waitForTag("logout", "create-identity", 15_000)
        probe("logout", "RESULT after logout the login screen is shown: tags=${visibleTags()}")
    }

    /** Phase 1: create and save a note. State is kept for [notesAfterRestart]. */
    @Test
    fun notesCreate() {
        val (pubkey, hub) = enrollViaInvite("notes", "probe-notes")
        ensureActiveHub("notes", hub)
        val marker = "probe-note-${System.currentTimeMillis()}"
        stateFile.parentFile?.mkdirs()
        stateFile.writeText("$hub\n$marker\n")

        createNote(marker)
        // Read back from the server within the session: leave, return, refresh.
        tapTab("nav-dashboard")
        tapTab("nav-notes")
        val reread = pollFor(20_000) { hasText(marker) }
        probe("notes", "re-read after leaving and returning to Notes: shown=$reread")
        check(reread) { fail("notes", "note not shown when the list is reloaded") }
        // What the list shows could be the screen's own state; the server must hold a note by this user.
        val onServer = serverNotes("notes", hub, pubkey)
        check(onServer.size == 1) { fail("notes", "the server holds ${onServer.size} notes by this user, expected 1") }
        probe("notes", "RESULT saved note visible in list and on reload, and held by the server: $marker")
    }

    /** Phase 2 — a new process, same app data: unlock with PIN and read the note back. */
    @Test
    fun notesAfterRestart() {
        val (hub, marker) = stateFile.readLines().let { it[0] to it[1] }
        launch()
        waitForAnyTag("notes-restart", 20_000, "pin-pad", "create-identity", "dashboard-title")
        probe("notes-restart", "cold start shows: ${visibleTags()}")
        check(has("pin-pad")) { fail("notes-restart", "cold start did not show PIN unlock") }
        enterPin(PIN)
        waitForTag("notes-restart", "dashboard-title", 20_000)
        probe("notes-restart", "activeHubId after restart: ${activeHubId()} (note hub=$hub)")
        tapTab("nav-notes")
        waitForText("notes-restart", marker, 20_000)
        probe("notes-restart", "RESULT note decrypted and shown after restart: $marker")
    }

    /**
     * The M1 note path: during an answered call, "quick note" from the active-call card
     * (carries the callId the server requires). Saves state for [notesAfterRestart].
     */
    @Test
    fun notesDuringCall() {
        val (pubkey, hub) = enrollViaInvite("quicknote", "probe-quicknote")
        backdoor("quicknote", "test-create-shift", """{"pubkey":"$pubkey","hubId":"$hub"}""")
        val callId = simulateAnsweredCall("quicknote", hub, pubkey, "+15555550140")
        ensureActiveHub("quicknote", hub)
        waitForTag("quicknote", "active-call-card", 15_000)
        scrollClick("quicknote", "quick-note-button")
        waitForTag("quicknote", "note-text-input", 10_000)
        val marker = "probe-quicknote-${System.currentTimeMillis()}"
        stateFile.parentFile?.mkdirs()
        stateFile.writeText("$hub\n$marker\n")
        compose.onNodeWithTag("note-text-input").performTextReplacement(marker)
        compose.onNodeWithTag("note-save-button").performClick()
        val saved = pollFor(20_000) { !has("note-text-input") }
        probe("quicknote", "after save: left editor=$saved tags=${visibleTags().take(12)} texts=${screenTexts().filter { "rror" in it || "equired" in it || "ail" in it }}")
        check(saved) { fail("quicknote", "note for the active call was not saved") }
        tapTab("nav-notes")
        val inList = pollFor(20_000) { hasText(marker) }
        probe("quicknote", "Notes tab shows the note (decrypted)=$inList tags=${visibleTags().take(12)}")
        check(inList) { fail("quicknote", "saved note not shown in Notes") }
        tapTab("nav-dashboard")
        tapTab("nav-notes")
        val reread = pollFor(20_000) { hasText(marker) }
        probe("quicknote", "RESULT note saved during a call, listed=$inList, re-listed after reload=$reread")
        check(reread) { fail("quicknote", "note missing when the Notes list reloads") }
        val forCall = serverNotes("quicknote", hub, pubkey, callId)
        check(forCall.size == 1) { fail("quicknote", "the server holds ${forCall.size} notes by this user for call $callId, expected 1") }
    }

    /**
     * A note attached to a call — the only kind the server accepts (callId or conversationId
     * is required). The call is completed through the telephony simulator, then the note is
     * written from Call History, the one screen that offers "add note" for a past call.
     */
    @Test
    fun notesFromCall() {
        val (pubkey, hub) = enrollViaInvite("callnote", "probe-callnote")
        backdoor("callnote", "test-create-shift", """{"pubkey":"$pubkey","hubId":"$hub"}""")
        ensureActiveHub("callnote", hub)
        val callId = simulateAnsweredCall("callnote", hub, pubkey, "+15555550130")
        backdoor("callnote", "test-simulate/end-call", """{"callId":"$callId"}""")

        scrollClick("callnote", "view-call-history")
        waitForAnyTag("callnote", 15_000, "call-history-list", "call-history-title")
        val listed = pollFor(15_000) { has("call-record-$callId") }
        probe("callnote", "history: call-record-$callId present=$listed tags=${visibleTags()} texts=${screenTexts().take(20)}")
        check(listed) { fail("callnote", "completed call not in history") }
        scrollClick("callnote", "call-add-note-$callId")
        waitForTag("callnote", "note-text-input", 10_000)
        val marker = "probe-callnote-${System.currentTimeMillis()}"
        compose.onNodeWithTag("note-text-input").performTextReplacement(marker)
        compose.onNodeWithTag("note-save-button").performClick()
        val saved = pollFor(20_000) { !has("note-text-input") }
        probe("callnote", "after save: left editor=$saved tags=${visibleTags()} texts=${screenTexts().take(20)}")
        check(saved) { fail("callnote", "note for a call was not saved") }
        if (has("call-history-back")) compose.onNodeWithTag("call-history-back").performClick()
        tapTab("nav-notes")
        val inList = pollFor(20_000) { hasText(marker) }
        probe("callnote", "Notes tab shows the call note (decrypted)=$inList tags=${visibleTags()}")
        check(inList) { fail("callnote", "saved call note not shown in Notes") }
        val forCall = serverNotes("callnote", hub, pubkey, callId)
        check(forCall.size == 1) { fail("callnote", "the server holds ${forCall.size} notes by this user for call $callId, expected 1") }
        probe("callnote", "RESULT note attached to a call saved, read back, and held by the server for the call")
    }

    /** View the schedule, clock in, clock out. */
    @Test
    fun shifts() {
        val (pubkey, hub) = enrollViaInvite("shifts", "probe-shifts")
        backdoor("shifts", "test-create-shift", """{"pubkey":"$pubkey","hubId":"$hub"}""")
        ensureActiveHub("shifts", hub)

        tapTab("nav-shifts")
        waitForAnyTag("shifts", 15_000, "shifts-list", "clock-card")
        compose.waitForIdle()
        Thread.sleep(2_000)
        val shiftCards = tagsWithPrefix("shift-card-")
        probe("shifts", "schedule: shift cards=${shiftCards.size} tags=${visibleTags()}")
        if (shiftCards.isEmpty()) probe("shifts", "schedule texts=${screenTexts()}")

        // Clock in/out is independent of seeing the schedule — probe it regardless.
        // The button flipping is the app's own state. What clocking in means is that the server
        // would ring this user — scheduled (seeded above) AND clocked in — so ask it.
        check(pubkey !in serverAvailable("shifts", hub)) { fail("shifts", "the server already rings this user before clock-in") }
        waitForTag("shifts", "clock-in-button", 10_000)
        compose.onNodeWithTag("clock-in-button").performClick()
        waitForTag("shifts", "clock-out-button", 15_000)
        val ringableAfterIn = pollFor(15_000) { pubkey in serverAvailable("shifts", hub) }
        probe("shifts", "clock in → clock-out button shown; server would ring this user=$ringableAfterIn")
        check(ringableAfterIn) { fail("shifts", "the app shows clocked in but the server would not ring this user") }
        compose.onNodeWithTag("clock-out-button").performClick()
        waitForTag("shifts", "clock-in-button", 15_000)
        val ringableAfterOut = pollFor(15_000) { pubkey !in serverAvailable("shifts", hub) }
        probe("shifts", "clock out → clock-in button shown; server stopped ringing this user=$ringableAfterOut")
        check(ringableAfterOut) { fail("shifts", "the app shows clocked out but the server would still ring this user") }
        check(shiftCards.isNotEmpty()) { fail("shifts", "seeded shift is not in the schedule") }
        probe("shifts", "RESULT schedule, clock in and clock out all work, and the server agrees")
    }

    /**
     * Calls, in two halves so a dead realtime channel cannot hide a display bug:
     *  1. an answered call that already exists when the dashboard loads its hub data —
     *     can the app show it and hang it up at all?
     *  2. a live ring and a live answer after the dashboard is up — does the app learn
     *     about each?
     * Then Call History. There is no in-app answer control to test (answering happens on
     * the volunteer's phone via the telephony provider), so the probe records its absence.
     *
     * Every claim is checked against the server, not against what the probe set up:
     *  - the answer is real when the server lists the call `in-progress`, answered by this
     *    user ([serverCall]);
     *  - half 2 starts from a dashboard with NO call card and no call on the server, so a
     *    card seen afterwards cannot be left over from half 1 (#2122);
     *  - a hang-up the server refused is told apart from a card that did not update.
     * The card carries neither a call id nor a status, so a card that is already up when the
     * answer is simulated cannot be attributed to the answer — that is reported as not
     * observed, never as seen.
     */
    @Test
    fun calls() {
        val (pubkey, hub) = enrollViaInvite("calls", "probe-calls")
        backdoor("calls", "test-create-shift", """{"pubkey":"$pubkey","hubId":"$hub"}""")
        // A hub with no telephony provider cannot disconnect a caller, so Hang Up is refused with a
        // 502 whatever the app does. Give the hub the mock provider, as an admin does from Settings,
        // so a refusal that remains is about the app or the server rather than a missing provider.
        adminApi("calls", "PUT", "/api/hubs/$hub/simulated-telephony/mock", """{"enabled":true}""")

        // 1. Pre-existing answered call
        val call1 = simulateAnsweredCall("calls", hub, pubkey, "+15555550123")
        // The dashboard is already up from enrollment, so it has not seen this call. Reopen the app
        // (a real cold start: PIN, then the dashboard loads its hub data) so the call genuinely
        // pre-exists the load rather than depending on a pull gesture registering.
        scenario?.close()
        launch()
        waitForTag("calls", "pin-pad", 20_000)
        unlockWithPin("calls", "reopened with the call already answered")
        ensureActiveHub("calls", hub)
        val cardOnLoad = pollFor(15_000) { has("active-call-card") }
        probe("calls", "answered call present at dashboard load: active-call-card=$cardOnLoad count=${textOf("active-call-count")} tags=${visibleTags()}")
        val hangup = if (cardOnLoad) {
            compose.onNodeWithTag("hangup-button").performScrollTo().performClick()
            val serverEnded = pollFor(15_000) { serverCall("calls", hub, call1) == null }
            when {
                !serverEnded -> "refused-by-server"
                pollFor(15_000) { !has("active-call-card") } -> "ok"
                else -> "card-stale-after-server-ended-call"
            }
        } else {
            "not-attempted"
        }
        probe("calls", "hangup tapped: $hangup (server still lists call 1: ${serverCall("calls", hub, call1) != null})")

        // Half 2 must start clean. A refused hang-up leaves call 1 live on the server, so end it
        // through the simulator, refresh as a user would, and require the card to be gone —
        // otherwise any card seen below could be call 1's.
        if (serverCall("calls", hub, call1) != null) {
            backdoor("calls", "test-simulate/end-call", """{"callId":"$call1"}""")
        }
        // An injected pull does not always register (see ensureActiveHub), so pull again as a user would.
        val cleanStart = serverCalls("calls", hub).isEmpty() &&
            (1..3).any { pullToRefreshDashboard(); pollFor(5_000) { !has("active-call-card") } }
        val countBefore = activeCallCount()
        probe("calls", "half 2 starts clean=$cleanStart count=$countBefore tags=${visibleTags()}")

        // 2. Live ring into the active hub
        val ring2 = backdoor("calls", "test-simulate/incoming-call", """{"callerNumber":"+15555550124","hubId":"$hub"}""")
        val call2 = json.parseToJsonElement(ring2).jsonObject["callId"]!!.jsonPrimitive.content
        // Either the counter moves or a card appears; from a clean start nothing else could do either.
        val sawRing = cleanStart && countBefore != null &&
            pollFor(15_000) { activeCallCount()?.let { it > countBefore } == true || has("active-call-card") }
        probe("calls", "live ring: dashboard reacted=$sawRing count=${activeCallCount()} (was $countBefore) card=${has("active-call-card")} connection=${textOf("connection-status")} answer-control=${visibleTags().filter { "answer" in it }}")
        // A ring may bring up a card by itself; only a card that was absent until the answer can
        // be credited to the answer.
        val cardBeforeAnswer = has("active-call-card")
        backdoor("calls", "test-simulate/answer-call", """{"callId":"$call2","pubkey":"$pubkey"}""")
        val answeredOnServer = serverCall("calls", hub, call2)?.let { it.status == "in-progress" && it.answeredBy == pubkey } == true
        val onlyCall2Live = serverCalls("calls", hub).map { it.id } == listOf(call2)
        val cardAfterAnswer = cleanStart && !cardBeforeAnswer && answeredOnServer && onlyCall2Live &&
            pollFor(15_000) { has("active-call-card") }
        probe(
            "calls",
            "live answer: server answered=$answeredOnServer only-call-2-live=$onlyCall2Live " +
                "card before answer=$cardBeforeAnswer after=$cardAfterAnswer",
        )
        backdoor("calls", "test-simulate/end-call", """{"callId":"$call2"}""")

        scrollClick("calls", "view-call-history")
        waitForAnyTag("calls", 15_000, "call-history-list", "call-history-title")
        val inHistory = pollFor(15_000) { has("call-record-$call1") && has("call-record-$call2") }
        probe("calls", "history shows both calls=$inHistory texts=${screenTexts().filter { "error" in it.lowercase() || "required" in it }}")
        probe(
            "calls",
            "RESULT preloaded=$cardOnLoad hangup=$hangup cleanStart=$cleanStart liveRing=$sawRing liveAnswer=$cardAfterAnswer history=$inHistory",
        )
        check(cardOnLoad) { fail("calls", "an answered call present at load was not shown") }
        check(hangup == "ok") { fail("calls", "hang-up: $hangup (refused-by-server is the server or its telephony, not the card)") }
        check(cleanStart) { fail("calls", "half 2 could not start from a clean dashboard, so a live answer cannot be told from a stale card") }
        check(sawRing) { fail("calls", "a live ring never reached the dashboard") }
        check(cardAfterAnswer) { fail("calls", "the answer update was not observed (card already up before the answer: $cardBeforeAnswer; server answered: $answeredOnServer)") }
        check(inHistory) { fail("calls", "ended calls not both in Call History") }
    }

    /** List hubs, switch the active hub, and receive a call ring from the non-active hub. */
    @Test
    fun hubs() {
        val (pubkey, hubA) = enrollViaInvite("hubs", "probe-hub-a")
        val hubB = createHub("probe-hub-b")
        addHubMember("hubs", pubkey, hubB)
        probe("hubs", "activeHubId the app chose: ${activeHubId()} (A=$hubA B=$hubB)")

        tapTab("nav-dashboard")
        scrollClick("hubs", "hubs-card")
        waitForAnyTag("hubs", 15_000, "hubs-list", "hub-row")
        Thread.sleep(2_000)
        val rows = compose.onAllNodesWithTag("hub-row", useUnmergedTree = true).fetchSemanticsNodes().size
        probe("hubs", "hub list rows=$rows tags=${visibleTags()}")
        check(rows >= 2) { fail("hubs", "expected both member hubs in the list, saw $rows") }

        // The app picked a hub by itself, so tapping that same hub would "switch" to where it
        // already is. Prove a switch by going to the hub that is NOT active, and then back.
        val before = activeHubId()
        check(before == hubA || before == hubB) { fail("hubs", "the app has no active hub among its two: $before") }
        val other = if (before == hubA) "probe-hub-b" to hubB else "probe-hub-a" to hubA
        compose.onNode(hasTestTag("hub-row") and hasAnyDescendantText(other.first), useUnmergedTree = true).performClick()
        val switchedAway = pollFor(10_000) { activeHubId() == other.second }
        probe("hubs", "tapped ${other.first}: activeHubId=${activeHubId()} (was $before) switched=$switchedAway indicator=${has("hub-active-indicator")}")
        check(switchedAway) { fail("hubs", "tapping the inactive hub ${other.first} did not switch the active hub (still ${activeHubId()})") }
        compose.onNode(hasTestTag("hub-row") and hasAnyDescendantText("probe-hub-a"), useUnmergedTree = true).performClick()
        val switched = pollFor(10_000) { activeHubId() == hubA }
        probe("hubs", "tapped hub A: activeHubId=${activeHubId()} switched back=$switched")
        check(switched) { fail("hubs", "tapping hub A did not switch the active hub back (still ${activeHubId()})") }

        compose.onNodeWithTag("hubs-back").performClick()
        tapTab("nav-dashboard")
        waitForTag("hubs", "dashboard-title", 10_000)
        probe("hubs", "dashboard (active=A) before ring: count=${textOf("active-call-count")} connection=${textOf("connection-status")}")
        // The counter only moves on a live ring, so each ring must move it past what it read just
        // before — a count of 1 left by the first ring would otherwise satisfy the second check.
        val countBeforeB = activeCallCount()
        backdoor("hubs", "test-simulate/incoming-call", """{"callerNumber":"+15555550124","hubId":"$hubB"}""")
        val sawB = countBeforeB != null && pollFor(15_000) { activeCallCount()?.let { it > countBeforeB } == true }
        probe("hubs", "call rang in NON-active hub B: dashboard reacted=$sawB count=${activeCallCount()} (was $countBeforeB) tags=${visibleTags()}")
        val countBeforeA = activeCallCount()
        backdoor("hubs", "test-simulate/incoming-call", """{"callerNumber":"+15555550125","hubId":"$hubA"}""")
        val sawA = countBeforeA != null && pollFor(15_000) { activeCallCount()?.let { it > countBeforeA } == true }
        probe("hubs", "control — call rang in ACTIVE hub A: dashboard reacted=$sawA count=${activeCallCount()} (was $countBeforeA)")
        probe("hubs", "RESULT list=$rows switch=${switchedAway && switched} nonActiveRing=$sawB activeRing=$sawA")
        check(sawA) { fail("hubs", "a call ringing in the active hub never reached the app") }
        check(sawB) { fail("hubs", "a call ringing in a non-active member hub never reached the app") }
    }

    /**
     * Enrolment registers the device keys with the server (#2119), push or no push: the
     * emulator has no UnifiedPush distributor, which is a phone's default state. The
     * server seals records to `devices.x25519_pubkey`, so a message that arrives
     * afterwards must carry a reader envelope for exactly the app's key.
     */
    @Test
    fun deviceRegistered() {
        val (pubkey, hub) = enrollViaInvite("deviceRegistered", "probe-device")
        val x25519 = checkNotNull(crypto().encryptionPubkeyHex) { fail("deviceRegistered", "no encryption pubkey") }

        val registered = pollFor(15_000) { userDeviceKeys(pubkey).any { it == x25519 } }
        probe("deviceRegistered", "server device x25519 keys=${userDeviceKeys(pubkey)} app=$x25519 registered=$registered")
        check(registered) { fail("deviceRegistered", "enrolment left the server with no device key for this app") }

        // The server seals an inbound message to the admin key and to the ASSIGNED user's
        // registered device keys, so assign the conversation first, then let a second message in.
        val sender = "+15555550188"
        fun inbound(text: String) = backdoor(
            "deviceRegistered", "test-simulate/incoming-message",
            """{"senderNumber":"$sender","body":"$text","channel":"sms","hubId":"$hub"}""",
        )
        val conversationId = json.parseToJsonElement(inbound("probe-device-first")).jsonObject["conversationId"]!!.jsonPrimitive.content
        adminApi("deviceRegistered", "PATCH", "/api/hubs/$hub/conversations/$conversationId", """{"assignedTo":"$pubkey"}""")
        inbound("probe-device-second")

        val messages = json.parseToJsonElement(
            adminApi("deviceRegistered", "GET", "/api/hubs/$hub/conversations/$conversationId/messages"),
        ).jsonObject["messages"]!!.jsonArray.map { it.jsonObject }
        val sealedToApp = messages.count { m ->
            m["readerEnvelopes"]!!.jsonArray.any { it.jsonObject["pubkey"]?.jsonPrimitive?.contentOrNull == x25519 }
        }
        probe("deviceRegistered", "RESULT registered=$registered messages=${messages.size} sealed to the app's key=$sealedToApp")
        check(sealedToApp >= 1) { fail("deviceRegistered", "no inbound message carries a reader envelope for the app's key") }
        stateFile.parentFile?.mkdirs()
        stateFile.writeText("$pubkey\n$hub\n$x25519\n$conversationId\n$sealedToApp\n")
    }

    /**
     * Phase 2 of [deviceRegistered] — a new process on the same app data (run without
     * `pm clear`): cold start, unlock with the PIN. The app must still hold the X25519 key
     * it registered, the server must still list that key for the user, and a message that
     * arrives after the relaunch must be sealed to it.
     */
    @Test
    fun deviceRegisteredAfterRestart() {
        val (pubkey, hub, x25519, conversationId, sealedBefore) = stateFile.readLines()
        launch()
        waitForAnyTag("deviceRelaunch", 20_000, "pin-pad", "create-identity", "dashboard-title")
        probe("deviceRelaunch", "cold start shows: ${visibleTags()}")
        check(has("pin-pad")) { fail("deviceRelaunch", "cold start did not show PIN unlock") }
        unlockWithPin("deviceRelaunch", "cold start")

        val appKey = crypto().encryptionPubkeyHex
        probe("deviceRelaunch", "app x25519 after relaunch=$appKey (registered before=$x25519)")
        check(appKey == x25519) { fail("deviceRelaunch", "the app's X25519 key changed across a relaunch") }
        val onServer = pollFor(15_000) { userDeviceKeys(pubkey).any { it == x25519 } }
        check(onServer) { fail("deviceRelaunch", "the server no longer holds the app's key after a relaunch") }

        backdoor(
            "deviceRelaunch", "test-simulate/incoming-message",
            """{"senderNumber":"+15555550188","body":"probe-device-after-relaunch","channel":"sms","hubId":"$hub"}""",
        )
        val sealedAfter = json.parseToJsonElement(
            adminApi("deviceRelaunch", "GET", "/api/hubs/$hub/conversations/$conversationId/messages"),
        ).jsonObject["messages"]!!.jsonArray.count { m ->
            m.jsonObject["readerEnvelopes"]!!.jsonArray.any { it.jsonObject["pubkey"]?.jsonPrimitive?.contentOrNull == x25519 }
        }
        probe("deviceRelaunch", "RESULT key kept=true server holds it=$onServer sealed to it before=$sealedBefore after=$sealedAfter")
        check(sealedAfter > sealedBefore.toInt()) { fail("deviceRelaunch", "a message after the relaunch carries no envelope for the app's key") }
    }

    /** An inbound SMS creates a conversation; open it, read it, reply. */
    @Test
    fun conversations() {
        val (pubkey, hub) = enrollViaInvite("conversations", "probe-conv")
        ensureActiveHub("conversations", hub)
        val body = "probe-sms-${System.currentTimeMillis()}"
        backdoor(
            "conversations", "test-simulate/incoming-message",
            """{"senderNumber":"+15555550199","body":"$body","channel":"sms","hubId":"$hub"}""",
        )

        tapTab("nav-conversations")
        val cardAppeared = pollFor(20_000) { tagsWithPrefix("conversation-card-").isNotEmpty() }
        probe("conversations", "list: cards=${tagsWithPrefix("conversation-card-")} tags=${visibleTags()}")
        if (!cardAppeared) probe("conversations", "list texts=${screenTexts()}")
        check(cardAppeared) { fail("conversations", "inbound conversation never listed") }

        val conversationId = tagsWithPrefix("conversation-card-").first().removePrefix("conversation-card-")
        compose.onNodeWithTag("conversation-card-$conversationId", useUnmergedTree = true).performClick()
        waitForAnyTag("conversations", 15_000, "messages-list", "messages-empty", "messages-error")
        Thread.sleep(2_000)
        val readable = hasText(body)
        probe("conversations", "detail: inbound text readable=$readable tags=${visibleTags()}")

        waitForTag("conversations", "reply-text-input", 10_000)
        val reply = "probe-reply-${System.currentTimeMillis()}"
        compose.onNodeWithTag("reply-text-input").performTextReplacement(reply)
        compose.onNodeWithTag("send-button").performClick()
        // `hasText(reply)` alone also matches the reply still sitting in the input box after a send
        // that failed: text the probe typed. Require it in the thread (not editable), the box
        // emptied, and the server to hold an outbound message from this user.
        val sent = pollFor(15_000) { hasReadOnlyText(reply) && !hasInputText(reply) }
        val outboundOnServer = pollFor(15_000) { serverOutboundMessages("conversations", hub, conversationId, pubkey) >= 1 }
        probe("conversations", "reply shown in thread=$sent, server holds an outbound message=$outboundOnServer tags=${visibleTags()}")
        check(readable) { fail("conversations", "inbound message text not readable in the thread") }
        check(sent) { fail("conversations", "sent reply never appeared in the thread") }
        check(outboundOnServer) { fail("conversations", "the server holds no outbound message from this user in the conversation") }
        probe("conversations", "RESULT inbound readable, reply sent")
    }

    // ─── UI helpers ─────────────────────────────────────────────────────────

    private fun launch() {
        scenario = ActivityScenario.launch(MainActivity::class.java)
    }

    /**
     * A user who belongs to a hub must end up browsing it without visiting Hub Management
     * (#1340). Membership is granted after the dashboard first loaded, so this refreshes
     * the dashboard the way a user would, then requires the app to have chosen the hub.
     */
    private fun ensureActiveHub(flow: String, hubId: String) {
        // An injected swipe can land before the dashboard settles and not register as a
        // pull (no request reaches the server), so pull again the way a user would.
        val chosen = (1..3).any { attempt ->
            pullToRefreshDashboard()
            pollFor(5_000) { activeHubId() == hubId }.also { probe(flow, "pull-to-refresh #$attempt: hub chosen=$it") }
        }
        probe(flow, "activeHubId the app chose by itself: ${activeHubId()} (member of $hubId)")
        check(chosen) { fail(flow, "the app did not select the user's hub by itself: ${activeHubId()} (expected $hubId)") }
    }

    /**
     * Pull-to-refresh only fires with the list at its top, so scroll the first card into
     * view first. The pull is a real touch (`input swipe`): a Compose-injected swipe never
     * triggered the dashboard's refresh, so no request reached the server.
     */
    private fun pullToRefreshDashboard() {
        waitForTag("nav", "dashboard-pull-refresh", 10_000)
        // The first card is the call card when a call is up; scrolling to the card below it
        // leaves the list off its top, and the pull then never fires.
        compose.onNodeWithTag(if (has("active-call-card")) "active-call-card" else "connection-card").performScrollTo()
        compose.waitForIdle()
        val node = compose.onNodeWithTag("dashboard-pull-refresh").fetchSemanticsNode()
        val x = (node.positionOnScreen.x + node.size.width / 2).toInt()
        val fromY = (node.positionOnScreen.y + node.size.height * 0.2f).toInt()
        val toY = (node.positionOnScreen.y + node.size.height * 0.8f).toInt()
        val swipe = InstrumentationRegistry.getInstrumentation().uiAutomation
            .executeShellCommand("input swipe $x $fromY $x $toY 600")
        // Reading to EOF waits for the gesture to finish.
        ParcelFileDescriptor.AutoCloseInputStream(swipe).use { it.readBytes() }
        compose.waitForIdle()
    }

    /**
     * Enrollment as a volunteer does it (#1345): an admin creates an invite for [role] into
     * a new hub, and the volunteer redeems it on a fresh install (hub URL + invite code →
     * PIN twice). Redemption is what grants the hub membership (#1474), so the invite
     * names the hub — this server has many, and an unnamed hub is refused as ambiguous.
     * The server must then list the user as a member with [role]; the probe grants nothing.
     * Returns the signing pubkey and the hub.
     *
     * [asLink]: paste the invite link instead, leaving the hub URL empty — the app must
     * take both the code and the hub from the link.
     */
    private fun enrollViaInvite(flow: String, hubName: String, asLink: Boolean = false): Pair<String, String> {
        val hub = createHub(hubName)
        val invite = adminApi(
            flow, "POST", "/api/invites",
            """{"name":"Probe $flow","phone":"+15555550100","roleIds":["$role"],"hubId":"$hub"}""",
        )
        val code = json.parseToJsonElement(invite).jsonObject["invite"]!!.jsonObject["code"]!!.jsonPrimitive.content
        launch()
        waitForTag(flow, "create-identity", 20_000)
        if (asLink) {
            compose.onNodeWithTag("invite-code-input").performTextReplacement("$hubUrl/onboarding?code=$code")
        } else {
            compose.onNodeWithTag("hub-url-input").performTextReplacement(hubUrl)
            compose.onNodeWithTag("invite-code-input").performTextReplacement(code)
        }
        compose.onNodeWithTag("create-identity").performClick()
        waitForAnyTag(flow, 15_000, "pin-pad", "invite-error")
        check(!has("invite-error")) { fail(flow, "a fresh invite was refused: ${textOf("invite-error")}") }
        enterPin(PIN)
        enterPin(PIN)
        waitForAnyTag(flow, 20_000, "dashboard-title", "invite-redeem-error")
        check(has("dashboard-title")) { fail(flow, "invite redemption failed: ${textOf("invite-redeem-error")}") }
        val pubkey = checkNotNull(crypto().signingPubkeyHex) { fail(flow, "no signing pubkey after enrollment") }
        probe(flow, "invite redeemed in the UI; the app is on the dashboard")
        // Redemption is what grants the hub membership (#1474). The probe used to add the member
        // itself straight afterwards, which made a redemption that granted nothing look fine.
        val roles = serverHubRoles(flow, pubkey, hub)
        probe(flow, "server hub roles after redemption: $roles")
        check(roles?.contains(role) == true) { fail(flow, "redeeming the invite did not make the user a $role member of the hub; server says $roles") }
        return pubkey to hub
    }

    /** Enter the PIN on the unlock screen and require the dashboard. */
    private fun unlockWithPin(flow: String, context: String) {
        waitForTag(flow, "pin-pad", 10_000)
        enterPin(PIN)
        val unlocked = pollFor(15_000) { has("dashboard-title") }
        probe(flow, "$context: the PIN unlocks=$unlocked keys unlocked=${crypto().isUnlocked}")
        check(unlocked) { fail(flow, "$context: the PIN set at enrollment did not unlock the app; texts=${screenTexts()}") }
    }

    private fun enterPin(pin: String) {
        for (d in pin) compose.onNodeWithTag("pin-$d").performClick()
        compose.waitForIdle()
    }

    private fun tapTab(tag: String) {
        waitForTag("nav", tag, 10_000)
        compose.onNodeWithTag(tag).performClick()
        compose.waitForIdle()
    }

    private fun scrollClick(flow: String, tag: String) {
        waitForTag(flow, tag, 10_000)
        compose.onNodeWithTag(tag).performScrollTo().performClick()
        compose.waitForIdle()
    }

    private fun createNote(text: String) {
        tapTab("nav-notes")
        waitForTag("notes", "create-note-fab", 10_000)
        compose.onNodeWithTag("create-note-fab").performClick()
        waitForTag("notes", "note-text-input", 10_000)
        compose.onNodeWithTag("note-text-input").performTextReplacement(text)
        compose.onNodeWithTag("note-save-button").performClick()
        val listed = pollFor(20_000) { hasText(text) && !has("note-text-input") }
        probe("notes", "after save: listed=$listed tags=${visibleTags()} texts=${screenTexts()}")
        check(listed) { fail("notes", "saved note never appeared in the notes list") }
    }

    private fun has(tag: String): Boolean =
        compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    /** All text currently on screen (for evidence when no error tag exists). */
    private fun screenTexts(): List<String> =
        compose.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.Text), useUnmergedTree = true)
            .fetchSemanticsNodes().flatMap { n -> n.config[SemanticsProperties.Text].map { it.text } }.distinct()

    private fun hasText(text: String): Boolean =
        compose.onAllNodes(hasText(text, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    /** [text] on screen in a node that is not an input box (the message thread, not the reply field). */
    private fun hasReadOnlyText(text: String): Boolean =
        compose.onAllNodes(
            hasText(text, substring = true) and !androidx.compose.ui.test.hasSetTextAction(),
            useUnmergedTree = true,
        ).fetchSemanticsNodes().isNotEmpty()

    /** [text] on screen in an input box. */
    private fun hasInputText(text: String): Boolean =
        compose.onAllNodes(
            hasText(text, substring = true) and androidx.compose.ui.test.hasSetTextAction(),
            useUnmergedTree = true,
        ).fetchSemanticsNodes().isNotEmpty()

    private fun hasAnyDescendantText(text: String): SemanticsMatcher =
        androidx.compose.ui.test.hasAnyDescendant(hasText(text, substring = true))

    private fun textOf(tag: String): String? = runCatching {
        compose.onAllNodesWithTag(tag, useUnmergedTree = true).onFirst().fetchSemanticsNode()
            .config.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { it.text }
    }.getOrNull()

    private fun visibleTags(): List<String> =
        compose.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.TestTag), useUnmergedTree = true)
            .fetchSemanticsNodes().mapNotNull { it.config.getOrNull(SemanticsProperties.TestTag) }.distinct()

    private fun tagsWithPrefix(prefix: String): List<String> = visibleTags().filter { it.startsWith(prefix) }

    /** Texts of any error-ish nodes currently shown, for evidence. */
    private fun visibleErrorTexts(): List<String> =
        visibleTags().filter { "error" in it || "not-found" in it }.mapNotNull { t -> textOf(t)?.let { "$t=$it" } }

    private fun waitForTag(flow: String, tag: String, timeoutMs: Long) = waitForAnyTag(flow, timeoutMs, tag)

    private fun waitForAnyTag(flow: String, timeoutMs: Long, vararg tags: String) {
        try {
            compose.waitUntil(timeoutMs) { tags.any { has(it) } }
        } catch (e: ComposeTimeoutException) {
            throw AssertionError(fail(flow, "none of ${tags.toList()} within ${timeoutMs}ms; visible=${visibleTags()} errors=${visibleErrorTexts()}"), e)
        }
    }

    private fun waitForText(flow: String, text: String, timeoutMs: Long) {
        if (!pollFor(timeoutMs) { hasText(text) }) {
            throw AssertionError(fail(flow, "text '$text' not shown within ${timeoutMs}ms; visible=${visibleTags()} errors=${visibleErrorTexts()}"))
        }
    }

    private fun pollFor(timeoutMs: Long, predicate: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            compose.waitForIdle()
            if (predicate()) return true
            Thread.sleep(250)
        }
        compose.waitForIdle()
        return predicate()
    }

    // ─── App state (read-only) ──────────────────────────────────────────────

    private fun crypto() =
        EntryPointAccessors.fromApplication(LlamenosApp.instance, CryptoEntryPoint::class.java).cryptoService()

    private fun activeHubId(): String? =
        EntryPointAccessors.fromApplication(LlamenosApp.instance, ActiveHubEntryPoint::class.java)
            .activeHubState().activeHubId.value

    // ─── Backend (BACKDOOR: things the app has no UI for) ───────────────────

    /** One call as the SERVER lists it — the evidence the probe trusts over anything on screen. */
    private data class ServerCall(val id: String, val status: String, val answeredBy: String?)

    /** Calls the server holds as live in [hub] (`GET /api/hubs/:id/calls/active`, as the admin). */
    private fun serverCalls(flow: String, hub: String): List<ServerCall> =
        json.parseToJsonElement(adminApi(flow, "GET", "/api/hubs/$hub/calls/active")).jsonObject["calls"]!!.jsonArray.map {
            val call = it.jsonObject
            ServerCall(
                call["id"]!!.jsonPrimitive.content,
                call["status"]!!.jsonPrimitive.content,
                call["answeredBy"]?.jsonPrimitive?.contentOrNull,
            )
        }

    private fun serverCall(flow: String, hub: String, callId: String): ServerCall? =
        serverCalls(flow, hub).firstOrNull { it.id == callId }

    /**
     * Ring and answer a call through the telephony simulator (BACKDOOR: the volunteer answers on
     * their phone, not in the app), then require the SERVER to list it `in-progress`, answered by
     * [pubkey] — a call that never reached that state would make every UI assertion below
     * vacuous. Returns the call id.
     */
    private fun simulateAnsweredCall(flow: String, hub: String, pubkey: String, callerNumber: String): String {
        val ring = backdoor(flow, "test-simulate/incoming-call", """{"callerNumber":"$callerNumber","hubId":"$hub"}""")
        val callId = json.parseToJsonElement(ring).jsonObject["callId"]!!.jsonPrimitive.content
        backdoor(flow, "test-simulate/answer-call", """{"callId":"$callId","pubkey":"$pubkey"}""")
        val call = serverCall(flow, hub, callId)
        check(call?.status == "in-progress" && call.answeredBy == pubkey) { fail(flow, "the server does not list $callId as answered by $pubkey: $call") }
        return callId
    }

    /** The dashboard's live call counter; it only moves on a live ring or end event, never on a refresh. */
    private fun activeCallCount(): Int? = textOf("active-call-count")?.trim()?.toIntOrNull()

    /** Hub roles the server holds for [pubkey] in [hub], or null if the server does not know them as a member. */
    private fun serverHubRoles(flow: String, pubkey: String, hub: String): List<String>? = runCatching {
        json.parseToJsonElement(adminApi(flow, "GET", "/api/hubs/$hub/users/$pubkey")).jsonObject["hubRoles"]!!.jsonArray
            .filter { it.jsonObject["hubId"]!!.jsonPrimitive.content == hub }
            .flatMap { it.jsonObject["roleIds"]!!.jsonArray.map { r -> r.jsonPrimitive.content } }
    }.onFailure { probe(flow, "hub membership lookup for $pubkey failed: ${it.message}") }.getOrNull()

    /** Pubkeys the server would ring in [hub] right now (`GET /api/hubs/:id/calls/presence`): scheduled AND clocked in. */
    private fun serverAvailable(flow: String, hub: String): List<String> =
        json.parseToJsonElement(adminApi(flow, "GET", "/api/hubs/$hub/calls/presence")).jsonObject["users"]!!.jsonArray
            .filter { it.jsonObject["status"]!!.jsonPrimitive.content == "available" }
            .map { it.jsonObject["pubkey"]!!.jsonPrimitive.content }

    /** Notes the server holds in [hub] written by [pubkey], optionally for one call. Content is ciphertext; only existence is checkable. */
    private fun serverNotes(flow: String, hub: String, pubkey: String, callId: String? = null): List<String> {
        val query = callId?.let { "?callId=$it" }.orEmpty()
        return json.parseToJsonElement(adminApi(flow, "GET", "/api/hubs/$hub/notes$query")).jsonObject["notes"]!!.jsonArray
            .filter { it.jsonObject["authorPubkey"]!!.jsonPrimitive.content == pubkey }
            .map { it.jsonObject["id"]!!.jsonPrimitive.content }
    }

    /** Outbound messages by [pubkey] the server holds in a conversation. Content is ciphertext; only existence is checkable. */
    private fun serverOutboundMessages(flow: String, hub: String, conversationId: String, pubkey: String): Int =
        json.parseToJsonElement(adminApi(flow, "GET", "/api/hubs/$hub/conversations/$conversationId/messages")).jsonObject["messages"]!!.jsonArray
            .count {
                it.jsonObject["direction"]?.jsonPrimitive?.contentOrNull == "outbound" &&
                    it.jsonObject["authorPubkey"]?.jsonPrimitive?.contentOrNull == pubkey
            }

    private fun createHub(name: String): String {
        val body = backdoor("setup", "test-create-hub", """{"name":"$name-${System.currentTimeMillis()}"}""")
        return json.parseToJsonElement(body).jsonObject["id"]!!.jsonPrimitive.content
    }

    /** A hub admin adds the user to a hub — `POST /api/hubs/:id/members`, as the desktop admin UI does. */
    private fun addHubMember(flow: String, pubkey: String, hubId: String) {
        adminApi(flow, "POST", "/api/hubs/$hubId/members", """{"pubkey":"$pubkey","roleIds":["$role"]}""")
    }

    /**
     * A request signed by the test admin (CI's fixed `ADMIN_SEED`, whose pubkey is the
     * server's `ADMIN_PUBKEY`). Makes sure the admin is registered first.
     */
    private fun adminApi(flow: String, method: String, path: String, body: String? = null): String {
        if (!adminReady) {
            val token = org.llamenos.core.mobileCreateAuthTokenFromSigningKey(ADMIN_SEED, 0u, "GET", "/")
            backdoor(flow, "test-promote-admin", """{"pubkey":"${token.pubkey}"}""")
            adminReady = true
        }
        val token = org.llamenos.core.mobileCreateAuthTokenFromSigningKey(
            ADMIN_SEED, System.currentTimeMillis().toULong(), method, path,
        )
        val auth = buildString {
            append("""{"pubkey":"${token.pubkey}","timestamp":${token.timestamp},"token":"${token.token}"""")
            token.nonce?.let { append(""","nonce":"$it"""") }
            append('}')
        }
        return http(flow, method, path, body, "ADMIN") {
            setRequestProperty("Authorization", "Bearer $auth")
            // The probe's seeding traffic is ordinary API traffic, and every flow seeds as the
            // SAME admin pubkey, so it all lands in one `write` bucket: 30 requests / 60s
            // (middleware/rate-limit.ts RATE_LIMIT_TIERS.write, keyed by pubkey). Without this
            // header the gate's own setup throttles itself once the ratchet grows past a
            // handful of flows, and the symptom is `POST /api/invites -> 429` in enrollment —
            // indistinguishable from an app regression, and "fixed" by deleting a flow.
            // `devSurfaceRequestAuthorized` (lib/dev-surfaces.ts) exempts a request presenting
            // the dev-surface secret for exactly this reason; `backdoor` already relies on it.
            setRequestProperty("X-Test-Secret", testSecret)
        }
    }

    /** The X25519 keys of the devices the server holds for [pubkey], read with a request the app itself signs. */
    private fun userDeviceKeys(pubkey: String): List<String> {
        val path = "/api/devices"
        val token = runBlocking { crypto().createAuthToken("GET", path) }
        val auth = buildString {
            append("""{"pubkey":"${token.pubkey}","timestamp":${token.timestamp},"token":"${token.token}"""")
            token.nonce?.let { append(""","nonce":"$it"""") }
            append('}')
        }
        val body = http("deviceRegistered", "GET", path, null, "USER") {
            setRequestProperty("Authorization", "Bearer $auth")
            setRequestProperty("X-Test-Secret", testSecret)
        }
        return json.parseToJsonElement(body).jsonObject["devices"]!!.jsonArray
            .mapNotNull { it.jsonObject["x25519Pubkey"]?.jsonPrimitive?.contentOrNull }
            .also { probe("deviceRegistered", "devices of ${pubkey.take(8)}: ${it.size}") }
    }

    private var adminReady = false

    private fun backdoor(flow: String, path: String, body: String): String =
        http(flow, "POST", "/api/$path", body, "BACKDOOR") { setRequestProperty("X-Test-Secret", testSecret) }

    private fun http(
        flow: String,
        method: String,
        path: String,
        body: String?,
        kind: String,
        headers: HttpURLConnection.() -> Unit,
    ): String {
        val conn = URL("$hubUrl$path").openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000
            conn.setRequestProperty("Content-Type", "application/json")
            conn.headers()
            // A GET must not carry a body: HttpURLConnection silently turns a GET with output into a POST.
            if (body != null) {
                conn.doOutput = true
                conn.outputStream.use { it.write(body.toByteArray()) }
            }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            // Reads are polled; only a failed one is worth a log line.
            if (method != "GET" || code !in 200..299) probe(flow, "$kind $method $path → $code ${text.take(160)}")
            check(code in 200..299) { fail(flow, "$kind $method $path failed: $code $text") }
            return text
        } finally {
            conn.disconnect()
        }
    }

    private fun probe(flow: String, msg: String) = Log.i(TAG, "[$flow/$role] $msg")

    private fun fail(flow: String, msg: String): String = "[$flow] FAIL $msg".also { Log.e(TAG, it) }

    private companion object {
        const val TAG = "PROBE"
        const val PIN = "12345678"

        /** CI's test admin (`tests/helpers.ts` ADMIN_SEED → `TEST_ADMIN_PUBKEY`). */
        const val ADMIN_SEED = "f54a5851e9372b87810a8e60cdd2e7cfd80b6e31c7af18188f7db106ceda8be7"
    }
}
