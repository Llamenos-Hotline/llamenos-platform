package org.llamenos.hotline.service

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.ResolvedDistributor
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Testable abstraction over the UnifiedPush connector's static API.
 *
 * The connector (`org.unifiedpush.android.connector.UnifiedPush`) is a Kotlin
 * object of `@JvmStatic` functions that need a [Context]; unit tests cannot
 * exercise it directly. All distributor interaction goes through this
 * interface so [PushRegistrationManager] is JVM-testable with a fake.
 */
interface UnifiedPushGateway {
    /** Package name of the acknowledged distributor, or null when none is registered. */
    fun getAckDistributor(): String?

    /** All installed distributor package names (empty when none is installed). */
    fun getDistributors(): List<String>

    /**
     * Select the current or default distributor without ever showing UI.
     *
     * Semantics match `UnifiedPush.tryUseCurrentOrDefaultDistributor`:
     * keep the acknowledged distributor if there is one, else fall back to
     * the OS default. Unlike the connector helper this never launches the
     * picker activity — it is called from background contexts (login,
     * unlock, `onUnregistered`) where `startActivity` would crash. When
     * several distributors are installed and the OS has no default, the pick
     * is deterministic: ntfy when present, otherwise the first installed.
     *
     * @return true when a distributor is selected and ready for [register].
     */
    fun selectCurrentOrDefaultDistributor(): Boolean

    /**
     * (Re-)register this app instance with the selected distributor.
     * Idempotent — the distributor answers with the current endpoint via
     * `MessagingReceiver.onNewEndpoint` (a fresh one on rotation).
     */
    fun register()

    /** Unregister this app instance from the distributor. */
    fun unregister()
}

@Singleton
class AndroidUnifiedPushGateway @Inject constructor(
    @ApplicationContext private val context: Context,
) : UnifiedPushGateway {

    override fun getAckDistributor(): String? = UnifiedPush.getAckDistributor(context)

    override fun getDistributors(): List<String> = UnifiedPush.getDistributors(context)

    override fun selectCurrentOrDefaultDistributor(): Boolean {
        if (UnifiedPush.getAckDistributor(context) != null) return true
        return when (val resolved = UnifiedPush.resolveDefaultDistributor(context)) {
            is ResolvedDistributor.Found -> {
                UnifiedPush.saveDistributor(context, resolved.packageName)
                true
            }

            ResolvedDistributor.ToSelect -> {
                // Multiple distributors, no OS default. The connector would
                // launch a picker activity here — impossible (and crashing)
                // from a background context, so pick deterministically.
                val distributors = UnifiedPush.getDistributors(context)
                val pick = distributors.firstOrNull { it == NTfy_PACKAGE }
                    ?: distributors.firstOrNull()
                if (pick != null) {
                    UnifiedPush.saveDistributor(context, pick)
                    true
                } else {
                    false
                }
            }

            ResolvedDistributor.NoneAvailable -> false
        }
    }

    override fun register() = UnifiedPush.register(context)

    override fun unregister() = UnifiedPush.unregister(context)

    companion object {
        /** ntfy — the documented self-hosted distributor (deploy/PUSH_NOTIFICATIONS.md). */
        private const val NTfy_PACKAGE = "io.heckel.ntfy"
    }
}
