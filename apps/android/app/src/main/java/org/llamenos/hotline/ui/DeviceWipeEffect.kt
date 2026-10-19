package org.llamenos.hotline.ui

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalContext
import org.llamenos.hotline.api.DeviceWipeCommand
import org.llamenos.hotline.api.WebSocketService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.KeystoreService

/**
 * Executes remote wipes for as long as it is composed.
 *
 * It collects [WebSocketService.deviceWipes], which carries only commands that
 * passed signature, target and freshness verification — never an ordinary relay
 * event. (#1093: this used to filter the hub-event flow with an erased
 * `filterIsInstance<AttributedHubEvent<DeviceWipe>>()`, which let every event
 * type through and crashed the app on the first `call:ring`.)
 *
 * @param onWiped called after local state is destroyed, with the wipe reason
 */
@Composable
fun DeviceWipeEffect(
    webSocketService: WebSocketService,
    keystoreService: KeystoreService,
    cryptoService: CryptoService,
    onWiped: (reason: String) -> Unit,
) {
    val context = LocalContext.current
    LaunchedEffect(webSocketService) {
        webSocketService.deviceWipes.collect { command: DeviceWipeCommand ->
            wipeLocalState(context, keystoreService, cryptoService)
            onWiped(command.reason)
        }
    }
}

private fun wipeLocalState(
    context: Context,
    keystoreService: KeystoreService,
    cryptoService: CryptoService,
) {
    // Clear ALL encrypted storage and AndroidKeyStore keys
    keystoreService.wipeAll()
    // Zeroize Rust crypto state (hub keys, server event keys, device keys)
    cryptoService.clearHubKeys()
    cryptoService.lock()
    // Clear transcription preferences (separate SharedPreferences instance)
    context.getSharedPreferences("transcription_prefs", Context.MODE_PRIVATE)
        .edit().clear().apply()
    // Clear app cache directory
    context.cacheDir.listFiles()?.forEach { it.deleteRecursively() }
}
