import Foundation
import Speech
import AVFoundation

// MARK: - TranscriptionState

/// Observable state for transcription progress and results.
enum TranscriptionState: Equatable {
    /// Service idle, not transcribing.
    case idle
    /// Requesting permissions.
    case requestingPermission
    /// Actively transcribing audio.
    case transcribing
    /// Transcription stopped, final result available.
    case stopped
    /// An error occurred.
    case error(String)
}

// MARK: - TranscriptionService

/// On-device speech transcription using Apple's Speech framework.
/// Audio never leaves the device — all processing is local (on-device mode).
/// Supports real-time streaming transcription during calls.
///
/// `@MainActor` (#1920 audit): `TranscriptionOverlay` and the transcription settings render
/// this state on main, but `requestPermissions()` / `startTranscription()` were nonisolated
/// `async` and wrote `state` / `liveTranscript` on the global executor, and the audio tap
/// read `recognitionRequest` on the render thread while `stopTranscriptionInternal()` cleared
/// it. The Speech and AVAudioEngine callbacks stay explicitly off the main actor.
@MainActor
@Observable
final class TranscriptionService {
    // MARK: - Public State

    /// Current transcription state.
    var state: TranscriptionState = .idle

    /// Live transcript text, updated in real-time during transcription.
    var liveTranscript: String = ""

    /// Final transcript after transcription stops.
    var finalTranscript: String = ""

    /// Whether transcription is enabled in user preferences.
    var isEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: "transcription_enabled") }
        set { UserDefaults.standard.set(newValue, forKey: "transcription_enabled") }
    }

    /// Selected transcription language locale identifier (e.g. "en-US", "es-ES").
    /// Empty string means auto-detect.
    var selectedLanguage: String {
        get { UserDefaults.standard.string(forKey: "transcription_language") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "transcription_language") }
    }

    /// Whether speech recognition is available on this device.
    var isAvailable: Bool {
        SFSpeechRecognizer()?.isAvailable ?? false
    }

    /// Supported locale identifiers for speech recognition.
    var supportedLocales: [Locale] {
        Array(SFSpeechRecognizer.supportedLocales()).sorted { $0.identifier < $1.identifier }
    }

    // MARK: - Private

    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var audioEngine: AVAudioEngine?

    // MARK: - Permission

    /// Check and request speech recognition + microphone permissions.
    /// Returns true if both are granted.
    func requestPermissions() async -> Bool {
        state = .requestingPermission

        // Request speech recognition authorization
        let speechAuthorized = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }

        guard speechAuthorized else {
            state = .error(NSLocalizedString("transcription_mic_permission_denied", comment: ""))
            return false
        }

        // Request microphone permission
        let micAuthorized: Bool
        if #available(iOS 17, *) {
            micAuthorized = await AVAudioApplication.requestRecordPermission()
        } else {
            micAuthorized = await withCheckedContinuation { continuation in
                AVAudioSession.sharedInstance().requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
        }

        guard micAuthorized else {
            state = .error(NSLocalizedString("transcription_mic_permission_denied", comment: ""))
            return false
        }

        state = .idle
        return true
    }

    // MARK: - Start Transcription

    /// Start real-time on-device transcription.
    /// Audio is captured from the microphone and processed locally via Apple Speech framework.
    /// The `liveTranscript` property updates in real-time as speech is recognized.
    func startTranscription() async throws {
        guard state != .transcribing else { return }

        // Verify permissions
        let hasPermission = await requestPermissions()
        guard hasPermission else { return }

        // Configure speech recognizer
        let locale: Locale
        if selectedLanguage.isEmpty {
            locale = Locale.current
        } else {
            locale = Locale(identifier: selectedLanguage)
        }

        guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
            state = .error(NSLocalizedString("transcription_speech_recognition_unavailable", comment: ""))
            return
        }

        // Require on-device recognition for privacy
        if #available(iOS 13, *) {
            recognizer.supportsOnDeviceRecognition = true
        }

        speechRecognizer = recognizer
        liveTranscript = ""
        finalTranscript = ""

        // Create recognition request configured for on-device only
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true

        if #available(iOS 13, *) {
            request.requiresOnDeviceRecognition = true
        }

        recognitionRequest = request

        // Configure audio session
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
        try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

        // Set up audio engine
        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat, block: Self.tapFeeding(request))

        engine.prepare()
        try engine.start()
        audioEngine = engine

        // Start recognition task. The handler runs on a Speech framework queue, never on
        // main: `@Sendable` keeps it out of this class's main-actor isolation, and it hops to
        // the main actor before touching any state.
        recognitionTask = recognizer.recognitionTask(with: request) { @Sendable [weak self] result, error in
            guard let self else { return }

            if let result {
                Task { @MainActor in
                    self.liveTranscript = result.bestTranscription.formattedString

                    if result.isFinal {
                        self.finalTranscript = result.bestTranscription.formattedString
                        self.stopTranscriptionInternal()
                    }
                }
            }

            if let error {
                // Ignore cancellation errors (expected when stopping)
                let nsError = error as NSError
                if nsError.domain == "kAFAssistantErrorDomain" && nsError.code == 216 {
                    // "kAFAssistantErrorDomain error 216" = request was canceled
                    return
                }

                Task { @MainActor in
                    self.state = .error(error.localizedDescription)
                    self.stopTranscriptionInternal()
                }
            }
        }

        state = .transcribing
    }

    /// The audio tap block runs on AVAudioEngine's realtime render thread. Built in a
    /// nonisolated function so it does not inherit this class's main-actor isolation; it
    /// feeds the request it was given rather than reading `recognitionRequest`, which
    /// `stopTranscriptionInternal()` clears on main.
    private nonisolated static func tapFeeding(_ request: SFSpeechAudioBufferRecognitionRequest) -> AVAudioNodeTapBlock {
        { buffer, _ in request.append(buffer) }
    }

    // MARK: - Stop Transcription

    /// Stop transcription and finalize the transcript.
    /// Returns the final transcript text.
    @discardableResult
    func stopTranscription() -> String {
        stopTranscriptionInternal()

        if finalTranscript.isEmpty {
            finalTranscript = liveTranscript
        }

        return finalTranscript
    }

    /// Reset the service to idle state, clearing all transcript data.
    func reset() {
        stopTranscriptionInternal()
        liveTranscript = ""
        finalTranscript = ""
        state = .idle
    }

    // MARK: - Private Helpers

    private func stopTranscriptionInternal() {
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine = nil

        recognitionRequest?.endAudio()
        recognitionRequest = nil

        recognitionTask?.cancel()
        recognitionTask = nil

        if state == .transcribing {
            state = .stopped
        }

        // Deactivate audio session
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
