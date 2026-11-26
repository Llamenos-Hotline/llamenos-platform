package org.llamenos.hotline.telephony

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.llamenos.hotline.CallNotificationTapActivity
import org.llamenos.hotline.di.ApplicationScope
import org.llamenos.hotline.hub.HubRepository
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The user tapping a call notification: the one notification path the multi-hub axiom
 * allows to switch the active hub (CLAUDE.md — "only explicit user tap actions or the
 * app-unlocked call answer path may switch the active hub").
 *
 * Every call notification — the VoIP push's, the wake push's, the full-tier push's, and the
 * ringing INVITE's — gets [pendingIntent] as its CONTENT intent, carrying the call's hub. It
 * is never used as a full-screen intent: the system fires a full-screen intent by itself when
 * a call rings on a locked or idle device, so a hub carried on one would switch the hub on
 * the ring, which is exactly what the axiom forbids.
 *
 * The intent targets [CallNotificationTapActivity], which is not exported: another app on
 * the device cannot address it, so it cannot move the volunteer's browsing context by
 * sending an intent with a hub in it. MainActivity is exported (it is the launcher) and so
 * is deliberately not where the hub is read.
 */
@Singleton
class CallNotificationTap @Inject constructor(
    private val hubRepository: HubRepository,
    @ApplicationScope private val scope: CoroutineScope,
) {
    /**
     * Act on a tap. Returns the hub switched to, or null when [intent] is not a call
     * notification tap or names no hub — in which case nothing is switched.
     *
     * The switch runs on the application scope: the tap activity finishes at once, and the
     * hub key refresh that follows the switch must not be cancelled with it.
     */
    fun onTap(intent: Intent?): String? {
        val hubId = hubToActivate(intent) ?: return null
        scope.launch { hubRepository.switchHub(hubId) }
        return hubId
    }

    companion object {
        const val ACTION_OPEN_CALL = "org.llamenos.hotline.action.OPEN_CALL"
        const val EXTRA_HUB_ID = "org.llamenos.hotline.extra.HUB_ID"

        /** One request code: every call notification shares one slot (see PushService). */
        private const val REQUEST_CODE = 2001

        /** The content intent for a call notification announcing a call in [hubId]. */
        fun pendingIntent(context: Context, hubId: String?): PendingIntent {
            val intent = Intent(context, CallNotificationTapActivity::class.java)
                .setAction(ACTION_OPEN_CALL)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            hubId?.takeIf { it.isNotBlank() }?.let { intent.putExtra(EXTRA_HUB_ID, it) }
            return PendingIntent.getActivity(
                context,
                REQUEST_CODE,
                intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }

        /** The hub a launch asks to switch to: only a call notification tap names one. */
        fun hubToActivate(intent: Intent?): String? {
            if (intent?.action != ACTION_OPEN_CALL) return null
            return intent.getStringExtra(EXTRA_HUB_ID)?.takeIf { it.isNotBlank() }
        }
    }
}
