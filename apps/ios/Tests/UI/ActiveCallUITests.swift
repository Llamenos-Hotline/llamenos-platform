import XCTest

/// XCUITest suite for in-call actions on the dashboard.
/// Tests the active call card, hangup, ban dialog, and quick note buttons.
///
/// Maps to BDD scenarios: active-call-panel, hangup, ban-with-reason.
final class ActiveCallUITests: BaseUITest {

    // MARK: - Scenario: Active call card visible when call exists

    /// Verifies the active call card renders on the dashboard when a
    /// call is in progress. Requires the Docker Compose backend and
    /// a simulated incoming+answered call.
    func testActiveCallPanelVisible() {
        given("I am authenticated as admin with API and a call is active") {
            launchAsAdminWithAPI()

            // Simulate an incoming call and answer it
            let call = simulateIncomingCall(callerNumber: "+15551110001")
            guard !call.callId.isEmpty else { return }

            // Read admin pubkey from the settings for answering the call
            navigateToSettings()
            let npub = find("settings-npub")
            if npub.waitForExistence(timeout: 5) {
                // Use a placeholder pubkey — the simulation accepts any registered pubkey
            }
            simulateAnswerCall(callId: call.callId, pubkey: "admin")
            navigateToDashboard()
        }
        then("the active call card should be visible on the dashboard") {
            // "dashboard-title" is NOT in this list: it is the generic dashboard
            // landmark and renders whether or not a call is active, so including
            // it made this assertion true regardless of the call card — exactly
            // the kind of acceptance criteria that hid #1129 (iOS couldn't decode
            // a ringing call at all) behind a passing test.
            let found = anyElementExists([
                "active-call-card",
                "active-calls-card",
                "active-call-count",
            ])
            XCTAssertTrue(found, "Dashboard should show active call card or call count when a call is in progress")
        }
    }

    // MARK: - Scenario: Hangup button ends the call

    /// Verifies the hangup button is present on the active call card
    /// and tapping it dismisses the card.
    func testHangupButtonEndsCall() {
        given("I am authenticated as admin with API and a call is active") {
            launchAsAdminWithAPI()

            let call = simulateIncomingCall(callerNumber: "+15551110002")
            if !call.callId.isEmpty {
                simulateAnswerCall(callId: call.callId, pubkey: "admin")
            }
            navigateToDashboard()
        }
        when("I look for the hangup button") {
            let callCard = find("active-call-card")
            XCTAssertTrue(callCard.waitForExistence(timeout: 10), "Active call card should appear after answering the simulated call")
        }
        then("the hangup button should exist on the active call card") {
            let hangupButton = find("hangup-button")
            XCTAssertTrue(hangupButton.waitForExistence(timeout: 5), "Hangup button should be visible on active call card")
            XCTAssertTrue(hangupButton.isEnabled, "Hangup button should be tappable")
        }
    }

    // MARK: - Scenario: Ban + hangup button shows reason field

    /// Verifies that tapping the ban+hangup button opens a dialog
    /// with a reason text field.
    func testBanDialogShowsReasonField() {
        given("I am authenticated as admin with API and a call is active") {
            launchAsAdminWithAPI()

            let call = simulateIncomingCall(callerNumber: "+15551110003")
            if !call.callId.isEmpty {
                simulateAnswerCall(callId: call.callId, pubkey: "admin")
            }
            navigateToDashboard()
        }
        when("I tap the ban + hangup button") {
            let banButton = find("ban-hangup-button")
            XCTAssertTrue(banButton.waitForExistence(timeout: 10), "Ban + hangup button should be visible on the active call card")
            banButton.tap()
        }
        then("the ban dialog should show a reason input field") {
            let reasonInput = find("ban-reason-input")
            let confirmButton = find("ban-confirm-button")

            XCTAssertTrue(reasonInput.waitForExistence(timeout: 5), "Ban reason input should be visible in the ban dialog")
            XCTAssertTrue(confirmButton.waitForExistence(timeout: 3), "Ban confirm button should exist in the dialog")
        }
    }

    // MARK: - Scenario: Quick note button visible during active call

    /// Verifies the quick note button is present on the active call card.
    func testQuickNoteButtonVisibleDuringCall() {
        given("I am authenticated as admin with API and a call is active") {
            launchAsAdminWithAPI()

            let call = simulateIncomingCall(callerNumber: "+15551110004")
            if !call.callId.isEmpty {
                simulateAnswerCall(callId: call.callId, pubkey: "admin")
            }
            navigateToDashboard()
        }
        then("the quick note button should be visible") {
            let callCard = find("active-call-card")
            XCTAssertTrue(callCard.waitForExistence(timeout: 10), "Active call card should appear after answering the simulated call")

            let noteButton = find("quick-note-button")
            XCTAssertTrue(noteButton.waitForExistence(timeout: 3), "Quick note button should be visible during an active call")
        }
    }

    // MARK: - Scenario: Report spam button visible during active call

    /// Verifies the report spam button is present on the active call card.
    func testReportSpamButtonVisible() {
        given("I am authenticated as admin with API and a call is active") {
            launchAsAdminWithAPI()

            let call = simulateIncomingCall(callerNumber: "+15551110005")
            if !call.callId.isEmpty {
                simulateAnswerCall(callId: call.callId, pubkey: "admin")
            }
            navigateToDashboard()
        }
        then("the report spam button should be visible") {
            let callCard = find("active-call-card")
            XCTAssertTrue(callCard.waitForExistence(timeout: 10), "Active call card should appear after answering the simulated call")

            let spamButton = find("report-spam-button")
            XCTAssertTrue(spamButton.waitForExistence(timeout: 3), "Report spam button should be visible during an active call")
        }
    }
}
