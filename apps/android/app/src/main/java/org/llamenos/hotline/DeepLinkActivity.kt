package org.llamenos.hotline

import android.content.Intent
import android.os.Bundle
import android.util.Log
import org.llamenos.hotline.BuildConfig
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.launch
import org.llamenos.hotline.api.ProviderSetupRepository
import org.llamenos.hotline.crypto.KeyValueStore
import org.llamenos.hotline.crypto.KeystoreService
import org.llamenos.hotline.hub.HubRepository
import org.llamenos.hotline.ui.DeepLinkDestination
import java.security.SecureRandom
import javax.inject.Inject

/**
 * Handles deep links into the app.
 *
 * All incoming URIs are validated against [DeepLinkValidator] before processing.
 * Sensitive actions (e.g. hub switching) require user confirmation.
 *
 * Registered in AndroidManifest.xml with intent filters for:
 * - `llamenos://oauth/callback` (OAuth provider callbacks)
 * - `llamenos://call/answer` (call deep links)
 * - `llamenos://hub/switch` (hub switch deep links, user confirmation required)
 */
@AndroidEntryPoint
class DeepLinkActivity : ComponentActivity() {

    @Inject
    lateinit var providerSetupRepository: ProviderSetupRepository

    @Inject
    lateinit var hubRepository: HubRepository

    @Inject
    lateinit var keystoreService: KeyValueStore

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val data = intent?.data
        if (data == null || !DeepLinkValidator.isAllowed(data)) {
            finish()
            return
        }

        if (DeepLinkValidator.requiresConfirmation(data)) {
            showConfirmationDialog(data)
        } else {
            routeDeepLink(data)
        }
    }

    private fun showConfirmationDialog(uri: android.net.Uri) {
        android.app.AlertDialog.Builder(this)
            .setTitle(getString(R.string.deep_link_confirm_title))
            .setMessage(getString(R.string.deep_link_confirm_message, uri.host))
            .setPositiveButton(getString(R.string.deep_link_confirm_proceed)) { _, _ ->
                routeDeepLink(uri)
            }
            .setNegativeButton(getString(R.string.deep_link_confirm_cancel)) { _, _ ->
                finish()
            }
            .setOnCancelListener { finish() }
            .show()
    }

    private fun routeDeepLink(uri: android.net.Uri) {
        when (uri.host) {
            "oauth" -> handleOAuthCallback(uri)
            "call" -> handleCallDeepLink(uri)
            "hub" -> handleHubDeepLink(uri)
            else -> finish()
        }
    }

    private fun handleCallDeepLink(uri: android.net.Uri) {
        val callId = uri.getQueryParameter("callId")
        if (callId != null) {
            if (BuildConfig.DEBUG) Log.d(TAG, "Call deep link received")
            val intent = Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
                data = android.net.Uri.parse("llamenos://calls/$callId")
            }
            startActivity(intent)
        }
        finish()
    }

    private fun handleHubDeepLink(uri: android.net.Uri) {
        // Reject any injected relayUrl parameter — if present it must use wss:// and
        // match the configured hub domain to prevent MITM via relay URL injection (H33).
        val injectedRelayUrl = uri.getQueryParameter("relayUrl")
        if (injectedRelayUrl != null) {
            val configuredHubUrl = keystoreService.retrieve(KeystoreService.KEY_HUB_URL)
            if (configuredHubUrl == null ||
                !DeepLinkValidator.isValidRelayParam(injectedRelayUrl, configuredHubUrl)
            ) {
                Log.w(TAG, "Hub deep link rejected: invalid or mismatched relayUrl parameter")
                finish()
                return
            }
        }

        val hubId = uri.getQueryParameter("hubId")
        if (hubId != null) {
            if (BuildConfig.DEBUG) Log.d(TAG, "Hub deep link received")
            // Hub switch was already confirmed via showConfirmationDialog() before reaching here.
            // This is an explicit user action (tap → confirmation dialog → proceed), not background processing.
            // The link comes from outside the app, so its hub is switched to only if the
            // server lists it among the user's hubs; otherwise the app opens unchanged.
            lifecycleScope.launch {
                hubRepository.switchToMemberHub(hubId)
                val intent = Intent(this@DeepLinkActivity, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
                }
                startActivity(intent)
                finish()
            }
            return
        }
        finish()
    }

    private fun handleOAuthCallback(uri: android.net.Uri) {
        val incomingState = uri.getQueryParameter("state")
        val expectedState = pendingOAuthState

        if (expectedState == null || incomingState != expectedState) {
            setResult(RESULT_CANCELED, Intent().apply {
                putExtra("status", "error")
                putExtra("message", "OAuth state validation failed")
            })
            finish()
            return
        }

        pendingOAuthState = null

        val status = uri.getQueryParameter("status")
        val message = uri.getQueryParameter("message")

        when (status) {
            "success" -> {
                lifecycleScope.launch {
                    setResult(RESULT_OK, Intent().apply {
                        putExtra("status", "success")
                    })
                    finish()
                }
            }
            "error" -> {
                setResult(RESULT_CANCELED, Intent().apply {
                    putExtra("status", "error")
                    putExtra("message", message ?: "Unknown error")
                })
                finish()
            }
            else -> {
                setResult(RESULT_CANCELED)
                finish()
            }
        }
    }

    companion object {
        private const val TAG = "DeepLinkActivity"
        private val secureRandom = SecureRandom()

        @Volatile
        var pendingOAuthState: String? = null
            private set

        fun generateOAuthState(): String {
            val bytes = ByteArray(32)
            secureRandom.nextBytes(bytes)
            val state = bytes.joinToString("") { "%02x".format(it) }
            pendingOAuthState = state
            return state
        }
    }
}
