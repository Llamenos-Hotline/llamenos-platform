package org.llamenos.hotline.telephony

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton
import org.llamenos.hotline.MainActivity
import org.llamenos.hotline.R
import org.llamenos.hotline.crypto.CryptoService

/**
 * Posts the inbound-call notification for a ringing in-app call and cancels it when the
 * ring ends (answered, declined, or the caller hung up).
 *
 * The notification is what reaches the user when the app is backgrounded or the device is
 * dozing/locked: high priority + [NotificationCompat.CATEGORY_CALL], a content intent that
 * brings [MainActivity] forward (the #1019 tap-intent gap for inbound calls), and a
 * full-screen intent (USE_FULL_SCREEN_INTENT is already declared) so the incoming-call
 * screen shows over the lockscreen instead of a heads-up banner.
 *
 * Uses the same channel and notification id as the VoIP-push notification in PushService:
 * this notification replaces that one when the INVITE actually arrives, so the user never
 * sees two "incoming call" notifications for the same call.
 */
@Singleton
class IncomingCallNotifier @Inject constructor(
    @ApplicationContext private val context: Context,
    private val cryptoService: CryptoService,
) {
    fun showIncomingCall(info: RingingCallInfo) {
        ensureChannel()

        // Same PII posture as the push path: the caller's number is only shown once the
        // app is unlocked; a locked device gets the generic label.
        val callerText = if (cryptoService.isUnlocked) {
            info.remoteDisplayName ?: info.remoteAddress
        } else {
            context.getString(R.string.incoming_call_body)
        }

        val launch = Intent(context, MainActivity::class.java)
            .setAction(ACTION_INCOMING_CALL)
            .putExtra(EXTRA_CALL_ID, info.callId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val launchPending = PendingIntent.getActivity(
            context,
            REQUEST_INCOMING_CALL,
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.incoming_call))
            .setContentText(callerText)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(launchPending)
            .setFullScreenIntent(launchPending, true)
            .setVibrate(longArrayOf(0, 500, 200, 500))
            .build()

        notificationManager().notify(NOTIFICATION_ID_INCOMING_CALL, notification)
    }

    fun cancel() {
        notificationManager().cancel(NOTIFICATION_ID_INCOMING_CALL)
    }

    private fun notificationManager(): NotificationManager =
        context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_CALLS,
                context.getString(R.string.notification_channel_calls),
                NotificationManager.IMPORTANCE_HIGH,
            )
            notificationManager().createNotificationChannel(channel)
        }
    }

    companion object {
        const val ACTION_INCOMING_CALL = "org.llamenos.hotline.action.INCOMING_CALL"
        const val EXTRA_CALL_ID = "org.llamenos.hotline.extra.CALL_ID"

        private const val CHANNEL_CALLS = "llamenos_calls"
        private const val NOTIFICATION_ID_INCOMING_CALL = 1001
        private const val REQUEST_INCOMING_CALL = 1001
    }
}
