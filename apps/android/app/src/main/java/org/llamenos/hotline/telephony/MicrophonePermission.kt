package org.llamenos.hotline.telephony

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat

/**
 * The runtime `RECORD_AUDIO` grant the call path needs.
 *
 * `RECORD_AUDIO` is declared in the manifest but is a *dangerous* permission, so on API 23+ the
 * declaration alone grants nothing — and nothing in the app ever asked for it in the call path
 * (#1188). A perfectly negotiated call would then come up with no microphone: liblinphone opens
 * the capture device as the call connects, fails, and the caller hears silence from a volunteer
 * who can hear them.
 *
 * Asked for at two points, deliberately:
 *
 *  - **Clocking in**, which is the moment the volunteer declares themselves answerable. The
 *    system dialog needs a foreground activity and an unlocked device, so this is the only point
 *    where it can reliably be shown; a refusal here is surfaced, not swallowed, and clocking in
 *    still succeeds — the volunteer keeps receiving phone calls.
 *  - **Answering**, as the backstop for a grant revoked since (Android can revoke it on app
 *    hibernation), and for a device that clocked in before this code existed.
 */
object MicrophonePermission {

    /** Whether this device has already granted `RECORD_AUDIO`. */
    fun isGranted(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
}

/**
 * Returns a function that reports whether `RECORD_AUDIO` is held, asking the user once if it is
 * not: `request { granted -> … }`.
 *
 * The callback runs synchronously when the permission is already held, and from the system
 * dialog's result otherwise. The caller decides what a refusal means — this never decides for
 * them, because "answer anyway with no microphone" and "clock in anyway without in-app calls"
 * are different answers.
 */
@Composable
fun rememberMicrophoneRequest(): (onResult: (Boolean) -> Unit) -> Unit {
    val context = LocalContext.current
    val pending = remember { mutableStateOf<((Boolean) -> Unit)?>(null) }
    val launcher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) { granted ->
        val callback = pending.value
        pending.value = null
        callback?.invoke(granted)
    }
    return remember(launcher) {
        { onResult ->
            if (MicrophonePermission.isGranted(context)) {
                onResult(true)
            } else {
                pending.value = onResult
                launcher.launch(Manifest.permission.RECORD_AUDIO)
            }
        }
    }
}
