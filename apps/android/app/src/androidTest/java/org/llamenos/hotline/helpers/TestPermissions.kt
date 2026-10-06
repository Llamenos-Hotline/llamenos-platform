package org.llamenos.hotline.helpers

import androidx.test.platform.app.InstrumentationRegistry

/**
 * Runtime permission grants for instrumented tests.
 *
 * Dangerous permissions are declared in the app manifest but granted to nothing on API 23+, so
 * the first screen that asks for one raises a system dialog. That dialog is an overlay owned by
 * the permission controller: the Compose test harness cannot see or dismiss it, the callback the
 * screen is waiting on never fires, and the flow stalls — which is exactly what happened to the
 * Shifts clock-in flow once it started asking for `RECORD_AUDIO`
 * ([org.llamenos.hotline.telephony.rememberMicrophoneRequest]).
 *
 * Granting from inside the instrumentation process is the only grant that survives: the M1 probe
 * gate runs `pm clear` before every flow, which revokes every runtime permission, so anything
 * granted by the CI script beforehand is gone by the time the app starts.
 */
object TestPermissions {

    /**
     * Permissions every instrumented run needs up front.
     *
     *  - `RECORD_AUDIO` — asked for at clock-in and at answer (#1188).
     *  - `CAMERA` — asked for by the Device Linking QR scanner.
     */
    private val ALWAYS_GRANTED = listOf(
        android.Manifest.permission.RECORD_AUDIO,
        android.Manifest.permission.CAMERA,
    )

    /**
     * Grants [permissions] (default: [ALWAYS_GRANTED]) to the app under test.
     *
     * `grantRuntimePermission` is synchronous — unlike `executeShellCommand("pm grant …")`, which
     * returns before the grant has landed and can race the first screen that needs it.
     */
    fun grant(permissions: List<String> = ALWAYS_GRANTED) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val packageName = instrumentation.targetContext.packageName
        permissions.forEach { permission ->
            instrumentation.uiAutomation.grantRuntimePermission(packageName, permission)
        }
    }
}
