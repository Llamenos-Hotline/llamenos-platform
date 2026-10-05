package org.llamenos.hotline.telephony

import android.util.Log
import kotlinx.coroutines.CancellationException
import org.llamenos.hotline.api.ApiException
import org.llamenos.hotline.api.ApiService
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
) {

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
        linphoneService.unregisterAll()
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

    private companion object {
        const val TAG = "SipRegistrar"
    }
}
