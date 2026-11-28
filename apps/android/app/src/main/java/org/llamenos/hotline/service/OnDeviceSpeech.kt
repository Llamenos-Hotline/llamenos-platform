package org.llamenos.hotline.service

import android.content.Context
import android.os.Build
import android.speech.SpeechRecognizer

/**
 * The only place a [SpeechRecognizer] may be constructed (#2951).
 *
 * `SpeechRecognizer.createSpeechRecognizer` binds the device's *default* recognition
 * service, which on most devices is Google cloud recognition — crisis calls and volunteers'
 * own voices would leave the device. `EXTRA_PREFER_OFFLINE` is a preference, not a guarantee,
 * so it cannot be the control.
 *
 * This object fails closed: recognition exists only through `createOnDeviceSpeechRecognizer`
 * (API 31+), and when the device has no on-device recognizer there is no recognizer at all.
 * Callers surface "unavailable" to the user; they never retry with the default service.
 * `OnDeviceSpeechTest` fails the build if any other source file reaches the default service.
 */
object OnDeviceSpeech {
    /** Whether this device can recognise speech without the network (API 31+ with an on-device model). */
    fun isAvailable(context: Context): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            SpeechRecognizer.isOnDeviceRecognitionAvailable(context)

    /**
     * An on-device-only recognizer, or null when the device has none. Never falls back to the
     * default (cloud) recognition service.
     */
    fun create(context: Context): SpeechRecognizer? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
        ) {
            SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
        } else {
            null
        }
}
