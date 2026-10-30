import XCTest

/// BDD tests for Panic Wipe (Epic 246).
final class PanicWipeUITests: BaseUITest {

    /// Navigate to the panic wipe confirmation screen.
    /// Uses the test-only NavigationLink at the top of settings (`test-panic-wipe`)
    /// because SwiftUI List cell recycling breaks tap handlers for cells that
    /// require scrolling via XCUITest on iOS 26.
    private func navigateToPanicWipe() {
        navigateToSettings()

        let testLink = find("test-panic-wipe")
        XCTAssertTrue(testLink.waitForExistence(timeout: 5), "Test panic wipe link should exist")
        testLink.tap()

        // Wait for navigation to complete — check for the confirm button
        let confirmButton = find("confirm-panic-wipe")
        XCTAssertTrue(confirmButton.waitForExistence(timeout: 5), "Should navigate to confirmation screen")
    }

    // MARK: - Scenario: Panic wipe button exists in settings

    func testPanicWipeButtonExistsInSettings() {
        given("I am authenticated") {
            launchAuthenticated()
        }
        when("I navigate to settings") {
            navigateToSettings()
        }
        then("I should see the panic wipe link") {
            // Check the test-only link at top (always visible without scrolling)
            let testLink = find("test-panic-wipe")
            XCTAssertTrue(testLink.waitForExistence(timeout: 5), "Panic wipe link should exist in settings")
        }
    }

    // MARK: - Scenario: Panic wipe shows confirmation screen

    func testPanicWipeShowsConfirmation() {
        given("I am authenticated") {
            launchAuthenticated()
        }
        when("I navigate to settings and tap panic wipe") {
            navigateToPanicWipe()
        }
        then("I should see the confirmation screen") {
            let confirmButton = find("confirm-panic-wipe")
            XCTAssertTrue(confirmButton.waitForExistence(timeout: 5), "Wipe confirmation button should exist")
            let cancelButton = find("cancel-panic-wipe")
            XCTAssertTrue(cancelButton.waitForExistence(timeout: 3), "Cancel button should exist")
        }
    }

    // MARK: - Scenario: Panic wipe returns to login screen

    func testPanicWipeReturnsToLogin() {
        given("I am authenticated") {
            launchAuthenticated()
        }
        when("I confirm the panic wipe") {
            navigateToPanicWipe()

            // Type "WIPE" in the confirmation field (friction gate)
            let confirmInput = find("panic-wipe-confirmation-input")
            XCTAssertTrue(confirmInput.waitForExistence(timeout: 5), "Confirmation input should exist")
            typeText("WIPE", into: confirmInput)

            // Tap the confirm button (now enabled)
            let confirmButton = find("confirm-panic-wipe")
            XCTAssertTrue(confirmButton.waitForExistence(timeout: 5), "Confirm button should exist")
            confirmButton.tap()

            // The wipe asks one last time.
            let alert = app.alerts.firstMatch
            XCTAssertTrue(alert.waitForExistence(timeout: 5), "Confirming should raise a final confirmation alert")
            let wipeButton = alert.buttons["Yes, Wipe Everything"]
            XCTAssertTrue(wipeButton.exists, "The alert should offer 'Yes, Wipe Everything'")
            wipeButton.tap()
        }
        then("I should see the login screen") {
            let hubURLInput = find("hub-url-input")
            XCTAssertTrue(hubURLInput.waitForExistence(timeout: 10), "Should return to login screen after panic wipe")
        }
    }

    // MARK: - Scenario: Cancel panic wipe returns to settings

    func testCancelPanicWipeReturnsToSettings() {
        given("I am authenticated") {
            launchAuthenticated()
        }
        when("I cancel the panic wipe") {
            navigateToPanicWipe()
            let cancelButton = find("cancel-panic-wipe")
            XCTAssertTrue(cancelButton.waitForExistence(timeout: 5), "Cancel button should exist")
            cancelButton.tap()
        }
        then("I should be back on the settings screen") {
            XCTAssertTrue(
                anyElementExists(["settings-version", "settings-lock-app", "test-panic-wipe"]),
                "Should return to settings screen after cancel"
            )
        }
    }
}
