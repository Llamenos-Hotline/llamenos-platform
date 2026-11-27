package org.llamenos.hotline.ui.reports

import android.Manifest
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R
import org.llamenos.hotline.service.OnDeviceSpeech

/**
 * State holder for the speech recognition lifecycle.
 */
private enum class AudioInputState {
    /** Idle — ready to start recording. */
    IDLE,
    /** Actively listening for speech. */
    LISTENING,
    /** Permission denied or SpeechRecognizer unavailable. */
    UNAVAILABLE,
    /** An error occurred during recognition. */
    ERROR,
}

/**
 * Audio input button that uses Android SpeechRecognizer for voice-to-text.
 *
 * Appears as a mic IconButton next to textarea fields that have `supportAudioInput = true`.
 * Starts/stops real-time speech recognition and appends transcribed text to the field.
 *
 * Handles:
 * - RECORD_AUDIO runtime permission request
 * - On-device recognition only (API 31+): when the device has no on-device recognizer the
 *   button reports why and never falls back to the default (cloud) service
 * - Error states with user-visible status text
 *
 * @param currentText The current text in the associated field
 * @param onTextUpdate Callback with the new text (existing + transcribed, space-separated)
 * @param modifier Optional modifier for the button
 * @param testTagPrefix Prefix for test tags (e.g., "field-description")
 */
