package org.llamenos.hotline.api

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
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
}
