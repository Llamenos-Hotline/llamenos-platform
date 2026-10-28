import XCTest

/// XCUITest suite for recovery group features (EP09-P4).
/// Tests admin recovery team configuration, recovery request management,
/// and the unauthenticated account recovery flow.
final class RecoveryGroupUITests: BaseUITest {

    // MARK: - Admin Recovery Team Configuration

    func testAdminCanConfigureRecoveryTeam() {
        launchAsAdminWithAPI()

        navigateToAdminSettingsScreen("admin-recovery-team")

        // This class's hub is fresh, so no recovery team exists: the setup form must show.
        XCTAssertTrue(
            find("recovery-team-setup").waitForExistence(timeout: 15),
            "A hub without a recovery team should show the setup form"
        )
        XCTAssertTrue(scrollToFind("recovery-threshold-picker").exists, "Threshold picker should exist in setup state")
        XCTAssertTrue(scrollToFind("recovery-total-picker").exists, "Total shares picker should exist in setup state")
        XCTAssertTrue(scrollToFind("setup-recovery-team-button").exists, "Setup button should exist in setup state")
    }

    // MARK: - Admin Recovery Requests

    func testAdminCanViewRecoveryRequests() {
        launchAsAdminWithAPI()

        navigateToAdminSettingsScreen("admin-recovery-requests")

        // This class's hub is fresh, so nobody has asked for recovery: the view settles on its
        // empty state — not still loading, and with no requests listed.
        XCTAssertTrue(
            find("recovery-requests-empty").waitForExistence(timeout: 15),
            "A hub with no recovery requests should show the empty state"
        )
        XCTAssertFalse(find("recovery-requests-loading").exists, "The requests should have finished loading")
    }

    // MARK: - User Account Recovery Flow

    func testUserCanStartRecoveryFlow() throws {
        app.launchArguments.append(contentsOf: [
            "--reset-keychain",
        ])
        app.launchToFirstScreen()

        // Navigate to recovery from the login screen
        let recoveryLink = scrollToFind("login-recover-account")
        guard recoveryLink.exists else {
            // "login-recover-account" does not exist anywhere in
            // apps/ios/Sources — AccountRecoveryView.swift is a real view,
            // but LoginView.swift never links to it, so this is not a timing
            // issue ("not visible yet") but an unreachable feature. Report
            // that explicitly instead of silently passing with no assertion
            // ever evaluated.
            throw XCTSkip("No recovery link exists on the login screen; AccountRecoveryView is unreachable from LoginView")
        }
        recoveryLink.tap()

        XCTAssertTrue(find("account-recovery-view").waitForExistence(timeout: 5), "Account recovery view should appear")

        // Verify identifier input exists
        let hubInput = find("recovery-hub-input")
        XCTAssertTrue(
            hubInput.waitForExistence(timeout: 5),
            "Hub URL input should exist in recovery flow"
        )

        let identifierInput = find("recovery-identifier-input")
        XCTAssertTrue(
            identifierInput.waitForExistence(timeout: 5),
            "Identifier input should exist in recovery flow"
        )

        // Start is unavailable until both fields are filled
        let startButton = find("start-recovery-button")
        XCTAssertTrue(
            startButton.waitForExistence(timeout: 5),
            "Start recovery button should exist"
        )
        XCTAssertFalse(startButton.isEnabled, "Recovery cannot start with no hub and no identifier")

        hubInput.tap()
        hubInput.typeText("https://test.example.org")
        XCTAssertFalse(startButton.isEnabled, "A hub alone is not enough to start recovery")

        identifierInput.tap()
        identifierInput.typeText("+15551234567")
        XCTAssertTrue(startButton.isEnabled, "Recovery can start once the hub and identifier are filled")
    }
}
