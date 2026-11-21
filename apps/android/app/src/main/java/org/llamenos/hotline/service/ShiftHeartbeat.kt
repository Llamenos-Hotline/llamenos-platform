package org.llamenos.hotline.service

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.api.ShiftClockRepository
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.di.ApplicationScope
import org.llamenos.hotline.telephony.SipRegistrar
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Keeps every clock-in this volunteer holds alive (#1142, #2886).
 *
 * A clock-in is the volunteer's consent to be rung, and it only stays a true statement while
 * something is holding the app: the server treats a clock-in whose heartbeat stopped as stale
 * (not rung, not shown as clocked in) and a heartbeat does not revive it. So while this device is
 * unlocked it sends `POST /api/hubs/{hubId}/shifts/heartbeat` to **every** hub it is clocked into
 * — not just the active one (multi-hub axiom; nothing here reads the active hub) — every
 * [HEARTBEAT_INTERVAL_MS].
 *
 * What is beaten is decided by the server, not guessed: on unlock and on every return to the
 * foreground the member hubs' shift status is read ([ShiftClockRepository.syncFromServer]) and
 * a beat follows at once, so an app relaunched mid-shift re-asserts its clock-in, and one whose
 * clock-in went stale meanwhile finds out and reads as clocked out. A 404/403 to a beat is final
 * for that clock-in and is not retried — the hub leaves [ShiftClockRepository.clockedIn] until the
 * volunteer clocks in again. When the last clock-in is lost the SIP registrations are dropped, so
 * the device is not left registered to ring for a shift that no longer exists.
 *
 * ## Backgrounded apps
 *
 * Beats are signed with the device key, which exists only while the app is unlocked. So the loop
 * runs exactly while [CryptoService.unlockedState] is true, on the application scope, foreground
 * or not: a backgrounded process keeps beating for as long as the OS keeps it alive and its
 * network reachable. The process is kept alive by the SIP core's `phoneCall` foreground service
 * for a volunteer registered for in-app calls; nothing here adds a foreground service or a
 * WorkManager job of its own. WorkManager cannot do the job (its minimum period is 15 minutes,
 * three times the server's default 5-minute window) and a new foreground service would ship a
 * permanent notification and a manifest permission for a request that is one small POST.
 *
 * When the OS does suspend the app for longer than the server's stale window, or the app locks,
 * the clock-in is **allowed to lapse**: that is the signal the server was built to act on (a phone
 * nobody is holding must not be rung, and must not keep the hub's fallback group from being
 * tried), and the next unlock or foreground tells the volunteer so through [syncFromServer]
 * rather than leaving the screen claiming a shift that is no longer live. A deployment whose
 * volunteers are mobile-only can widen the window (`ACTIVE_SHIFT_STALE_AFTER_MINUTES`).
 *
 * A heartbeat that cannot be delivered is never queued for replay ([OfflineQueue.isLivenessSignal]):
 * replayed late it would assert a moment that has passed.
 */
@Singleton
class ShiftHeartbeat @Inject constructor(
    private val shiftClockRepository: ShiftClockRepository,
    private val apiService: ApiService,
    private val cryptoService: CryptoService,
    private val sipRegistrar: SipRegistrar,
    @ApplicationScope private val scope: CoroutineScope,
) {

    /** Conflated: however many foregrounds arrive while a sync runs, one more sync follows. */
    private val resyncRequests = Channel<Unit>(Channel.CONFLATED)

    /** Begin watching the lock state. Called once, from [org.llamenos.hotline.LlamenosApp]. */
    fun start() {
        scope.launch {
            cryptoService.unlockedState.collectLatest { unlocked ->
                if (unlocked) holdClockInsWhileUnlocked()
            }
        }
    }

    /** The app came to the foreground: re-read the server's view of the clock-ins and beat now. */
    fun onForeground() {
        resyncRequests.trySend(Unit)
    }

    /** Runs until cancelled by the lock state flipping back to locked. */
    private suspend fun holdClockInsWhileUnlocked() {
        // A foreground from before this unlock is answered by the sync the unlock itself starts.
        resyncRequests.tryReceive()
        resyncAndBeat()
        while (true) {
            val resyncRequested = withTimeoutOrNull(HEARTBEAT_INTERVAL_MS) { resyncRequests.receive() } != null
            if (resyncRequested) resyncAndBeat() else beat()
        }
    }

    private suspend fun resyncAndBeat() {
        guarded("shift status sync") {
            val memberHubIds = apiService.getHubs().hubs.map { it.id }
            val before = shiftClockRepository.clockedIn.value
            shiftClockRepository.syncFromServer(memberHubIds)
            releaseSipIfLastClockInLost(before)
        }
        beat()
    }

    private suspend fun beat() {
        guarded("shift heartbeat") {
            val before = shiftClockRepository.clockedIn.value
            val hubIds = before.keys.toList()
            if (hubIds.isEmpty()) return@guarded
            coroutineScope {
                hubIds.map { hubId -> async { shiftClockRepository.heartbeat(hubId) } }.awaitAll()
            }
            releaseSipIfLastClockInLost(before)
        }
    }

    private suspend fun releaseSipIfLastClockInLost(before: Map<String, String>) {
        if (before.isNotEmpty() && shiftClockRepository.clockedIn.value.isEmpty()) {
            // SipRegistrar drives liblinphone, whose core iterates on the main thread.
            withContext(Dispatchers.Main) { sipRegistrar.syncWithShift(clockedInAnywhere = false) }
        }
    }

    /**
     * One failed step must not end the loop — and on the application scope an uncaught exception
     * ends the process. Network and HTTP failures are already absorbed by the repository; this
     * is the net for what nobody expected (a lock racing an in-flight signed request, an
     * unreadable response).
     */
    private suspend fun guarded(what: String, block: suspend () -> Unit) {
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "$what failed", e)
        }
    }

    companion object {
        private const val TAG = "ShiftHeartbeat"

        /**
         * How often a clocked-in client tells the server it is still there. Mirrors
         * `ACTIVE_SHIFT_HEARTBEAT_INTERVAL_MS` in `packages/shared/active-shift-liveness.ts`, the
         * one number the server's stale window is validated against; a test holds the two equal.
         */
        const val HEARTBEAT_INTERVAL_MS = 30_000L
    }
}
