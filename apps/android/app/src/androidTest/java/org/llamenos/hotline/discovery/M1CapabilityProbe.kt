package org.llamenos.hotline.discovery

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
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dagger.hilt.android.EntryPointAccessors
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.llamenos.hotline.LlamenosApp
import org.llamenos.hotline.MainActivity
import org.llamenos.hotline.di.ActiveHubEntryPoint
import org.llamenos.hotline.di.CryptoEntryPoint
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * M1 capability probe — discovery instrument, not a regression suite.
 *
 * Drives the real app UI against a live backend to establish, per M1 flow,
 * whether it WORKS / is BROKEN / is ABSENT. Every step either succeeds or fails
 * the test with the exact state it saw; nothing is caught and nothing is skipped.
 * The only backdoors used are the ones the app has no UI for (device enrolment,
 * shift seeding, telephony and messaging simulation) — each is marked `BACKDOOR`.
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

    /** Hub role the probe user is enrolled with (`-e probeRole role-admin` to separate permission gaps from app gaps). */
    private val role: String = args.getString("probeRole", "role-volunteer")

    /** Survives `am instrument` process boundaries (the restart phase skips `pm clear`). */
    private val stateFile = File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "m1-probe-state")

    @After
    fun tearDown() {
        scenario?.close()
    }

    // ─── Flows ──────────────────────────────────────────────────────────────

    /** Enrol a device, PIN-lock, reject a wrong PIN, unlock with the right one. */
    @Test
    fun auth() {
        val pubkey = createIdentityViaUi()
        probe("auth", "local identity created, signing pubkey ${pubkey.take(12)}…")
        probe("auth", "activeHubId after first dashboard: ${activeHubId()}")

        val hub = createHub("probe-auth")
        enrol(pubkey, hub, role)
        pullToRefreshDashboard()
        Thread.sleep(3_000)
        probe("auth", "after enrolment + dashboard refresh: activeHubId=${activeHubId()} connection=${textOf("connection-status")}")

        // PIN lock from the dashboard top bar; Settings → Lock as the second entry point.
        Thread.sleep(2_000)
        compose.waitForIdle()
        compose.onNodeWithTag("lock-button").performClick()
        val lockedFromDashboard = pollFor(10_000) { has("pin-pad") }
        probe("auth", "dashboard lock-button → PIN pad shown=$lockedFromDashboard; keys unlocked=${crypto().isUnlocked} dashboard shown=${has("dashboard-title")}")
        if (!lockedFromDashboard) {
            tapTab("nav-settings")
            scrollClick("auth", "settings-lock-button")
            val lockedFromSettings = pollFor(10_000) { has("pin-pad") }
            probe("auth", "Settings → Lock → PIN pad shown=$lockedFromSettings; keys unlocked=${crypto().isUnlocked} tags=${visibleTags().take(8)}")
            // What a locked-but-still-displayed app does on its next request:
            tapTab("nav-notes")
            Thread.sleep(3_000)
            probe("auth", "after lock, Notes tab: tags=${visibleTags()} texts=${screenTexts().take(12)}")
            // Reach the PIN screen the way a user does after the app is recreated.
            scenario?.close()
            launch()
            waitForTag("auth", "pin-pad", 20_000)
            probe("auth", "activity recreated → PIN unlock screen")
        }

        enterPin("87654321")
        Thread.sleep(1_500)
        check(!has("dashboard-title")) { fail("auth", "WRONG PIN reached the dashboard") }
        probe("auth", "wrong 8-digit PIN rejected; texts=${screenTexts()}")

        // The PIN that was set (8 digits) — the one the user actually has.
        enterPin(PIN)
        val unlocked = pollFor(15_000) { has("dashboard-title") }
        probe("auth", "correct 8-digit PIN: unlocked=$unlocked texts=${screenTexts()}")
        if (!unlocked) {
            // The unlock pad submits at 6 digits; try the 6-digit prefix too, to show neither works.
            enterPin(PIN.take(6))
            val unlocked6 = pollFor(10_000) { has("dashboard-title") }
            probe("auth", "6-digit prefix of the PIN: unlocked=$unlocked6 texts=${screenTexts()}")
        }
        probe("auth", "RESULT lockButtonLocks=$lockedFromDashboard correctPinUnlocks=$unlocked")
        check(unlocked) { fail("auth", "the PIN set at enrolment cannot unlock the app") }
        check(lockedFromDashboard) { fail("auth", "the lock button dropped the keys but left the dashboard on screen") }
    }

    /** Log out from Settings: must land back on the login screen. */
    @Test
    fun logout() {
        val pubkey = createIdentityViaUi()
        val hub = createHub("probe-logout")
        enrol(pubkey, hub, role)
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
        val pubkey = createIdentityViaUi()
        val hub = createHub("probe-notes")
        enrol(pubkey, hub, role)
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
        probe("notes", "RESULT saved note visible in list and on reload: $marker")
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
        val pubkey = createIdentityViaUi()
        val hub = createHub("probe-quicknote")
        enrol(pubkey, hub, role)
        backdoor("quicknote", "test-create-shift", """{"pubkey":"$pubkey","hubId":"$hub"}""")
        val ring = backdoor("quicknote", "test-simulate/incoming-call", """{"callerNumber":"+15555550140","hubId":"$hub"}""")
        val callId = json.parseToJsonElement(ring).jsonObject["callId"]!!.jsonPrimitive.content
        backdoor("quicknote", "test-simulate/answer-call", """{"callId":"$callId","pubkey":"$pubkey"}""")
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
    }

    /**
     * A note attached to a call — the only kind the server accepts (callId or conversationId
     * is required). The call is completed through the telephony simulator, then the note is
     * written from Call History, the one screen that offers "add note" for a past call.
     */
    @Test
    fun notesFromCall() {
        val pubkey = createIdentityViaUi()
        val hub = createHub("probe-callnote")
        enrol(pubkey, hub, role)
        backdoor("callnote", "test-create-shift", """{"pubkey":"$pubkey","hubId":"$hub"}""")
        ensureActiveHub("callnote", hub)
        val ring = backdoor("callnote", "test-simulate/incoming-call", """{"callerNumber":"+15555550130","hubId":"$hub"}""")
        val callId = json.parseToJsonElement(ring).jsonObject["callId"]!!.jsonPrimitive.content
        backdoor("callnote", "test-simulate/answer-call", """{"callId":"$callId","pubkey":"$pubkey"}""")
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
        probe("callnote", "RESULT note attached to a call saved and read back")
    }

    /** View the schedule, clock in, clock out. */
    @Test
    fun shifts() {
        val pubkey = createIdentityViaUi()
        val hub = createHub("probe-shifts")
        enrol(pubkey, hub, role)
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
        waitForTag("shifts", "clock-in-button", 10_000)
        compose.onNodeWithTag("clock-in-button").performClick()
        waitForTag("shifts", "clock-out-button", 15_000)
        probe("shifts", "clock in → clock-out button shown")
        compose.onNodeWithTag("clock-out-button").performClick()
        waitForTag("shifts", "clock-in-button", 15_000)
        probe("shifts", "clock out → clock-in button shown")
        check(shiftCards.isNotEmpty()) { fail("shifts", "seeded shift is not in the schedule") }
        probe("shifts", "RESULT schedule, clock in and clock out all work")
    }

    /**
     * Calls, in two halves so a dead realtime channel cannot hide a display bug:
     *  1. an answered call that already exists when the dashboard loads its hub data —
     *     can the app show it and hang it up at all?
     *  2. a live ring after the dashboard is up — does the app learn about it?
     * Then Call History. There is no in-app answer control to test (answering happens on
     * the volunteer's phone via the telephony provider), so the probe records its absence.
     */
    @Test
    fun calls() {
        val pubkey = createIdentityViaUi()
        val hub = createHub("probe-calls")
        enrol(pubkey, hub, role)
        backdoor("calls", "test-create-shift", """{"pubkey":"$pubkey","hubId":"$hub"}""")

        // 1. Pre-existing answered call
        val ring1 = backdoor("calls", "test-simulate/incoming-call", """{"callerNumber":"+15555550123","hubId":"$hub"}""")
        val call1 = json.parseToJsonElement(ring1).jsonObject["callId"]!!.jsonPrimitive.content
        backdoor("calls", "test-simulate/answer-call", """{"callId":"$call1","pubkey":"$pubkey"}""")
        ensureActiveHub("calls", hub)
        val cardOnLoad = pollFor(15_000) { has("active-call-card") }
        probe("calls", "answered call present at dashboard load: active-call-card=$cardOnLoad count=${textOf("active-call-count")} tags=${visibleTags()}")
        if (cardOnLoad) {
            compose.onNodeWithTag("hangup-button").performScrollTo().performClick()
            val gone = pollFor(15_000) { !has("active-call-card") }
            probe("calls", "hangup tapped: card gone=$gone")
        }

        // 2. Live ring into the active hub
        val ring2 = backdoor("calls", "test-simulate/incoming-call", """{"callerNumber":"+15555550124","hubId":"$hub"}""")
        val call2 = json.parseToJsonElement(ring2).jsonObject["callId"]!!.jsonPrimitive.content
        val sawRing = pollFor(15_000) { textOf("active-call-count")?.trim()?.let { it != "0" } == true }
        probe("calls", "live ring: dashboard reacted=$sawRing count=${textOf("active-call-count")} connection=${textOf("connection-status")} answer-control=${visibleTags().filter { "answer" in it }}")
        backdoor("calls", "test-simulate/answer-call", """{"callId":"$call2","pubkey":"$pubkey"}""")
        val sawLive = pollFor(15_000) { has("active-call-card") }
        probe("calls", "live answer: active-call-card=$sawLive")
        backdoor("calls", "test-simulate/end-call", """{"callId":"$call2"}""")

        scrollClick("calls", "view-call-history")
        waitForAnyTag("calls", 15_000, "call-history-list", "call-history-title")
        val inHistory = pollFor(15_000) { has("call-record-$call1") || has("call-record-$call2") }
        probe("calls", "history shows the calls=$inHistory texts=${screenTexts().filter { "error" in it.lowercase() || "required" in it }}")
        probe("calls", "RESULT preloaded=$cardOnLoad liveRing=$sawRing liveAnswer=$sawLive history=$inHistory")
        check(cardOnLoad && sawRing && sawLive && inHistory) { fail("calls", "call lifecycle incomplete (see RESULT)") }
    }

    /** List hubs, switch the active hub, and receive a call ring from the non-active hub. */
    @Test
    fun hubs() {
        val pubkey = createIdentityViaUi()
        val hubA = createHub("probe-hub-a")
        val hubB = createHub("probe-hub-b")
        enrol(pubkey, hubA, role)
        enrol(pubkey, hubB, role)
        probe("hubs", "activeHubId the app chose: ${activeHubId()} (A=$hubA B=$hubB)")

        tapTab("nav-dashboard")
        scrollClick("hubs", "hubs-card")
        waitForAnyTag("hubs", 15_000, "hubs-list", "hub-row")
        Thread.sleep(2_000)
        val rows = compose.onAllNodesWithTag("hub-row", useUnmergedTree = true).fetchSemanticsNodes().size
        probe("hubs", "hub list rows=$rows tags=${visibleTags()}")
        check(rows >= 2) { fail("hubs", "expected both member hubs in the list, saw $rows") }

        compose.onNode(hasTestTag("hub-row") and hasAnyDescendantText("probe-hub-a"), useUnmergedTree = true)
            .performClick()
        val switched = pollFor(10_000) { activeHubId() == hubA }
        probe("hubs", "tapped hub A: activeHubId=${activeHubId()} switched=$switched indicator=${has("hub-active-indicator")}")
        check(switched) { fail("hubs", "tapping hub A did not switch the active hub") }

        compose.onNodeWithTag("hubs-back").performClick()
        tapTab("nav-dashboard")
        waitForTag("hubs", "dashboard-title", 10_000)
        probe("hubs", "dashboard (active=A) before ring: count=${textOf("active-call-count")} connection=${textOf("connection-status")}")
        backdoor("hubs", "test-simulate/incoming-call", """{"callerNumber":"+15555550124","hubId":"$hubB"}""")
        val sawB = pollFor(15_000) { textOf("active-call-count")?.trim()?.let { it != "0" } == true }
        probe("hubs", "call rang in NON-active hub B: dashboard reacted=$sawB count=${textOf("active-call-count")} tags=${visibleTags()}")
        backdoor("hubs", "test-simulate/incoming-call", """{"callerNumber":"+15555550125","hubId":"$hubA"}""")
        val sawA = pollFor(15_000) { textOf("active-call-count")?.trim()?.let { it != "0" } == true }
        probe("hubs", "control — call rang in ACTIVE hub A: dashboard reacted=$sawA count=${textOf("active-call-count")}")
        probe("hubs", "RESULT list=$rows switch=$switched nonActiveRing=$sawB activeRing=$sawA")
        check(sawA) { fail("hubs", "a call ringing in the active hub never reached the app") }
        check(sawB) { fail("hubs", "a call ringing in a non-active member hub never reached the app") }
    }

    /** An inbound SMS creates a conversation; open it, read it, reply. */
    @Test
    fun conversations() {
        val pubkey = createIdentityViaUi()
        val hub = createHub("probe-conv")
        enrol(pubkey, hub, role)
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

        compose.onNodeWithTag(tagsWithPrefix("conversation-card-").first(), useUnmergedTree = true).performClick()
        waitForAnyTag("conversations", 15_000, "messages-list", "messages-empty", "messages-error")
        Thread.sleep(2_000)
        val readable = hasText(body)
        probe("conversations", "detail: inbound text readable=$readable tags=${visibleTags()}")

        waitForTag("conversations", "reply-text-input", 10_000)
        val reply = "probe-reply-${System.currentTimeMillis()}"
        compose.onNodeWithTag("reply-text-input").performTextReplacement(reply)
        compose.onNodeWithTag("send-button").performClick()
        val sent = pollFor(15_000) { hasText(reply) }
        probe("conversations", "reply shown in thread=$sent tags=${visibleTags()}")
        check(readable) { fail("conversations", "inbound message text not readable in the thread") }
        check(sent) { fail("conversations", "sent reply never appeared in the thread") }
        probe("conversations", "RESULT inbound readable, reply sent")
    }

    // ─── UI helpers ─────────────────────────────────────────────────────────

    private fun launch() {
        scenario = ActivityScenario.launch(MainActivity::class.java)
    }

    /**
     * A user who belongs to a hub must end up browsing it. If the app has not chosen
     * one by itself, pick it the only way a user can: Settings → Hubs → tap the hub.
     */
    private fun ensureActiveHub(flow: String, hubId: String) {
        pullToRefreshDashboard()
        Thread.sleep(2_000)
        val chosen = activeHubId()
        probe(flow, "activeHubId the app chose by itself: $chosen (member of $hubId)")
        if (chosen == hubId) return
        tapTab("nav-dashboard")
        scrollClick(flow, "hubs-card")
        waitForAnyTag(flow, 15_000, "hub-row", "hubs-error", "hubs-empty")
        compose.onAllNodesWithTag("hub-row", useUnmergedTree = true).onFirst().performClick()
        val switched = pollFor(10_000) { activeHubId() == hubId }
        probe(flow, "selected hub via Settings → Hubs: activeHubId=${activeHubId()} switched=$switched")
        check(switched) { fail(flow, "could not select the member hub through the UI") }
        if (has("hubs-back")) compose.onNodeWithTag("hubs-back").performClick()
        tapTab("nav-dashboard")
    }

    /** Pull-to-refresh only fires with the list at its top, so scroll the first card into view first. */
    private fun pullToRefreshDashboard() {
        waitForTag("nav", "dashboard-pull-refresh", 10_000)
        compose.onNodeWithTag("connection-card").performScrollTo()
        compose.onNodeWithTag("dashboard-pull-refresh").performTouchInput {
            swipeDown(startY = top + 20f, endY = bottom, durationMillis = 800)
        }
        compose.waitForIdle()
        Thread.sleep(1_500)
    }

    /** Fresh install → hub URL → create identity → PIN twice → dashboard. Returns the signing pubkey. */
    private fun createIdentityViaUi(): String {
        launch()
        waitForTag("enrol", "create-identity", 20_000)
        compose.onNodeWithTag("hub-url-input").performTextReplacement(hubUrl)
        compose.onNodeWithTag("create-identity").performClick()
        waitForTag("enrol", "pin-pad", 10_000)
        enterPin(PIN)
        enterPin(PIN)
        waitForTag("enrol", "dashboard-title", 20_000)
        return checkNotNull(crypto().signingPubkeyHex) { fail("enrol", "no signing pubkey after identity creation") }
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

    private fun createHub(name: String): String {
        val body = backdoor("setup", "test-create-hub", """{"name":"$name-${System.currentTimeMillis()}"}""")
        return json.parseToJsonElement(body).jsonObject["id"]!!.jsonPrimitive.content
    }

    /** Android has no invite-redemption UI, so enrolment goes through the dev backdoor. */
    private fun enrol(pubkey: String, hubId: String, role: String) {
        backdoor("enrol", "test-add-hub-member", """{"pubkey":"$pubkey","hubId":"$hubId","roleIds":["$role"]}""")
    }

    private fun backdoor(flow: String, path: String, body: String): String {
        val conn = URL("$hubUrl/api/$path").openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("X-Test-Secret", testSecret)
            conn.doOutput = true
            conn.outputStream.use { it.write(body.toByteArray()) }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            probe(flow, "BACKDOOR POST /api/$path → $code ${text.take(160)}")
            check(code in 200..299) { fail(flow, "backdoor /api/$path failed: $code $text") }
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
    }
}
