package org.llamenos.hotline.service

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * State representing the current transcription status.
 */
sealed interface TranscriptionState {
    /** Service idle, not transcribing. */
    data object Idle : TranscriptionState

    /** Actively transcribing audio. */
    data object Transcribing : TranscriptionState

    /** Transcription stopped, final result available. */
    data object Stopped : TranscriptionState

    /** An error occurred during transcription. */
    data class Error(val message: String) : TranscriptionState
}

/**
 * On-device speech transcription using Android's SpeechRecognizer.
 * Audio never leaves the device — recognition is on-device only (Android 12+); when the
 * device has no on-device recognizer transcription is unavailable, never cloud-backed. Supports real-time streaming transcription
 * during calls.
 *
 * Injected as a singleton via Hilt. Manages SpeechRecognizer lifecycle
 * and emits transcription results via StateFlows.
 */
@Singleton
class TranscriptionService @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    // MARK: - Public State

    private val _state = MutableStateFlow<TranscriptionState>(TranscriptionState.Idle)
    val state: StateFlow<TranscriptionState> = _state.asStateFlow()

    private val _liveTranscript = MutableStateFlow("")
    val liveTranscript: StateFlow<String> = _liveTranscript.asStateFlow()

    private val _finalTranscript = MutableStateFlow("")
    val finalTranscript: StateFlow<String> = _finalTranscript.asStateFlow()

    /**
     * Whether on-device speech recognition is available (Android 12+ with an on-device model).
     * Transcription never uses the default (cloud) recognition service (#2951).
     */
    val isAvailable: Boolean
        get() = OnDeviceSpeech.isAvailable(context)

    // MARK: - Preferences

    /** Whether transcription is enabled by the user. */
    var isEnabled: Boolean
        get() = prefs.getBoolean(PREF_ENABLED, false)
        set(value) = prefs.edit().putBoolean(PREF_ENABLED, value).apply()

    /** Selected language for transcription. Empty string = auto-detect. */
    var selectedLanguage: String
        get() = prefs.getString(PREF_LANGUAGE, "") ?: ""
        set(value) = prefs.edit().putString(PREF_LANGUAGE, value).apply()

    // MARK: - Private

    private var speechRecognizer: SpeechRecognizer? = null
    private val accumulatedTranscript = StringBuilder()
    private val prefs by lazy {
        context.getSharedPreferences("transcription_prefs", Context.MODE_PRIVATE)
    }

    /**
     * Start real-time on-device transcription.
     * Audio is captured from the microphone and processed locally via SpeechRecognizer.
     * The [liveTranscript] flow updates in real-time as speech is recognized.
     *
     * Caller must have already obtained RECORD_AUDIO permission.
     */
    fun startTranscription() {
        if (_state.value == TranscriptionState.Transcribing) return

        val recognizer = OnDeviceSpeech.create(context)
        if (recognizer == null) {
            _state.value = TranscriptionState.Error(
                context.getString(org.llamenos.hotline.R.string.transcription_on_device_unavailable)
            )
            return
        }

        accumulatedTranscript.clear()
        _liveTranscript.value = ""
        _finalTranscript.value = ""

        recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {
                _state.value = TranscriptionState.Transcribing
            }

            override fun onBeginningOfSpeech() {}

            override fun onRmsChanged(rmsdB: Float) {}

            override fun onBufferReceived(buffer: ByteArray?) {}

            override fun onEndOfSpeech() {
                // SpeechRecognizer auto-stops after silence.
                // Restart if we're still in transcribing state to keep capturing.
                if (_state.value == TranscriptionState.Transcribing) {
                    restartListening(recognizer)
                }
            }

            override fun onError(error: Int) {
                when (error) {
                    SpeechRecognizer.ERROR_NO_MATCH,
                    SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> {
                        // No speech detected — restart listening if still active
                        if (_state.value == TranscriptionState.Transcribing) {
                            restartListening(recognizer)
                        }
                    }
                    SpeechRecognizer.ERROR_CLIENT -> {
                        // Client-side error, usually from cancellation — ignore if stopping
                        if (_state.value == TranscriptionState.Transcribing) {
                            _state.value = TranscriptionState.Error(
                                context.getString(org.llamenos.hotline.R.string.transcription_transcription_error)
                            )
                        }
                    }
                    else -> {
                        _state.value = TranscriptionState.Error(
                            context.getString(org.llamenos.hotline.R.string.transcription_transcription_error)
                        )
                    }
                }
            }

            override fun onResults(results: Bundle?) {
                val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                val text = matches?.firstOrNull() ?: return

                if (text.isNotBlank()) {
                    if (accumulatedTranscript.isNotEmpty()) {
                        accumulatedTranscript.append(" ")
                    }
                    accumulatedTranscript.append(text)
                    _liveTranscript.value = accumulatedTranscript.toString()
                }

                // Restart listening to continue capturing
                if (_state.value == TranscriptionState.Transcribing) {
                    restartListening(recognizer)
                }
            }

            override fun onPartialResults(partialResults: Bundle?) {
                val matches = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                val text = matches?.firstOrNull() ?: return

                // Show accumulated + current partial
                val current = if (accumulatedTranscript.isNotEmpty()) {
                    "${accumulatedTranscript} $text"
                } else {
                    text
                }
                _liveTranscript.value = current
            }

            override fun onEvent(eventType: Int, params: Bundle?) {}
        })

        speechRecognizer = recognizer
        startListening(recognizer)
    }

    /**
     * Stop transcription and finalize the transcript.
     * Returns the accumulated transcript text.
     */
    fun stopTranscription(): String {
        speechRecognizer?.stopListening()
        speechRecognizer?.cancel()
        speechRecognizer?.destroy()
        speechRecognizer = null

        val transcript = _liveTranscript.value
        _finalTranscript.value = transcript
        _state.value = TranscriptionState.Stopped

        return transcript
    }

    /** Reset the service to idle, clearing all transcript data. */
    fun reset() {
        stopTranscription()
        _liveTranscript.value = ""
        _finalTranscript.value = ""
        accumulatedTranscript.clear()
        _state.value = TranscriptionState.Idle
    }

    // MARK: - Private Helpers

    private fun createRecognizerIntent(): Intent {
        return Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(
                RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
            )
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)

            // Set language preference
            val language = selectedLanguage
            if (language.isNotEmpty()) {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, language)
            }

            // The recognizer is on-device by construction (OnDeviceSpeech.create); this extra
            // only tells the on-device service not to reach for the network either.
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        }
    }

    private fun startListening(recognizer: SpeechRecognizer) {
        try {
            recognizer.startListening(createRecognizerIntent())
        } catch (e: Exception) {
            _state.value = TranscriptionState.Error(e.message ?: "Failed to start listening")
        }
    }

    private fun restartListening(recognizer: SpeechRecognizer) {
        try {
            recognizer.startListening(createRecognizerIntent())
        } catch (_: Exception) {
            // If restart fails, that's okay — user can restart manually
        }
    }

    companion object {
        private const val PREF_ENABLED = "transcription_enabled"
        private const val PREF_LANGUAGE = "transcription_language"
    }
}
