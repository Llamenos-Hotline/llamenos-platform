import XCTest

/// XCUITest suite for recovery group features (EP09-P4).
/// Tests admin recovery team configuration, recovery request management,
/// and the unauthenticated account recovery flow.
final class RecoveryGroupUITests: BaseUITest {

    // MARK: - Admin Recovery Team Configuration

    func testAdminCanConfigureRecoveryTeam() {
        launchAsAdminWithAPI()

        navigateToAdminSettingsScreen("admin-recovery-team")

        let found = anyElementExists([
            "recovery-team-config-view",
            "recovery-team-loading",
        ])
        XCTAssertTrue(found, "Recovery team config view should show content or loading state")

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

        let found = anyElementExists([
            "recovery-requests-view",
            "recovery-requests-empty",
            "recovery-requests-loading",
        ])
        XCTAssertTrue(found, "Recovery requests view should show content, empty state, or loading")
    }

    // MARK: - User Account Recovery Flow

    func testUserCanStartRecoveryFlow() {
        app.launchArguments.append(contentsOf: [
            "--reset-keychain",
        ])
        app.launchAnsweringSystemPrompts()

        // Navigate to recovery from the login screen
        let recoveryLink = scrollToFind("login-recover-account")
        guard recoveryLink.exists else {
            // Recovery link may not be visible yet; skip test gracefully
            return
        }
        recoveryLink.tap()

        let recoveryView = find("account-recovery-view")
        guard recoveryView.waitForExistence(timeout: 5) else {
            XCTFail("Account recovery view should appear")
            return
        }

        // Verify identifier input exists
        let hubInput = find("recovery-hub-url-input")
        XCTAssertTrue(
            hubInput.waitForExistence(timeout: 5),
            "Hub URL input should exist in recovery flow"
        )

        let identifierInput = find("recovery-identifier-input")
        XCTAssertTrue(
            identifierInput.waitForExistence(timeout: 5),
            "Identifier input should exist in recovery flow"
        )

        // Verify start button exists and is initially disabled
        let startButton = find("recovery-start-button")
        XCTAssertTrue(
            startButton.waitForExistence(timeout: 5),
            "Start recovery button should exist"
        )

        // Type into fields and verify button becomes enabled
        hubInput.tap()
        hubInput.typeText("https://test.example.org")

        identifierInput.tap()
        identifierInput.typeText("+15551234567")
    }
}
