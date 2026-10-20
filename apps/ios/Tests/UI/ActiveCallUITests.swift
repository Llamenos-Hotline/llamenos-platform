import XCTest

/// XCUITest suite for in-call actions on the dashboard.
/// Tests the active call card, hangup, ban dialog, and quick note buttons.
///
/// Every test puts a real call on the real backend, answered by the identity the app is
/// running as, so the call card is the product of server state — not of whatever the
/// dashboard happens to render. The actions are then asserted by what they did to that
/// server state (the call ended, the caller is banned, the call is flagged as spam), not
/// by whether a button was on screen.
///
/// Maps to BDD scenarios: active-call-panel, hangup, ban-with-reason.
final class ActiveCallUITests: BaseUITest {

    // MARK: - Helpers

    /// The dashboard presents the first active call its hub holds, whoever answered it, and
    /// a call stays active until it is ended or goes stale — so a call left over from one
    /// test would be the card the next test sees. Each test therefore gets a hub of its own
    /// (see #2027 for the dashboard half of that).
    private var callHubId = ""

    private func launchOnFreshHub() {
        guard let hubId = TestAdminAPI.createHub(name: "active-call-\(UUID().uuidString.prefix(8))", baseURL: testHubURL) else {
            return // createHub already failed the test with the server's answer
        }
        callHubId = hubId
        launchAsAdminWithAPI(hubId: hubId)
    }

    /// A call row as the server reports it.
    private struct ServerCall {
        let id: String
        let status: String
        let answeredBy: String?
    }

    /// The calls the server holds as active for this class's hub, read through the real
    /// authenticated API — the same route the dashboard polls.
    private func serverActiveCalls() -> [ServerCall] {
        guard let data = TestAdminAPI.send("GET", "/api/hubs/\(callHubId)/calls/active", baseURL: testHubURL),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let calls = json["calls"] as? [[String: Any]] else {
            XCTFail("GET /api/hubs/\(callHubId)/calls/active did not return { calls: [...] }")
            return []
        }
        return calls.compactMap { row in
            guard let id = row["id"] as? String else { return nil }
            return ServerCall(id: id, status: row["status"] as? String ?? "", answeredBy: row["answeredBy"] as? String)
        }
    }

    /// The signing pubkey the app is running as — the identity a call must be answered by
    /// for the app's call actions to be authorised (`answeredBy` is checked server-side).
    private func appIdentityPubkey() -> String {
        let identity = find("dashboard-identity")
        XCTAssertTrue(identity.waitForExistence(timeout: 15), "The dashboard should expose the signed-in identity")
        let pubkey = identity.label
        XCTAssertEqual(pubkey.count, 64, "The dashboard identity should be a 32-byte hex pubkey, got '\(pubkey)'")
        return pubkey
    }

    /// Put a call on this class's hub and answer it as the app's own identity.
    /// Fails the test unless the server reports the call as in progress, answered by the app.
    private func answerCallAsApp(callerNumber: String) -> String {
        let pubkey = appIdentityPubkey()
        let call = simulateIncomingCall(callerNumber: callerNumber, hubId: callHubId)
        XCTAssertFalse(call.callId.isEmpty, "The simulated incoming call should be created (status '\(call.status)')")
        XCTAssertEqual(call.status, "ringing", "A new call should be ringing")
        let answered = simulateAnswerCall(callId: call.callId, pubkey: pubkey)
        XCTAssertEqual(answered, "in-progress", "The call should be in progress once the app's identity answers it")
        let held = serverActiveCalls().first { $0.id == call.callId }
        XCTAssertEqual(held?.answeredBy, pubkey, "The server should record the app's identity as the call's answerer")
        return call.callId
    }

    /// Wait for the call card to leave the screen.
    private func waitForCardToClear(timeout: TimeInterval = 15) -> Bool {
        let gone = NSPredicate(format: "exists == false")
        let expectation = XCTNSPredicateExpectation(predicate: gone, object: find("active-call-card"))
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }

