import Foundation
import Speech
import XCTest
@testable import Llamenos

/// #2951 — speech recognition must fail closed: a locale with no on-device model produces no
/// request at all, and no code path can construct a request that is allowed to use Apple's
/// servers.
final class OnDeviceSpeechTests: XCTestCase {
    func testRequestRequiresOnDeviceRecognition() throws {
        let request = try OnDeviceSpeech.makeRequest(supportsOnDeviceRecognition: true)
        XCTAssertTrue(
            request.requiresOnDeviceRecognition,
            "A request that may use the server sends crisis audio to Apple"
        )
    }

    func testNoRequestIsBuiltWhenLocaleHasNoOnDeviceModel() {
        XCTAssertThrowsError(try OnDeviceSpeech.makeRequest(supportsOnDeviceRecognition: false)) { error in
            XCTAssertEqual(error as? OnDeviceSpeech.OnDeviceSpeechError, .onDeviceUnavailable)
        }
    }

    /// A recognizer for a locale the framework does not support has no on-device model, so the
    /// policy must refuse it rather than quietly accept the server path.
    func testUnsupportedLocaleIsNotAvailable() {
        XCTAssertFalse(OnDeviceSpeech.isAvailable(for: Locale(identifier: "zz-ZZ")))
    }

    /// Structural guard: every `SFSpeechAudioBufferRecognitionRequest` (and URL/file request)
    /// must be constructed in `OnDeviceSpeech.swift`, the single place that sets
    /// `requiresOnDeviceRecognition`. A second construction site is a cloud-recognition path.
    func testOnlyOnDeviceSpeechConstructsRecognitionRequests() throws {
        let sources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // Unit
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // apps/ios
            .appendingPathComponent("Sources")
        let enumerator = try XCTUnwrap(
            FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil),
            "Sources directory not found at \(sources.path)"
        )
        var scanned = 0
        var offenders: [String] = []
        let constructors = [
            "SFSpeechAudioBufferRecognitionRequest(",
            "SFSpeechURLRecognitionRequest(",
        ]
        for case let url as URL in enumerator where url.pathExtension == "swift" {
            scanned += 1
            guard url.lastPathComponent != "OnDeviceSpeech.swift" else { continue }
            let text = try String(contentsOf: url, encoding: .utf8)
            if constructors.contains(where: text.contains) { offenders.append(url.lastPathComponent) }
            XCTAssertFalse(
                text.contains("requiresOnDeviceRecognition = false"),
                "\(url.lastPathComponent) opts a request into server recognition"
            )
        }
        XCTAssertGreaterThan(scanned, 50, "Guard scanned too few files to mean anything")
        XCTAssertEqual(offenders, [], "Recognition requests must be built via OnDeviceSpeech.makeRequest")
    }
}
