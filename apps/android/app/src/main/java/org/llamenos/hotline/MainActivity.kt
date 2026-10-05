package org.llamenos.hotline

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
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

    /** Pending deep link destination, consumed by LlamenosNavigation on composition. */
    internal var pendingDeepLink: DeepLinkDestination? = null
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
        backgroundTimestamp?.let { timestamp ->
            val elapsed = System.currentTimeMillis() - timestamp
            if (elapsed > LOCK_TIMEOUT_MS) {
                cryptoService.lock()
            }
        }
        backgroundTimestamp = null
    }

    companion object {
        private const val LOCK_TIMEOUT_MS = 5L * 60L * 1000L // 5 minutes

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
                else -> null
            }
        }
    }
}
