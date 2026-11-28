import Foundation
import Speech

// MARK: - OnDeviceSpeech

/// The one place a speech-recognition request may be constructed (#2951).
///
/// `SFSpeechRecognizer` silently routes audio to Apple's servers whenever a request does not
/// set `requiresOnDeviceRecognition`, and on-device support varies by locale — the hotline
/// ships many locales, so "set it when supported" is a leak for exactly the languages that
/// lack a local model. Callers and volunteers speak crisis content into these paths.
///
/// This type fails closed: if the recognizer has no on-device model there is no request, and
/// the feature reports `OnDeviceSpeechError.onDeviceUnavailable` instead of degrading to the
/// server. Both `SpeechInputService` (report dictation) and `TranscriptionService` (call
/// transcription) construct requests only through `makeRequest`, and `OnDeviceSpeechTests`
/// fails the build if any other source file constructs one.
enum OnDeviceSpeech {
    /// Why a recognition session could not be started.
    enum OnDeviceSpeechError: Error, Equatable {
        /// The recognizer has no on-device model for its locale. Recognition would have
        /// required Apple's servers, so it is refused.
        case onDeviceUnavailable
    }

    /// Build a recognition request that can only ever run on the device.
    ///
    /// - Parameter supportsOnDeviceRecognition: `SFSpeechRecognizer.supportsOnDeviceRecognition`
    ///   for the recognizer the request will be handed to.
    /// - Throws: `OnDeviceSpeechError.onDeviceUnavailable` when the locale has no on-device
    ///   model. A request is never returned that is permitted to use the server.
    static func makeRequest(supportsOnDeviceRecognition: Bool) throws -> SFSpeechAudioBufferRecognitionRequest {
        guard supportsOnDeviceRecognition else { throw OnDeviceSpeechError.onDeviceUnavailable }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        return request
    }

    /// Build an on-device-only request for `recognizer`, refusing a recognizer that has no
    /// local model for its locale.
    static func makeRequest(for recognizer: SFSpeechRecognizer) throws -> SFSpeechAudioBufferRecognitionRequest {
        try makeRequest(supportsOnDeviceRecognition: recognizer.supportsOnDeviceRecognition)
    }

    /// Whether `locale` can be recognised on this device without the network.
    /// Drives the dictation button's availability so the user is told why before tapping.
    static func isAvailable(for locale: Locale) -> Bool {
        guard let recognizer = SFSpeechRecognizer(locale: locale) else { return false }
        return recognizer.supportsOnDeviceRecognition
    }
}