@Composable
fun AudioInputButton(
    currentText: String,
    onTextUpdate: (String) -> Unit,
    modifier: Modifier = Modifier,
    testTagPrefix: String = "audio-input",
) {
    val context = LocalContext.current
    val strPermissionDenied = stringResource(R.string.report_typed_audio_permission_denied)
    val strUnavailable = stringResource(R.string.audio_input_on_device_unavailable)
    val strListening = stringResource(R.string.report_typed_audio_listening)
    val strError = stringResource(R.string.report_typed_audio_error)
    var audioState by remember { mutableStateOf(AudioInputState.IDLE) }
    var statusText by remember { mutableStateOf<String?>(null) }
    var speechRecognizer by remember { mutableStateOf<SpeechRecognizer?>(null) }
    var hasPermission by remember { mutableStateOf(false) }

    // Dictation is on-device only (#2951): without an on-device recognizer the button is
    // unavailable and says why. It never uses the default (cloud) recognition service.
    val isAvailable = remember {
        OnDeviceSpeech.isAvailable(context)
    }

    // Permission launcher
    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) { granted ->
        hasPermission = granted
        if (granted && isAvailable) {
            audioState = AudioInputState.IDLE
        } else if (!granted) {
            audioState = AudioInputState.UNAVAILABLE
            statusText = strPermissionDenied
        }
    }

    // Clean up SpeechRecognizer on disposal
    DisposableEffect(Unit) {
        onDispose {
            speechRecognizer?.apply {
                stopListening()
                cancel()
                destroy()
            }
            speechRecognizer = null
        }
    }

    /**
     * Start speech recognition with a new SpeechRecognizer instance.
     */
    fun startListening() {
        if (!isAvailable) {
            audioState = AudioInputState.UNAVAILABLE
            statusText = strUnavailable
            return
        }

        // Create a fresh recognizer each time (Android quirk: reused recognizers can stall)
        speechRecognizer?.destroy()
        val recognizer = OnDeviceSpeech.create(context)
        if (recognizer == null) {
            speechRecognizer = null
            audioState = AudioInputState.UNAVAILABLE
            statusText = strUnavailable
            return
        }
        speechRecognizer = recognizer

        recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {
                audioState = AudioInputState.LISTENING
                statusText = strListening
            }

            override fun onBeginningOfSpeech() {
                // Already in LISTENING state
            }

            override fun onRmsChanged(rmsdB: Float) {
                // Could be used for visual level indicator — not needed for MVP
            }

            override fun onBufferReceived(buffer: ByteArray?) {
                // Raw audio buffer — not used
            }

            override fun onEndOfSpeech() {
                audioState = AudioInputState.IDLE
                statusText = null
            }

            override fun onError(error: Int) {
                audioState = when (error) {
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> AudioInputState.UNAVAILABLE
                    SpeechRecognizer.ERROR_NO_MATCH -> AudioInputState.IDLE
                    else -> AudioInputState.ERROR
                }
                statusText = when (error) {
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS ->
                        strPermissionDenied
                    SpeechRecognizer.ERROR_NO_MATCH ->
                        null // Silent — no speech detected is not an error to show
                    SpeechRecognizer.ERROR_NETWORK,
                    SpeechRecognizer.ERROR_NETWORK_TIMEOUT ->
                        strError
                    else ->
                        strError
                }
            }

            override fun onResults(results: Bundle?) {
                val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                val transcribed = matches?.firstOrNull()
                if (!transcribed.isNullOrBlank()) {
                    val newText = if (currentText.isBlank()) {
                        transcribed
                    } else {
                        "$currentText $transcribed"
                    }
                    onTextUpdate(newText)
                }
                audioState = AudioInputState.IDLE
                statusText = null
            }

            override fun onPartialResults(partialResults: Bundle?) {
                // Partial results could be shown in real-time — keeping simple for now
            }

            override fun onEvent(eventType: Int, params: Bundle?) {
                // Reserved for future use
            }
        })

        val intent = createRecognizerIntent(context)
        recognizer.startListening(intent)
    }

    /**
     * Stop the current speech recognition session.
     */
    fun stopListening() {
        speechRecognizer?.stopListening()
        audioState = AudioInputState.IDLE
        statusText = null
    }

    // Animated tint color for the button
    val buttonColor by animateColorAsState(
        targetValue = when (audioState) {
            AudioInputState.LISTENING -> MaterialTheme.colorScheme.error
            AudioInputState.UNAVAILABLE -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.38f)
            AudioInputState.ERROR -> MaterialTheme.colorScheme.error.copy(alpha = 0.6f)
            AudioInputState.IDLE -> MaterialTheme.colorScheme.primary
        },
        label = "audioButtonColor",
    )

    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier,
    ) {
        IconButton(
            onClick = {
                when (audioState) {
                    AudioInputState.IDLE -> {
                        if (!isAvailable) {
                            audioState = AudioInputState.UNAVAILABLE
                            statusText = strUnavailable
                        } else if (!hasPermission) {
                            permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                        } else {
                            startListening()
                        }
                    }
                    AudioInputState.LISTENING -> {
                        stopListening()
                    }
                    AudioInputState.UNAVAILABLE, AudioInputState.ERROR -> {
                        // Try requesting permission again, or re-check availability
                        if (!hasPermission) {
                            permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                        } else {
                            audioState = AudioInputState.IDLE
                            statusText = null
                        }
                    }
                }
            },
            enabled = audioState != AudioInputState.UNAVAILABLE || !hasPermission,
            colors = IconButtonDefaults.iconButtonColors(
                contentColor = buttonColor,
            ),
            modifier = Modifier
                .size(40.dp)
                .testTag("$testTagPrefix-mic-button"),
        ) {
            Icon(
                imageVector = when (audioState) {
                    AudioInputState.LISTENING -> Icons.Filled.Stop
                    AudioInputState.UNAVAILABLE -> Icons.Filled.MicOff
                    else -> Icons.Filled.Mic
                },
                contentDescription = when (audioState) {
                    AudioInputState.LISTENING -> stringResource(R.string.report_typed_audio_stop)
                    else -> stringResource(R.string.report_typed_audio_start)
                },
                modifier = Modifier.size(24.dp),
            )
        }

        // Status text indicator
        if (statusText != null) {
            Spacer(Modifier.width(4.dp))
            Text(
                text = statusText ?: "",
                style = MaterialTheme.typography.labelSmall,
                color = when (audioState) {
                    AudioInputState.LISTENING -> MaterialTheme.colorScheme.primary
                    AudioInputState.ERROR, AudioInputState.UNAVAILABLE ->
                        MaterialTheme.colorScheme.error
                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                },
                modifier = Modifier.testTag("$testTagPrefix-status"),
            )
        }
    }
}

/**
 * Create the [Intent] for the Android SpeechRecognizer.
 *
 * Configured for free-form speech with partial results disabled (simpler UX),
 * and the device's default locale.
 */
private fun createRecognizerIntent(context: Context): Intent {
    return Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(
            RecognizerIntent.EXTRA_LANGUAGE_MODEL,
            RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
        )
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
        putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        putExtra(
            RecognizerIntent.EXTRA_LANGUAGE,
            java.util.Locale.getDefault().toLanguageTag(),
        )
    }
}
