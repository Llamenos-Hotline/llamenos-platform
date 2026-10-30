import XCTest
import Foundation
import UserNotifications
@testable import Llamenos

// MARK: - PushRoutingTests
//
// Verifies the multi-hub push routing axiom:
//   Background APNs push must NEVER call setActiveHub.
//   Only the user-initiated tap handler (userNotificationCenter(_:didReceive:)) may
//   switch UI browsing context. Background push routes incoming_call pushes to
//   LinphoneService.handleVoipPush(callId:hubId:) so the call→hub mapping is
//   available when onCallStateChanged fires.
//
// The payloadDecryptorForTesting hook on AppDelegate bypasses real HPKE crypto,
// allowing pure logic tests without a wake keypair.

/// `@MainActor`: drives `AppState` and `AppDelegate`, both main-actor isolated (#1920 audit).
@MainActor
final class PushRoutingTests: XCTestCase {

    private var hubContext: HubContext!
    private var linphoneService: LinphoneService!
    private var appState: AppState!
    private var appDelegate: AppDelegate!

    override func setUp() {
        super.setUp()
        // Ensure UserDefaults doesn't bleed hub-A across tests
        UserDefaults.standard.removeObject(forKey: "activeHubId")

        hubContext = HubContext()
        hubContext.setActiveHub("hub-A")

        // AppState creates its own LinphoneService internally; we replace it via the
        // testing-only setter added to AppState.
        appState = AppState(hubContext: hubContext)
        linphoneService = appState.linphoneService

        appDelegate = AppDelegate()
        appDelegate.appState = appState
        // Inject a fake decryptor so tests don't need a real wake keypair.
        appDelegate.payloadDecryptorForTesting = { encryptedHex in
            // The sentinel format is: "json:<jsonString>"
            guard encryptedHex.hasPrefix("json:") else {
                throw NSError(domain: "PushRoutingTests", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "Unexpected sentinel format"])
            }
            return String(encryptedHex.dropFirst(5))
        }
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: "activeHubId")
        super.tearDown()
    }

    // MARK: - Helpers

    /// Build a userInfo dict with an "encrypted" key whose value is a fake sentinel
    /// that payloadDecryptorForTesting will decode into the given JSON.
    private func makeUserInfo(
        type: String,
        callId: String,
        hubId: String,
        title: String = "Incoming Call",
        body: String = "A caller needs assistance"
    ) throws -> [AnyHashable: Any] {
        let payloadDict: [String: String] = [
            "type": type,
            "callId": callId,
            "hubId": hubId,
            "title": title,
            "body": body,
        ]
        let jsonData = try XCTUnwrap(try? JSONSerialization.data(withJSONObject: payloadDict))
        let jsonString = try XCTUnwrap(String(data: jsonData, encoding: .utf8))
        return ["encrypted": "json:\(jsonString)"]
    }

    // MARK: - Test 1: Background push must NOT switch active hub

    /// Background push for Hub B must not switch the active hub away from Hub A.
    /// Multi-hub axiom: background handlers are never allowed to change UI context.
    func testBackgroundPushForHubBDoesNotSwitchActiveHubFromHubA() throws {
        let userInfo = try makeUserInfo(type: "incoming_call", callId: "call-001", hubId: "hub-B")
        let expectation = XCTestExpectation(description: "completionHandler called")

        appDelegate.application(
            UIApplication.shared,
            didReceiveRemoteNotification: userInfo
        ) { _ in expectation.fulfill() }

        wait(for: [expectation], timeout: 5)

        XCTAssertEqual(
            hubContext.activeHubId, "hub-A",
            "Background push must NOT switch the active hub (multi-hub routing axiom)"
        )
    }

    // MARK: - Test 2: incoming_call push routes to LinphoneService

    /// Background push with type "incoming_call" must register the call→hub mapping
    /// in LinphoneService so it is available when onCallStateChanged fires.
    func testBackgroundPushIncomingCallRoutesToLinphoneService() throws {
        let callId = "call-test-\(UUID().uuidString)"
        let userInfo = try makeUserInfo(type: "incoming_call", callId: callId, hubId: "hub-B")
        let expectation = XCTestExpectation(description: "completionHandler called")

        appDelegate.application(
            UIApplication.shared,
            didReceiveRemoteNotification: userInfo
        ) { _ in expectation.fulfill() }

        wait(for: [expectation], timeout: 5)

        XCTAssertEqual(
            linphoneService.pendingCallHubIdForTesting(callId), "hub-B",
            "incoming_call push must register call→hub mapping in LinphoneService"
        )
    }

    // MARK: - Test 3: Non-call push does NOT register call→hub mapping

    /// A push with type other than "incoming_call" must not register anything in LinphoneService.
    func testBackgroundPushNonCallTypeDoesNotRegisterLinphoneMapping() throws {
        let callId = "call-other-\(UUID().uuidString)"
        let userInfo = try makeUserInfo(type: "new_message", callId: callId, hubId: "hub-B")
        let expectation = XCTestExpectation(description: "completionHandler called")

        appDelegate.application(
            UIApplication.shared,
            didReceiveRemoteNotification: userInfo
        ) { _ in expectation.fulfill() }

        wait(for: [expectation], timeout: 5)

        XCTAssertNil(
            linphoneService.pendingCallHubIdForTesting(callId),
            "Non-call push must not register a call→hub mapping in LinphoneService"
        )
    }

    // MARK: - Test 4: Tap handler MUST switch active hub

    /// The user-initiated tap handler (userNotificationCenter(_:didReceive:)) must still
    /// call setActiveHub — it is the correct path for UI context switching.
    func testTapHandlerDoesSetActiveHub() throws {
        XCTAssertEqual(hubContext.activeHubId, "hub-A", "Precondition: active hub is A")
        appDelegate.handleNotificationResponse(userInfo: ["hubId": "hub-B"])
        XCTAssertEqual(hubContext.activeHubId, "hub-B",
                       "Notification tap handler must switch active hub via handleNotificationResponse")
    }

    // MARK: - Test 5: Active hub unchanged for push without hubId

    /// A push payload without a hubId field must not affect the active hub.
    func testBackgroundPushWithoutHubIdLeavesActiveHubUnchanged() throws {
        let payloadDict: [String: String] = ["type": "incoming_call", "callId": "call-nohub"]
        let jsonData = try XCTUnwrap(try? JSONSerialization.data(withJSONObject: payloadDict))
        let jsonString = try XCTUnwrap(String(data: jsonData, encoding: .utf8))
        let userInfo: [AnyHashable: Any] = ["encrypted": "json:\(jsonString)"]
        let expectation = XCTestExpectation(description: "completionHandler called")

        appDelegate.application(
            UIApplication.shared,
            didReceiveRemoteNotification: userInfo
        ) { _ in expectation.fulfill() }

        wait(for: [expectation], timeout: 5)

        XCTAssertEqual(
            hubContext.activeHubId, "hub-A",
            "Push without hubId must not modify active hub"
        )
    }

    // MARK: - Incident push (B-INCIDENTS)

    /// The content-free incident push names its hub for routing only. Receiving it must not
    /// switch the active hub, and must not present anything without a tap.
    func testIncidentPushDoesNotSwitchActiveHub() throws {
        let payloadDict: [String: String] = ["type": "incident", "hubId": "hub-B"]
        let jsonData = try XCTUnwrap(try? JSONSerialization.data(withJSONObject: payloadDict))
        let jsonString = try XCTUnwrap(String(data: jsonData, encoding: .utf8))
        let expectation = XCTestExpectation(description: "completionHandler called")

        appDelegate.application(
            UIApplication.shared,
            didReceiveRemoteNotification: ["encrypted": "json:\(jsonString)"]
        ) { _ in expectation.fulfill() }

        wait(for: [expectation], timeout: 5)

        XCTAssertEqual(hubContext.activeHubId, "hub-A", "An incident push must not switch the active hub")
        XCTAssertFalse(appState.incidentService.isIncidentViewPresented,
                       "Receiving the push presents nothing; only the user's tap opens the view")
    }

    /// Tapping the incident push opens the incident view — which lists every member hub —
    /// and switches no hub, even if a hubId were present.
    func testIncidentPushTapOpensIncidentViewWithoutSwitchingHub() {
        appDelegate.handleNotificationResponse(userInfo: ["deepLinkType": "incident", "hubId": "hub-B"])

        XCTAssertTrue(appState.incidentService.isIncidentViewPresented)
        XCTAssertEqual(hubContext.activeHubId, "hub-A")
    }
}
