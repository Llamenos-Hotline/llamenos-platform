package org.llamenos.hotline

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dagger.hilt.android.AndroidEntryPoint
import org.llamenos.hotline.api.NetworkMonitor
import org.llamenos.hotline.api.VersionChecker
import org.llamenos.hotline.api.WebSocketService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.service.OfflineQueue
import org.llamenos.hotline.telephony.LinphoneService
import org.llamenos.hotline.ui.DeepLinkDestination
import org.llamenos.hotline.ui.LlamenosNavigation
import org.llamenos.hotline.ui.theme.LlamenosTheme
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject
    lateinit var cryptoService: CryptoService

    @Inject
    lateinit var webSocketService: WebSocketService

    @Inject
    lateinit var keystoreService: KeystoreService

    @Inject
    lateinit var networkMonitor: NetworkMonitor

    @Inject
    lateinit var versionChecker: VersionChecker

    @Inject
    lateinit var offlineQueue: OfflineQueue

    @Inject
    lateinit var linphoneService: LinphoneService

    private var backgroundTimestamp: Long? = null

    /**
     * Pending deep link destination, consumed by LlamenosNavigation. Compose state, so a
     * link delivered to the running activity (`onNewIntent` — e.g. tapping the incident
     * push while the app is open) is navigated to, not only one that launched it.
     */
    internal var pendingDeepLink: DeepLinkDestination? by mutableStateOf(null)
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        // Parse deep link from the launching intent
        pendingDeepLink = intent?.data?.let { parseDeepLink(it) }

        setContent {
            LlamenosTheme {
                LlamenosNavigation(
                    cryptoService = cryptoService,
                    webSocketService = webSocketService,
                    keystoreService = keystoreService,
                    networkMonitor = networkMonitor,
                    offlineQueue = offlineQueue,
                    versionChecker = versionChecker,
                    linphoneService = linphoneService,
                    pendingDeepLink = pendingDeepLink,
                    onDeepLinkConsumed = { pendingDeepLink = null },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.data?.let { uri ->
            pendingDeepLink = parseDeepLink(uri)
        }
    }

    override fun onStop() {
        super.onStop()
        backgroundTimestamp = System.currentTimeMillis()
    }

    override fun onStart() {
        super.onStart()
        if (shouldAutoLock(backgroundTimestamp, System.currentTimeMillis())) {
            // Dropping the keys is only half the lock: SessionLockEffect (composed by
            // LlamenosNavigation) observes unlockedState, clears the authenticated
            // state and moves the UI to the PIN unlock screen (#1535).
            cryptoService.lock()
        }
        backgroundTimestamp = null
    }

    companion object {
        internal const val LOCK_TIMEOUT_MS = 5L * 60L * 1000L // 5 minutes

        /**
         * Whether returning to the foreground trips the auto-lock: the app was
         * backgrounded at [backgroundedAtMs] and has been away longer than
         * [LOCK_TIMEOUT_MS]. A null timestamp (never backgrounded, or already
         * consumed by an earlier onStart) never locks.
         */
        internal fun shouldAutoLock(backgroundedAtMs: Long?, nowMs: Long): Boolean =
            backgroundedAtMs != null && nowMs - backgroundedAtMs > LOCK_TIMEOUT_MS

        /**
         * Parse a `llamenos://` URI into a navigation destination.
         *
         * Supported URIs:
         * - `llamenos://cases` / `llamenos://cases/{id}`
         * - `llamenos://notes` / `llamenos://notes/{id}`
         * - `llamenos://calls` / `llamenos://calls/{id}`
         * - `llamenos://conversations` / `llamenos://conversations/{id}`
         * - `llamenos://reports` / `llamenos://reports/{id}`
         * - `llamenos://settings`
         * - `llamenos://admin`
         * - `llamenos://incidents`
         */
        fun parseDeepLink(uri: Uri): DeepLinkDestination? {
            if (uri.scheme != "llamenos") return null
            val host = uri.host ?: return null
            val pathSegments = uri.pathSegments

            return when (host) {
                "cases" -> {
                    val id = pathSegments.firstOrNull()
                    if (id != null) DeepLinkDestination.CaseDetail(id)
                    else DeepLinkDestination.Cases
                }
                "notes" -> {
                    val id = pathSegments.firstOrNull()
                    if (id != null) DeepLinkDestination.NoteDetail(id)
                    else DeepLinkDestination.Notes
                }
                "calls" -> {
                    val id = pathSegments.firstOrNull()
                    if (id != null) DeepLinkDestination.CallDetail(id)
                    else DeepLinkDestination.CallHistory
                }
                "conversations" -> {
                    val id = pathSegments.firstOrNull()
                    if (id != null) DeepLinkDestination.ConversationDetail(id)
                    else DeepLinkDestination.Conversations
                }
                "reports" -> {
                    val id = pathSegments.firstOrNull()
                    if (id != null) DeepLinkDestination.ReportDetail(id)
                    else DeepLinkDestination.Reports
                }
                "settings" -> DeepLinkDestination.Settings
                "admin" -> DeepLinkDestination.Admin
                "incidents" -> DeepLinkDestination.Incidents
                else -> null
            }
        }
    }
}
