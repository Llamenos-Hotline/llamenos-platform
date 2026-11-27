package org.llamenos.hotline

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import dagger.hilt.android.AndroidEntryPoint
import org.llamenos.hotline.telephony.CallNotificationTap
import javax.inject.Inject

/**
 * Receives a tap on a call notification, switches to the call's hub, and brings the app
 * forward. Not exported, so only this app's own notification can start it; see
 * [CallNotificationTap] for why the hub is read here and not in [MainActivity].
 */
@AndroidEntryPoint
class CallNotificationTapActivity : ComponentActivity() {

    @Inject
    lateinit var callNotificationTap: CallNotificationTap

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        callNotificationTap.onTap(intent)
        startActivity(
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        )
        // Theme.NoDisplay: the activity must finish before onResume.
        finish()
    }
}
