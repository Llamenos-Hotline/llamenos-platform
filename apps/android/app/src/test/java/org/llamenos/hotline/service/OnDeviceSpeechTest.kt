package org.llamenos.hotline.service

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #2951 — speech recognition must fail closed. A device without an on-device recognizer gets
 * no recognizer at all, and no source file may reach the default (cloud-backed) service.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30], application = Application::class)
class OnDeviceSpeechTest {

    @Test
    fun `pre-API-31 device has no recognizer and does not fall back to the default service`() {
        val context = ApplicationProvider.getApplicationContext<Application>()
        assertFalse(OnDeviceSpeech.isAvailable(context))
        assertNull(OnDeviceSpeech.create(context))
    }

    /**
     * Structural guard: the default recognition service is reachable only through
     * `createSpeechRecognizer`. `createOnDeviceSpeechRecognizer` is the single allowed
     * constructor, and only [OnDeviceSpeech] calls it.
     */
    @Test
    fun `no source file can construct the default (cloud) recognizer`() {
        val sources = File("src/main/java")
        assertTrue(sources.isDirectory, "Source dir not found from ${File(".").absolutePath}")
        val files = sources.walkTopDown().filter { it.extension == "kt" }.toList()
        assertTrue(files.size > 50, "Guard scanned too few files (${files.size}) to mean anything")

        val cloudRecognizer = Regex("""\bcreateSpeechRecognizer\s*\(""")
        val onDeviceRecognizer = Regex("""\bcreateOnDeviceSpeechRecognizer\s*\(""")
        val cloud = files.filter { cloudRecognizer.containsMatchIn(it.readText()) }.map { it.name }
        val onDevice = files.filter { onDeviceRecognizer.containsMatchIn(it.readText()) }.map { it.name }

        assertEquals(emptyList(), cloud, "createSpeechRecognizer binds the cloud-backed default service")
        assertEquals(
            listOf("OnDeviceSpeech.kt"), onDevice,
            "Recognizers must be built through OnDeviceSpeech.create",
        )
    }
}
