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

    /// This test's hub (see `launchAsAdminOnFreshHub`).
    private var callHubId = ""

    private func launchOnFreshHub() {
        callHubId = launchAsAdminOnFreshHub(named: "active-call") ?? ""
    }

    private func answerCall(from callerNumber: String) -> String {
        answerCallAsApp(callerNumber: callerNumber, hubId: callHubId)
    }

    private func tapOnceHittable(_ identifier: String, timeout: TimeInterval = 15) {
        let element = find(identifier)
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "\(identifier) should be on the call card")
        XCTAssertTrue(element.isHittable, "\(identifier) should be tappable")
        element.tap()
    }

    // MARK: - Scenario: Active call card visible when call exists

    /// The call card is the product of a call being answered: absent before, present after,
    /// and it does NOT name the caller — the volunteer who answers is not shown who is
    /// calling (A17). Passing without a call is impossible — nothing but the card is accepted.
    func testActiveCallPanelVisible() {
        var callId = ""
        given("I am authenticated as admin with API and no call is in progress") {
            launchOnFreshHub()
            XCTAssertTrue(find("dashboard-identity").waitForExistence(timeout: 15))
            XCTAssertFalse(find("active-call-card").exists, "No call card should show before a call exists")
        }
        when("a call from +15551110001 is answered by my identity") {
            callId = answerCall(from: "+15551110001")
        }
        then("the active call card should be on the dashboard without the caller's number") {
            XCTAssertTrue(
                find("active-call-card").waitForExistence(timeout: 20),
                "The dashboard should show the active call card for call \(callId)"
            )
            XCTAssertFalse(
                app.staticTexts["0001"].exists,
                "The card must not show any of the caller's digits to the answering volunteer"
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
            callId = answerCall(from: "+15551110002")
            XCTAssertTrue(find("active-call-card").waitForExistence(timeout: 20))
        }
        when("I tap hang up") {
            tapOnceHittable("hangup-button")
        }
        then("the card clears and the server no longer holds the call") {
            XCTAssertTrue(waitForCallCardToClear(), "The call card should clear after hanging up")
            XCTAssertFalse(
                serverActiveCalls(hubId: callHubId).contains { $0.id == callId },
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
            callId = answerCall(from: number)
            XCTAssertTrue(find("active-call-card").waitForExistence(timeout: 20))
        }
        when("I open ban + hang up, give a reason and confirm") {
            tapOnceHittable("ban-hangup-button")
            let reason = find("ban-reason-input")
            XCTAssertTrue(reason.waitForExistence(timeout: 10), "The ban dialog should ask for a reason")
            typeText("Harassing caller", into: reason)
            tapOnceHittable("ban-confirm-button")
        }
        then("the call ends and the caller is banned") {
            XCTAssertTrue(waitForCallCardToClear(), "The call card should clear after ban + hang up")
            XCTAssertFalse(
                serverActiveCalls(hubId: callHubId).contains { $0.id == callId },
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
            callId = answerCall(from: number)
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
                serverActiveCalls(hubId: callHubId).contains { $0.id == callId && $0.status == "in-progress" },
                "The server should still hold call \(callId) in progress"
            )
            // A second call from the same number is the proof the caller was not banned.
            let second = simulateIncomingCall(callerNumber: number, hubId: callHubId)
            XCTAssertFalse(second.callId.isEmpty, "A caller whose ban was cancelled must still be able to ring in")
        }
    }

    // MARK: - Scenario: Add Note on the call card files a note for that call

    /// Add Note opens the editor with this call already chosen, and the saved note carries
    /// the call's id on the server.
    func testQuickNoteButtonFilesNoteForTheCall() {
        var callId = ""
        let noteText = "Quick note \(UUID().uuidString.prefix(8))"
        given("I am authenticated as admin with API and I am on a call") {
            launchOnFreshHub()
            callId = answerCall(from: "+15551110007")
            XCTAssertTrue(find("active-call-card").waitForExistence(timeout: 20))
        }
        when("I tap Add Note, write the note and save it") {
            tapOnceHittable("quick-note-button")
            let editor = find("note-text-editor")
            XCTAssertTrue(editor.waitForExistence(timeout: 10), "Add Note should open the note editor")
            XCTAssertTrue(
                find("note-call-choice-\(callId)").waitForExistence(timeout: 20),
                "The editor should offer this call"
            )
            typeText(noteText, into: editor)
            find("save-note").tap()
            XCTAssertTrue(editor.waitForNonExistence(timeout: 20), "The editor should close once the note is saved")
        }
        then("the server holds a note filed under this call") {
            XCTAssertFalse(find("note-create-error").exists)
            XCTAssertTrue(
                serverNoteCallIds(hubId: callHubId).contains(callId),
                "The saved note should carry call \(callId), without the volunteer ever typing it"
            )
        }
    }

    // MARK: - Scenario: a ring is a ring

    /// A call that is only ringing is not "my call": it renders as an incoming call with
    /// Answer (or "answer on your phone"), and offers none of Hang Up / Spam / Ban.
    func testRingRendersAsRingNotActiveCall() {
        given("I am authenticated as admin with API and no call is in progress") {
            launchOnFreshHub()
            XCTAssertTrue(find("dashboard-identity").waitForExistence(timeout: 15))
        }
        when("a call from +15551110008 rings") {
            _ = ringCall(callerNumber: "+15551110008", hubId: callHubId)
        }
        then("the dashboard shows an incoming call, not an active one, and not the caller's digits") {
            XCTAssertTrue(find("incoming-call-card").waitForExistence(timeout: 20), "A ring should render as a ring")
            XCTAssertTrue(
                anyElementExists(["answer-call-button", "answer-on-phone"], timeout: 5),
                "A ring should offer Answer, or say to answer on the phone"
            )
            XCTAssertFalse(find("active-call-card").exists, "A ring is not a call in progress")
            XCTAssertFalse(find("hangup-button").exists, "Hang Up belongs to a call this volunteer answered")
            XCTAssertFalse(find("ban-hangup-button").exists)
            XCTAssertFalse(app.staticTexts["0008"].exists, "A ring must not show the caller's digits")
        }
    }

    /// Answer goes to the server, and the screen reports what the server decided. This
    /// identity is not on a shift, so the server was not ringing it and refuses the answer
    /// (403 "Not rung for this call"): the volunteer is told, the call stays a ring, and it
    /// does not become "my call". (The 422 "answer on your phone" and the success path are
    /// pinned in `DashboardCallsTests`, which can script the server's answer.)
    func testAnswerRefusedByTheServerIsReportedAndTheRingStays() {
        var callId = ""
        given("a call is ringing on my hub and the server is not ringing me") {
            launchOnFreshHub()
            callId = ringCall(callerNumber: "+15551110009", hubId: callHubId)
            XCTAssertTrue(find("incoming-call-card").waitForExistence(timeout: 20))
        }
        when("I tap Answer") {
            tapOnceHittable("answer-call-button")
        }
        then("I am told it did not happen, and nothing was answered") {
            XCTAssertTrue(find("dashboard-error").waitForExistence(timeout: 20), "A refused answer should be reported")
            XCTAssertFalse(find("active-call-card").exists, "A refused answer does not make the ring my call")
            XCTAssertTrue(find("incoming-call-card").exists, "The call is still ringing")
            let held = serverActiveCalls(hubId: callHubId).first { $0.id == callId }
            XCTAssertNil(held?.answeredBy)
            XCTAssertEqual(held?.status, "ringing")
        }
    }

    // MARK: - Scenario: somebody else's call is not my call

    /// A call another volunteer answered is counted but never shown as this volunteer's call,
    /// so Hang Up / Spam / Ban (which the server would refuse with 403) are not offered.
    func testCallAnsweredBySomeoneElseShowsNoCallCard() {
        let someoneElse = String(repeating: "ab", count: 32)
        var callId = ""
        given("I am authenticated as admin with API and no call is in progress") {
            launchOnFreshHub()
            XCTAssertTrue(find("dashboard-identity").waitForExistence(timeout: 15))
            callId = ringCall(callerNumber: "+15551110010", hubId: callHubId)
            XCTAssertTrue(find("incoming-call-card").waitForExistence(timeout: 20))
        }
        when("another volunteer answers it") {
            XCTAssertEqual(simulateAnswerCall(callId: callId, pubkey: someoneElse), "in-progress")
        }
        then("the ring leaves my dashboard and no call card replaces it") {
            let gone = NSPredicate(format: "exists == false")
            let ringGone = XCTNSPredicateExpectation(predicate: gone, object: find("incoming-call-card"))
            XCTAssertEqual(XCTWaiter().wait(for: [ringGone], timeout: 20), .completed, "The ring should clear")
            XCTAssertFalse(find("active-call-card").exists, "Someone else's call is not my call")
            XCTAssertFalse(find("hangup-button").exists)
            XCTAssertEqual(
                serverActiveCalls(hubId: callHubId).first { $0.id == callId }?.answeredBy, someoneElse
            )
        }
    }

    // MARK: - Scenario: a call ends, the volunteer is asked for a note

    /// When this volunteer's own call ends the card becomes a "Call Ended" prompt; Add Note
    /// opens the editor on that call and the saved note carries its id. The prompt is gone
    /// once the note is saved.
    func testEndedCallPromptsForANote() {
        var callId = ""
        let noteText = "Ended-call note \(UUID().uuidString.prefix(8))"
        given("I am on a call") {
            launchOnFreshHub()
            callId = answerCall(from: "+15551110011")
            XCTAssertTrue(find("active-call-card").waitForExistence(timeout: 20))
        }
        when("the call ends") {
            XCTAssertEqual(simulateEndCall(callId: callId), "completed")
        }
        then("a Call Ended prompt replaces the call card") {
            XCTAssertTrue(find("ended-call-card").waitForExistence(timeout: 20), "The ended call should prompt for a note")
            XCTAssertTrue(waitForCallCardToClear(), "The in-call card should be gone")
        }
        when("I add a note from the prompt") {
            tapOnceHittable("ended-call-add-note")
            let editor = find("note-text-editor")
            XCTAssertTrue(editor.waitForExistence(timeout: 10))
            XCTAssertTrue(find("note-call-choice-\(callId)").waitForExistence(timeout: 20))
            typeText(noteText, into: editor)
            find("save-note").tap()
            XCTAssertTrue(editor.waitForNonExistence(timeout: 20))
        }
        then("the note is filed under the call and the prompt is gone") {
            XCTAssertTrue(serverNoteCallIds(hubId: callHubId).contains(callId))
            XCTAssertTrue(find("ended-call-card").waitForNonExistence(timeout: 10), "Saving the note finishes the prompt")
        }
    }

    /// Dismissing the prompt forgets the call; it does not come back.
    func testDismissingEndedCallPromptForgetsTheCall() {
        var callId = ""
        given("my call has ended and the prompt is showing") {
            launchOnFreshHub()
            callId = answerCall(from: "+15551110012")
            XCTAssertTrue(find("active-call-card").waitForExistence(timeout: 20))
            XCTAssertEqual(simulateEndCall(callId: callId), "completed")
            XCTAssertTrue(find("ended-call-card").waitForExistence(timeout: 20))
        }
        when("I dismiss it") {
            tapOnceHittable("ended-call-dismiss")
        }
        then("it is gone") {
            XCTAssertTrue(find("ended-call-card").waitForNonExistence(timeout: 10))
        }
    }

    // MARK: - Scenario: a history row opens a call with Add Note

    /// A holder of calls:read-history and notes:create opens a history row to a detail with
    /// Add Note, and the editor opens on that call.
    func testCallHistoryRowOpensDetailWithAddNote() {
        var callId = ""
        given("a call of mine has ended") {
            launchOnFreshHub()
            callId = answerCall(from: "+15551110013")
            XCTAssertTrue(find("active-call-card").waitForExistence(timeout: 20))
            XCTAssertEqual(simulateEndCall(callId: callId), "completed")
            XCTAssertTrue(find("ended-call-card").waitForExistence(timeout: 20))
            tapOnceHittable("ended-call-dismiss")
        }
        when("I open Call History and tap the call's row") {
            tapOnceHittable("dashboard-call-history-action")
            let row = find("call-history-link-\(callId)")
            XCTAssertTrue(row.waitForExistence(timeout: 20), "The ended call should be in the history")
            row.tap()
        }
        then("the detail offers Add Note, which opens the editor on that call") {
            XCTAssertTrue(find("call-detail-view").waitForExistence(timeout: 10))
            tapOnceHittable("call-detail-add-note")
            XCTAssertTrue(find("note-text-editor").waitForExistence(timeout: 10))
            XCTAssertTrue(find("note-call-choice-\(callId)").waitForExistence(timeout: 20))
        }
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
            callId = answerCall(from: "+15551110005")
            XCTAssertTrue(find("active-call-card").waitForExistence(timeout: 20))
        }
        when("I tap report spam") {
            tapOnceHittable("report-spam-button")
        }
        then("the server flags the call as spam") {
            let deadline = Date().addingTimeInterval(15)
            var flagged: ServerCall?
            while Date() < deadline {
                flagged = serverActiveCalls(hubId: callHubId).first { $0.id == callId }
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
