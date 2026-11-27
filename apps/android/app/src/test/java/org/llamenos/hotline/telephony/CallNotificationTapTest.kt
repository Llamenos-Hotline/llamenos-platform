package org.llamenos.hotline.telephony

import android.app.Application
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.Test
import org.junit.runner.RunWith
import org.llamenos.hotline.CallNotificationTapActivity
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.hub.HubRepository
import org.llamenos.hotline.service.PushService
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * The tap path of the multi-hub axiom (#1019): tapping a call notification switches to the
 * call's hub; posting it, and the full-screen launch the system makes by itself on a ring,
 * switch nothing.
 *
 * The intents are the ones the real notifications carry, read back out of the posted
 * notification, and fed to the real tap handler — so what is asserted is what a tap does.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class CallNotificationTapTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val hubRepository = mockk<HubRepository>(relaxed = true)
    private val tap = CallNotificationTap(hubRepository, TestScope(UnconfinedTestDispatcher()))

    private fun savedIntent(pending: android.app.PendingIntent?): Intent =
        assertNotNull(shadowOf(assertNotNull(pending)).savedIntent)

    private fun postedNotification(): android.app.Notification {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        return assertNotNull(shadowOf(manager).allNotifications.singleOrNull(), "one notification posted")
    }

    @Test
    fun `tapping the ringing call notification switches to the call's hub`() {
        val crypto = mockk<CryptoService>(relaxed = true)
        every { crypto.isUnlocked } returns true
        val ring = RingingCallInfo(callId = "sip-call-1", remoteAddress = "sip:x@y", remoteDisplayName = null, hubId = "hub-b")

        IncomingCallNotifier(context, crypto).showIncomingCall(ring)

        // Posting the notification is part of the ring: nothing switched yet.
        coVerify(exactly = 0) { hubRepository.switchToMemberHub(any()) }

        val content = savedIntent(postedNotification().contentIntent)
        assertEquals(CallNotificationTapActivity::class.java.name, content.component?.className)
        assertEquals("hub-b", tap.onTap(content))
        coVerify(exactly = 1) { hubRepository.switchToMemberHub("hub-b") }
    }

    @Test
    fun `the full-screen launch a ring fires by itself switches no hub`() {
        val crypto = mockk<CryptoService>(relaxed = true)
        val ring = RingingCallInfo(callId = "sip-call-1", remoteAddress = "sip:x@y", remoteDisplayName = null, hubId = "hub-b")

        IncomingCallNotifier(context, crypto).showIncomingCall(ring)

        val fullScreen = savedIntent(postedNotification().fullScreenIntent)
        assertNull(tap.onTap(fullScreen))
        coVerify(exactly = 0) { hubRepository.switchToMemberHub(any()) }
    }

    @Test
    fun `tapping a pushed call notification switches to the hub the push named`() {
        val notification = PushService.buildCallNotification(context, "hub-c", "Incoming call")

        assertEquals("hub-c", tap.onTap(savedIntent(notification.contentIntent)))
        coVerify(exactly = 1) { hubRepository.switchToMemberHub("hub-c") }
    }

    @Test
    fun `tapping a call notification that names no hub opens the app and switches nothing`() {
        val notification = PushService.buildCallNotification(context, null, "Incoming call")

        val content = savedIntent(notification.contentIntent)
        assertEquals(CallNotificationTapActivity::class.java.name, content.component?.className)
        assertNull(tap.onTap(content))
        coVerify(exactly = 0) { hubRepository.switchToMemberHub(any()) }
    }

    @Test
    fun `an intent that is not a call notification tap switches nothing, whatever it carries`() {
        val forged = Intent(Intent.ACTION_VIEW).putExtra(CallNotificationTap.EXTRA_HUB_ID, "hub-evil")

        assertNull(tap.onTap(forged))
        assertNull(tap.onTap(null))
        coVerify(exactly = 0) { hubRepository.switchToMemberHub(any()) }
    }
}
