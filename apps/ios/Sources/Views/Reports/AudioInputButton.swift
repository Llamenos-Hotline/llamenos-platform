import AVFoundation
import Speech
import SwiftUI

// MARK: - AudioInputButton

/// Mic button that uses iOS Speech framework (`SFSpeechRecognizer`) for real-time
/// speech-to-text transcription. Appends transcribed text to a bound string.
///
/// Requires:
/// - `NSSpeechRecognitionUsageDescription` in Info.plist
/// - `NSMicrophoneUsageDescription` in Info.plist
///
/// Falls back gracefully if permissions are denied or speech recognition is unavailable.
struct AudioInputButton: View {
    /// Binding to the text field that receives transcribed audio.
    @Binding var text: String

    @State private var speechService = SpeechInputService()

    var body: some View {
        @Bindable var service = speechService

        Button {
            if speechService.isRecording {
                speechService.stopRecording()
            } else {
                Task {
                    await speechService.startRecording(appendTo: $text)
                }
            }
        } label: {
            Image(systemName: speechService.isRecording ? "mic.fill" : "mic")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(speechService.isRecording ? .white : Color.brandPrimary)
                .frame(width: 36, height: 36)
                .background(
                    Circle()
                        .fill(speechService.isRecording ? Color.brandDestructive : Color.brandPrimary.opacity(0.12))
                )
                .animation(.easeInOut(duration: 0.2), value: speechService.isRecording)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            speechService.isRecording
                ? NSLocalizedString("audio_input_stop", comment: "Stop recording")
                : NSLocalizedString("audio_input_start", comment: "Start voice input")
        )
        .accessibilityIdentifier("audio-input-button")
        .alert(
            NSLocalizedString("audio_input_permission_title", comment: "Speech Recognition"),
            isPresented: $service.showPermissionAlert
        ) {
            Button(NSLocalizedString("ok", comment: "OK")) {}
        } message: {
            Text(speechService.permissionMessage)
        }
    }
}

// MARK: - SpeechInputService

/// Manages the speech recognition session lifecycle. Handles permission requests,
/// audio session setup, and real-time transcription via `SFSpeechRecognizer`.
///
/// `@MainActor` (#1920 audit): SwiftUI reads this `@Observable` state on the main thread.
/// Every write already happened there — `startRecording` carried a method-level
/// `@MainActor` and the framework callbacks hop before touching state — but nothing stopped
/// a new call site from calling `stopRecording()` off main. Class-level isolation makes the
/// compiler enforce what was previously only convention.
@MainActor
@Observable
final class SpeechInputService {
    private let speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let audioEngine = AVAudioEngine()

    /// Whether speech recognition is currently active.
    var isRecording: Bool = false

    /// Whether to show the permission denied alert.
    var showPermissionAlert: Bool = false

    /// Message for the permission alert.
    var permissionMessage: String = ""

    /// Text binding to append transcription results to.
    private var textBinding: Binding<String>?

    /// Text captured before this recording session started (to avoid overwriting).
    private var preRecordingText: String = ""

    init() {
        self.speechRecognizer = SFSpeechRecognizer(locale: Locale.current)
    }

    // MARK: - Start Recording

    /// Request permissions and begin live transcription, appending to the bound text.
    func startRecording(appendTo binding: Binding<String>) async {
        textBinding = binding

        // Check speech recognition authorization
        let speechStatus = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }

        guard speechStatus == .authorized else {
            permissionMessage = NSLocalizedString(
                "audio_input_speech_denied",
                comment: "Speech recognition permission is required for voice input. Enable it in Settings > Privacy > Speech Recognition."
            )
            showPermissionAlert = true
            return
        }

        // Check microphone permission
        let micStatus: Bool
        if #available(iOS 17, *) {
            micStatus = await AVAudioApplication.requestRecordPermission()
        } else {
            micStatus = await withCheckedContinuation { continuation in
                AVAudioSession.sharedInstance().requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
        }

        guard micStatus else {
            permissionMessage = NSLocalizedString(
                "audio_input_mic_denied",
                comment: "Microphone access is required for voice input. Enable it in Settings > Privacy > Microphone."
            )
            showPermissionAlert = true
            return
        }

        guard let speechRecognizer, speechRecognizer.isAvailable else {
            permissionMessage = NSLocalizedString(
                "audio_input_unavailable",
                comment: "Speech recognition is not available on this device."
            )
            showPermissionAlert = true
            return
        }

        // Cancel any existing task
        stopRecording()

        // Store current text so we append after it
        preRecordingText = binding.wrappedValue

        do {
            try beginRecognitionSession(speechRecognizer: speechRecognizer)
        } catch {
            permissionMessage = error.localizedDescription
            showPermissionAlert = true
        }
    }

    // MARK: - Stop Recording

    /// Stop the current recognition session and clean up audio resources.
    func stopRecording() {
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionRequest = nil
        recognitionTask = nil
        isRecording = false

        // Deactivate audio session
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: - Private

    /// The audio tap block runs on AVAudioEngine's realtime render thread. Built in a
    /// nonisolated function so it does not inherit this class's main-actor isolation — it
    /// touches nothing but the request it feeds.
    private nonisolated static func tapFeeding(_ request: SFSpeechAudioBufferRecognitionRequest) -> AVAudioNodeTapBlock {
        { buffer, _ in request.append(buffer) }
    }

    private func beginRecognitionSession(speechRecognizer: SFSpeechRecognizer) throws {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true

        // Use on-device recognition if available (privacy: audio never leaves device)
        if speechRecognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }

        self.recognitionRequest = request

        // Configure audio session
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
        try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat, block: Self.tapFeeding(request))

        audioEngine.prepare()
        try audioEngine.start()

        isRecording = true

        // Start recognition task. The handler runs on a Speech framework queue, never on
        // main: `@Sendable` keeps it out of this class's main-actor isolation, and it hops to
        // the main actor before touching any state.
        recognitionTask = speechRecognizer.recognitionTask(with: request) { @Sendable [weak self] result, error in
            guard let self else { return }

            if let result {
                let transcription = result.bestTranscription.formattedString
                Task { @MainActor in
                    // Append transcription after pre-existing text
                    if self.preRecordingText.isEmpty {
                        self.textBinding?.wrappedValue = transcription
                    } else {
                        self.textBinding?.wrappedValue = self.preRecordingText + " " + transcription
                    }
                }
            }

            if error != nil || (result?.isFinal ?? false) {
                Task { @MainActor in
                    self.stopRecording()
                }
            }
        }
    }
}

// MARK: - Preview

#if DEBUG
struct AudioInputPreview: View {
    @State private var text = ""
    var body: some View {
        VStack(spacing: 16) {
            TextEditor(text: $text)
                .frame(height: 100)
                .border(Color.gray)
            AudioInputButton(text: $text)
        }
        .padding()
    }
}

#Preview("Audio Input") {
    AudioInputPreview()
}
#endif