    private func tapOnceHittable(_ identifier: String, timeout: TimeInterval = 15) {
        let element = find(identifier)
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "\(identifier) should be on the call card")
        XCTAssertTrue(element.isHittable, "\(identifier) should be tappable")
        element.tap()
    }

    // MARK: - Scenario: Active call card visible when call exists

    /// The call card is the product of a call being answered: absent before, present after,
    /// and it names the caller. Passing without a call is impossible — nothing but the card
    /// is accepted.
    func testActiveCallPanelVisible() {
        var callId = ""
        given("I am authenticated as admin with API and no call is in progress") {
            launchOnFreshHub()
            XCTAssertTrue(find("dashboard-identity").waitForExistence(timeout: 15))
            XCTAssertFalse(find("active-call-card").exists, "No call card should show before a call exists")
        }
        when("a call from +15551110001 is answered by my identity") {
            callId = answerCallAsApp(callerNumber: "+15551110001")
        }
        then("the active call card should show the caller on the dashboard") {
            XCTAssertTrue(
                find("active-call-card").waitForExistence(timeout: 20),
                "The dashboard should show the active call card for call \(callId)"
            )
            XCTAssertTrue(
                app.staticTexts["0001"].waitForExistence(timeout: 5),
                "The card should identify the caller by the last four digits (0001)"
            )
            XCTAssertTrue(
                find("call-elapsed-timer").exists,
                "The card should run an elapsed timer for an in-progress call"
            )
        }
    }

    // MARK: - Scenario: Hangup button ends the call

    /// Tapping hang up ends the call on the server and clears the card.
    func testHangupButtonEndsCall() {
        var callId = ""
        given("I am authenticated as admin with API and I am on a call") {
            launchOnFreshHub()
            callId = answerCallAsApp(callerNumber: "+15551110002")
            XCTAssertTrue(find("active-call-card").waitForExistence(timeout: 20))
        }
        when("I tap hang up") {
            tapOnceHittable("hangup-button")
        }
        then("the card clears and the server no longer holds the call") {
            XCTAssertTrue(waitForCardToClear(), "The call card should clear after hanging up")
            XCTAssertFalse(
                serverActiveCalls().contains { $0.id == callId },
                "The server should have ended call \(callId)"
            )
        }
    }

    // MARK: - Scenario: Ban + hangup button shows reason field

    /// Ban + hang up takes a reason, bans the caller on the server, and ends the call.
    /// The proof the ban landed is the one a caller would meet: the same number can no
    /// longer ring in.
    func testBanDialogShowsReasonField() {
        let number = "+15551110003"
        var callId = ""
        given("I am authenticated as admin with API and I am on a call") {
            launchOnFreshHub()
            callId = answerCallAsApp(callerNumber: number)
            XCTAssertTrue(find("active-call-card").waitForExistence(timeout: 20))
        }
        when("I open ban + hang up, give a reason and confirm") {
            tapOnceHittable("ban-hangup-button")
            let reason = find("ban-reason-input")
            XCTAssertTrue(reason.waitForExistence(timeout: 10), "The ban dialog should ask for a reason")
            reason.tap()
            reason.typeText("Harassing caller")
            tapOnceHittable("ban-confirm-button")
        }
        then("the call ends and the caller is banned") {
            XCTAssertTrue(waitForCardToClear(), "The call card should clear after ban + hang up")
            XCTAssertFalse(
                serverActiveCalls().contains { $0.id == callId },
                "The server should have ended call \(callId)"
            )
            let retry = simulateIncomingCall(callerNumber: number, hubId: callHubId)
            XCTAssertTrue(
                retry.callId.isEmpty,
                "A banned caller must not be able to ring in again (got call \(retry.callId))"
            )
        }
    }

    /// Cancelling the ban dialog bans nobody and leaves the call running.
    func testCancellingBanDialogKeepsCallAndCaller() {
        let number = "+15551110006"
        var callId = ""
        given("I am authenticated as admin with API and I am on a call") {
            launchOnFreshHub()
            callId = answerCallAsApp(callerNumber: number)
            XCTAssertTrue(find("active-call-card").waitForExistence(timeout: 20))
        }
        when("I open ban + hang up and cancel") {
            tapOnceHittable("ban-hangup-button")
            XCTAssertTrue(find("ban-reason-input").waitForExistence(timeout: 10))
            app.buttons["Cancel"].tap()
        }
        then("the call is still running and the caller is not banned") {
            XCTAssertTrue(find("active-call-card").waitForExistence(timeout: 10), "The call should still be on screen")
            XCTAssertTrue(
                serverActiveCalls().contains { $0.id == callId && $0.status == "in-progress" },
                "The server should still hold call \(callId) in progress"
            )
            // A second call from the same number is the proof the caller was not banned.
            let second = simulateIncomingCall(callerNumber: number, hubId: callHubId)
            XCTAssertFalse(second.callId.isEmpty, "A caller whose ban was cancelled must still be able to ring in")
        }
    }

    // MARK: - Scenario: Quick note button visible during active call

    /// The quick note button is on the call card and tapping it must start a note for the
    /// call. The dashboard wires the button to an empty closure
    /// (`DashboardView.onQuickNote`), so the tap does nothing — the assertion that it opens
    /// note creation cannot be met until that is built.
    func testQuickNoteButtonVisibleDuringCall() throws {
        throw XCTSkip("The dashboard's onQuickNote closure is empty — tapping Add Note during a call does nothing (#2026)")
    }

    // MARK: - Scenario: Report spam button visible during active call

    /// Reporting spam flags the call as spam on the server.
    ///
    /// Skipped while #2028 stands: a spam-flagged call makes `GET /calls/active` answer 500,
    /// so the server state this test reads back cannot be read at all. Delete the
    /// `XCTSkipIf` line when #2028 is fixed — the assertions below are the ones to keep.
    func testReportSpamButtonVisible() throws {
        try XCTSkipIf(true, "Reporting spam makes GET /calls/active 500 for the whole hub (#2028)")
        var callId = ""
        given("I am authenticated as admin with API and I am on a call") {
            launchOnFreshHub()
            callId = answerCallAsApp(callerNumber: "+15551110005")
            XCTAssertTrue(find("active-call-card").waitForExistence(timeout: 20))
        }
        when("I tap report spam") {
            tapOnceHittable("report-spam-button")
        }
        then("the server flags the call as spam") {
            let deadline = Date().addingTimeInterval(15)
            var flagged: ServerCall?
            while Date() < deadline {
                flagged = serverActiveCalls().first { $0.id == callId }
                if flagged?.status == "spam" { break }
                // Wait on an expectation, not a sleep: the report is a network round trip.
                let tick = XCTestExpectation(description: "report spam settles")
                tick.isInverted = true
                _ = XCTWaiter().wait(for: [tick], timeout: 1)
            }
            XCTAssertEqual(flagged?.status, "spam", "The server should flag call \(callId) as spam")
        }
    }
}
