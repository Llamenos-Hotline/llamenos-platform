package org.llamenos.hotline.telephony

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.llamenos.hotline.api.ApiException
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.di.ApplicationScope
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Keeps this device's SIP registrations in step with the volunteer's shift.
 *
 * Clocking in registers every member hub (`GET /api/hubs`) — never only the active one — so a
 * call from any hub the volunteer belongs to can ring this device. Clocking out of the last hub
 * the volunteer is clocked in to unregisters.
 *
 * Must be called from the main thread: it drives [LinphoneService], whose liblinphone core
 * iterates there.
 */
@Singleton
class SipRegistrar @Inject constructor(
    private val apiService: ApiService,
    private val linphoneService: LinphoneService,
    @ApplicationScope private val scope: CoroutineScope,
) {

    /** Pending re-fetch of the SIP token before its TURN credentials expire. */
    private var credentialRefresh: Job? = null

    sealed interface Result {
        /** Every hub in [hubIds] is bound to a SIP registration. */
        data class Registered(val hubIds: Set<String>) : Result

        /**
         * In-app calling does not apply: the volunteer's call preference is phone-only, or the
         * server has no SIP-capable provider. Calls reach this volunteer by phone, if at all.
         */
        data class NotAvailable(val reason: String) : Result

        /** Registration was needed and could not be set up; this device will not ring. */
        data class Failed(val cause: Exception) : Result
    }

    /** Register a SIP account for every hub the user is a member of. */
    suspend fun registerMemberHubs(): Result {
        return try {
            val params = try {
                apiService.getSipConnectionParams()
            } catch (e: ApiException) {
                if (e.code == 400 || e.code == 404) {
                    linphoneService.unregisterAll()
                    return Result.NotAvailable(e.message)
                }
                throw e
            }
            val hubIds = apiService.getHubs().hubs.map { it.id }.toSet()
            hubIds.forEach { hubId -> linphoneService.registerHubAccount(hubId, params.sip) }
            linphoneService.retainHubAccounts(hubIds)
            scheduleCredentialRefresh(params.sip)
            Result.Registered(hubIds)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.e(TAG, "SIP registration failed", e)
            Result.Failed(e)
        }
    }

    /** Unregister every SIP account. */
    fun unregisterAll() {
        credentialRefresh?.cancel()
        credentialRefresh = null
        linphoneService.unregisterAll()
    }

    /**
     * Re-fetch the SIP token before the issued TURN credentials expire.
     *
     * They are time-limited by design (CoTURN's long-term-credential scheme — a seized
     * credential dies at its expiry), and the registration itself outlives them: a volunteer
     * clocked in for a whole shift would otherwise reach the point where the relay candidate can
     * no longer be allocated, and a symmetric-NAT volunteer silently stops being reachable in
     * the app. Re-fetching renews the TURN credential, the SIP secret and the trust anchor
     * together, and re-provisions the PBX endpoint idempotently.
     *
     * Runs on the main thread because it drives [LinphoneService]; [ApiService] moves its own
     * network work off it.
     */
    private fun scheduleCredentialRefresh(sip: SipAccountParams) {
        val expiresAt = sip.turnCredentialExpiresAt ?: run {
            credentialRefresh?.cancel()
            credentialRefresh = null
            return
        }
        val remainingMs = expiresAt * 1000 - System.currentTimeMillis()
        // Renew with a margin, and never spin: a credential already at or past its expiry gets
        // one attempt after the floor rather than an immediate retry loop.
        scheduleRefreshIn((remainingMs * 4 / 5).coerceAtLeast(MIN_REFRESH_DELAY_MS))
    }

    /**
     * Arm the single renewal job, replacing any pending one.
     *
     * A FAILED renewal re-arms on a shorter delay rather than giving up: raised in review, and
     * it matters because the thing that expires is the relay credential a symmetric-NAT
     * volunteer depends on. One transient network error mid-shift would otherwise mean no more
     * attempts until the next clock-in, with the volunteer still showing as registered.
     */
    private fun scheduleRefreshIn(delayMs: Long) {
        credentialRefresh?.cancel()
        credentialRefresh = scope.launch(Dispatchers.Main) {
            delay(delayMs)
            // Forget this job before re-registering: registerMemberHubs schedules the NEXT
            // refresh, and cancelling the job it is itself running inside would abort the
            // re-registration halfway.
            credentialRefresh = null
            if (linphoneService.registeredHubIds().isEmpty()) return@launch
            when (val result = registerMemberHubs()) {
                // registerMemberHubs re-armed the timer from the new credential's own expiry.
                is Result.Registered -> Log.i(TAG, "SIP credentials renewed before TURN expiry")
                // The server says in-app calling does not apply any more; nothing to renew.
                is Result.NotAvailable -> Log.i(TAG, "SIP credentials not renewed: ${result.reason}")
                is Result.Failed -> {
                    Log.w(TAG, "SIP credential renewal failed — retrying", result.cause)
                    scheduleRefreshIn(RENEWAL_RETRY_DELAY_MS)
                }
            }
        }
    }

    /**
     * Reconcile registrations with this device's clock state after a clock-out. Clock state is
     * per hub ([org.llamenos.hotline.api.ShiftClockRepository]): while the volunteer is still
     * clocked in to any member hub the registrations stay up — clocking out of one hub must not
     * silence calls from the others — and they are dropped once no hub has them clocked in.
     */
    suspend fun syncWithShift(clockedInAnywhere: Boolean): Result? = when {
        clockedInAnywhere && linphoneService.registeredHubIds().isEmpty() -> registerMemberHubs()
        !clockedInAnywhere -> {
            unregisterAll()
            null
        }
        else -> null
    }

    internal companion object {
        const val TAG = "SipRegistrar"

        /** Floor on the renewal delay, so an already-expired credential cannot spin. */
        const val MIN_REFRESH_DELAY_MS = 60_000L

        /**
         * Delay before retrying a renewal that failed. Long enough not to hammer a server that
         * is down, short enough to recover well inside a TURN credential's hour.
         */
        const val RENEWAL_RETRY_DELAY_MS = 120_000L
    }
}
