package org.llamenos.hotline.api

import android.util.Log
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import org.llamenos.protocol.MyStatusResponse
import java.io.IOException
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Clock-in / clock-out against one hub's active-shift roster.
 *
 * The backend keys clock state by (pubkey, hubId) and reads the hub from the
 * `/api/hubs/{hubId}/shifts/...` path. Every call here names its hub explicitly and
 * never goes through [ApiService.hp]: `hp()` falls back to the unscoped path when no
 * hub is active, and on the unscoped path the backend resolves the hub to `""` —
 * recording a clock-in that no hub's roster can see.
 *
 * Clocked-in state is held per hub, so switching the active hub (browsing context)
 * never loses or alters this device's shift state in any other member hub.
 *
 * The server is the source of truth for a clock-in (#1142): one whose heartbeat has stopped is
 * stale there — not rung, not shown as clocked in — and a heartbeat does not revive it. So this
 * state is a cache of what the server last said, corrected by [syncFromServer] and by a refused
 * [heartbeat], never an independent claim.
 */
@Singleton
class ShiftClockRepository @Inject constructor(
    private val apiService: ApiService,
) {
    private val _clockedIn = MutableStateFlow<Map<String, String>>(emptyMap())

    /** hubId → ISO-8601 instant this device clocked in to that hub. */
    val clockedIn: StateFlow<Map<String, String>> = _clockedIn.asStateFlow()

    /** Clock in to [hubId]. Clocking in again is idempotent server-side and keeps the original start. */
    suspend fun clockIn(hubId: String) {
        apiService.requestNoContent("POST", "/api/hubs/$hubId/shifts/clock-in")
        _clockedIn.update { if (hubId in it) it else it + (hubId to Instant.now().toString()) }
    }

    /**
     * Clock out of [hubId]. The backend answers 404 when it holds no active shift for
     * this user in the hub — the requested end state already holds, so that is success.
     */
    suspend fun clockOut(hubId: String) {
        try {
            apiService.requestNoContent("POST", "/api/hubs/$hubId/shifts/clock-out")
        } catch (e: ApiException) {
            if (e.code != 404) throw e
        }
        _clockedIn.update { it - hubId }
    }

    /**
     * Tell [hubId] this clock-in is still being held (`POST /api/hubs/{hubId}/shifts/heartbeat`).
     *
     * A 404 means the server holds no live clock-in there — never made, cleared elsewhere, or
     * already stale, and a stale one is not revived — and a 403 means the right to clock in was
     * withdrawn. Both are final for this clock-in: the hub drops out of [clockedIn] (so it is not
     * beaten again until the volunteer clocks in afresh) and the outcome is [HeartbeatOutcome.LOST].
     * Anything else (offline, a 5xx that survived the retries) says nothing about the clock-in, so
     * the state is left alone and the next tick tries again.
     */
    suspend fun heartbeat(hubId: String): HeartbeatOutcome {
        val observed = _clockedIn.value[hubId]
        try {
            apiService.requestNoContent("POST", "/api/hubs/$hubId/shifts/heartbeat")
        } catch (e: ApiException) {
            if (e.code == 404 || e.code == 403) {
                reconcile(hubId, observed, serverClockedInAt = null)
                return HeartbeatOutcome.LOST
            }
            Log.w(TAG, "heartbeat to hub $hubId failed: ${e.message}")
            return HeartbeatOutcome.UNREACHABLE
        } catch (e: IOException) {
            Log.w(TAG, "heartbeat to hub $hubId failed: ${e.message}")
            return HeartbeatOutcome.UNREACHABLE
        }
        return HeartbeatOutcome.ALIVE
    }

    /**
     * Replace this device's belief about [memberHubIds] with what the server says
     * (`GET /api/hubs/{hubId}/shifts/my-status`, `clockedIn`), so an app relaunched mid-shift
     * learns the clock-in it must keep alive, and a clock-in that went stale while the app was
     * away stops reading as clocked in.
     *
     * A hub that cannot be reached keeps whatever this device believed; a hub that says 403/404
     * (no longer a member) loses it. Hubs outside [memberHubIds] are dropped. A clock-in or
     * clock-out made while a read was in flight wins over the older answer.
     */
    suspend fun syncFromServer(memberHubIds: Collection<String>) {
        coroutineScope {
            memberHubIds.map { hubId -> async { syncHub(hubId) } }.awaitAll()
        }
        _clockedIn.update { current -> current.filterKeys { it in memberHubIds } }
    }

    private suspend fun syncHub(hubId: String) {
        val observed = _clockedIn.value[hubId]
        val status = try {
            apiService.request<MyStatusResponse>("GET", "/api/hubs/$hubId/shifts/my-status")
        } catch (e: ApiException) {
            if (e.code == 404 || e.code == 403) reconcile(hubId, observed, serverClockedInAt = null)
            else Log.w(TAG, "shift status of hub $hubId unavailable: ${e.message}")
            return
        } catch (e: IOException) {
            Log.w(TAG, "shift status of hub $hubId unavailable: ${e.message}")
            return
        }
        val clockedInAt = if (status.clockedIn) status.clockedInAt ?: observed ?: Instant.now().toString() else null
        reconcile(hubId, observed, clockedInAt)
    }

    /**
     * Apply a server answer for [hubId] only if this device's belief is still [observed], the
     * value it held when the request went out — a clock-in or clock-out that landed meanwhile is
     * newer than the answer and must not be undone by it.
     */
    private fun reconcile(hubId: String, observed: String?, serverClockedInAt: String?) {
        _clockedIn.update { current ->
            when {
                current[hubId] != observed -> current
                serverClockedInAt == null -> current - hubId
                else -> current + (hubId to serverClockedInAt)
            }
        }
    }

    /** What a hub said to a [heartbeat]. */
    enum class HeartbeatOutcome {
        /** The server holds a live clock-in and refreshed it. */
        ALIVE,

        /** The server holds no live clock-in (404) or forbids one (403); local state was cleared. */
        LOST,

        /** No usable answer (offline, 5xx). The clock-in's state is unknown, not lost. */
        UNREACHABLE,
    }

    private companion object {
        const val TAG = "ShiftClockRepository"
    }
}
