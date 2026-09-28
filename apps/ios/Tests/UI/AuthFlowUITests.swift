import XCTest

/// XCUITest suite for the authentication flow: login -> onboarding -> PIN set -> dashboard.
/// Also tests import flow and lock/unlock.
///
/// These tests interact with real SwiftUI controls via accessibility identifiers,
/// avoiding the issues Detox had with React Native's TextInput.
final class AuthFlowUITests: XCTestCase {

    private var app: XCUIApplication!

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        app = XCUIApplication()
        // Reset state for clean test runs; skip hub validation for fake URLs
        app.launchArguments.append(contentsOf: ["--reset-keychain", "--test-skip-hub-validation"])
        app.launchAnsweringSystemPrompts()
    }

    override func tearDown() {
        app = nil
        super.tearDown()
    }

    /// Find any element by accessibility identifier, regardless of XCUIElement type.
    private func find(_ identifier: String) -> XCUIElement {
        return app.descendants(matching: .any)[identifier].firstMatch
    }

    /// Dismiss the keyboard if visible.
    private func dismissKeyboard() {
        // Tap on a non-interactive area to dismiss keyboard
        let coordinate = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1))
        coordinate.tap()
    }

    // MARK: - Login Screen

    func testLoginScreenShowsRequiredElements() {
        // Hub URL input should be visible (longer timeout for cold start after simulator reset)
        let hubURLInput = find("hub-url-input")
        XCTAssertTrue(hubURLInput.waitForExistence(timeout: 20), "Hub URL input should exist")

        // Create Identity button
        let createButton = find("create-identity")
        XCTAssertTrue(createButton.waitForExistence(timeout: 3), "Create Identity button should exist")

        // Link Device button (v3: device linking via QR/ECDH replaces device key import)
        let linkButton = find("link-device")
        XCTAssertTrue(linkButton.waitForExistence(timeout: 3), "Link Device button should exist")
    }

    // MARK: - Onboarding Flow

    func testOnboardingFlowCreateIdentity() {
        // V3 device key model: tapping "Create New Identity" validates the hub URL
        // and navigates directly to the PIN set screen — no device key display or backup step.
        let hubURLInput = find("hub-url-input")
        XCTAssertTrue(hubURLInput.waitForExistence(timeout: 5))
        hubURLInput.tap()
        hubURLInput.typeText("https://test-hub.example.org")
        dismissKeyboard()

        // Tap "Create New Identity"
        let createButton = find("create-identity")
        guard createButton.waitForExistence(timeout: 5) else {
            XCTFail("Create identity button should exist")
            return
        }
        createButton.tap()

        // PIN set appears directly (v3: no device key or backup step). It is a free-text
        // field so a PIN or passphrase of 8+ characters can be set (PINSetView.swift);
        // the digit pad is only the unlock screen's.
        let pinInput = find("pin-input")
        XCTAssertTrue(
            pinInput.waitForExistence(timeout: 10),
            "PIN entry should appear after tapping Create New Identity (v3 direct-to-PIN flow)"
        )
    }

    // MARK: - PIN Set Flow

    func testPINSetEnterAndConfirm() {
        navigateToOnboarding()
        navigateToPINSet()

        submitPIN("12345678")

        // Should transition to the confirm phase, still on PIN entry
        XCTAssertTrue(find("pin-input").waitForExistence(timeout: 5), "PIN entry should remain for confirmation")

        submitPIN("12345678")

        // Should reach dashboard after successful PIN set
        let dashboardTitle = find("dashboard-title")
        XCTAssertTrue(
            dashboardTitle.waitForExistence(timeout: 10),
            "Dashboard should appear after successful PIN set"
        )
    }

    func testPINSetMismatchShowsError() {
        navigateToOnboarding()
        navigateToPINSet()

        submitPIN("12345678")
        submitPIN("56789012")

        // Error should be displayed
        let pinError = find("pin-error")
        XCTAssertTrue(
            pinError.waitForExistence(timeout: 5),
            "PIN mismatch error should be displayed"
        )

        // PIN entry should still be available for retry
        XCTAssertTrue(find("pin-input").exists, "PIN entry should remain for retry")
    }

    // MARK: - Import Flow

    func testDeviceLinkFlow() {
        // V3: device key import replaced by device linking (QR + ephemeral ECDH).
        // Tap "Link from Another Device" and verify the device link screen appears.
        let hubInput = find("hub-url-input")
        XCTAssertTrue(hubInput.waitForExistence(timeout: 20), "Hub URL input should exist")

        let linkButton = find("link-device")
        XCTAssertTrue(linkButton.waitForExistence(timeout: 5), "Link Device button should exist")
        linkButton.tap()

        // Device link view should appear
        let deviceLinkView = find("device-link-view")
        XCTAssertTrue(
            deviceLinkView.waitForExistence(timeout: 5),
            "Device link view should appear after tapping Link from Another Device"
        )
        app.answerSystemPromptOnce(.camera)

        // Cancel should return to login
        let cancelButton = find("cancel-device-link")
        if cancelButton.waitForExistence(timeout: 3) {
            cancelButton.tap()
            let createButton = find("create-identity")
            XCTAssertTrue(
                createButton.waitForExistence(timeout: 5),
                "Should return to login after cancel"
            )
        }
    }

    // MARK: - Dashboard

    func testDashboardShowsIdentityAndLockButton() {
        navigateToFullyAuthenticated()

        // Dashboard should show identity (hex signing pubkey in v3)
        let npubDisplay = find("dashboard-identity")
        XCTAssertTrue(
            npubDisplay.waitForExistence(timeout: 5),
            "Dashboard should display the user's identity"
        )

        // Lock button should exist
        let lockButton = find("lock-app")
        XCTAssertTrue(lockButton.exists, "Lock button should exist on dashboard")

        // Shift status card should exist
        let shiftCard = find("shift-status-card")
        XCTAssertTrue(shiftCard.exists, "Shift status card should exist")
    }

    func testLockButtonTransitionsToPINUnlock() {
        navigateToFullyAuthenticated()

        // Tap lock
        let lockButton = find("lock-app")
        XCTAssertTrue(lockButton.waitForExistence(timeout: 5))
        lockButton.tap()

        // PIN pad should appear (PIN unlock screen)
        let pinPad = find("pin-pad")
        XCTAssertTrue(
            pinPad.waitForExistence(timeout: 5),
            "PIN pad should appear after locking"
        )
    }

    // MARK: - PIN Pad Interaction (unlock screen — the only digit pad in v3)

    func testPINPadDigitButtons() {
        navigateToFullyAuthenticated()
        lockApp()

        let pinPad = find("pin-pad")
        guard pinPad.waitForExistence(timeout: 5) else {
            XCTFail("PIN pad should exist on the unlock screen")
            return
        }

        for digit in 0...9 {
            XCTAssertTrue(find("pin-\(digit)").exists, "PIN button \(digit) should exist")
        }
        XCTAssertTrue(find("pin-backspace").exists, "Backspace button should exist")
    }

    func testPINPadBackspace() {
        navigateToFullyAuthenticated()
        lockApp()

        guard find("pin-pad").waitForExistence(timeout: 5) else {
            XCTFail("PIN pad should exist on the unlock screen")
            return
        }

        // 1-2-3-4-5-6, delete the 6, then 6-7-8: the correct PIN only if backspace
        // removed exactly one digit. Without it the pad would submit 12345667.
        for digit in ["1", "2", "3", "4", "5", "6"] { find("pin-\(digit)").tap() }
        find("pin-backspace").tap()
        for digit in ["6", "7", "8"] { find("pin-\(digit)").tap() }

        XCTAssertTrue(
            find("dashboard-title").waitForExistence(timeout: 20),
            "The corrected PIN should unlock the app"
        )
    }

    // MARK: - Navigation Helpers

    /// Navigate from login to the onboarding screen.
    private func navigateToOnboarding() {
        let hubURLInput = find("hub-url-input")
        guard hubURLInput.waitForExistence(timeout: 20) else { return }
        hubURLInput.tap()
        hubURLInput.typeText("https://test.example.org")
        dismissKeyboard()

        let createButton = find("create-identity")
        guard createButton.waitForExistence(timeout: 5) else { return }
        createButton.tap()
    }

    /// Wait for the PIN set screen (v3: navigateToOnboarding already lands here).
    private func navigateToPINSet() {
        _ = find("pin-input").waitForExistence(timeout: 10)
    }

    /// Navigate all the way through to the dashboard (create identity, set PIN).
    private func navigateToFullyAuthenticated() {
        navigateToOnboarding()
        navigateToPINSet()
        submitPIN("12345678")
        submitPIN("12345678")
        XCTAssertTrue(
            find("dashboard-title").waitForExistence(timeout: 20),
            "Dashboard should appear after setting the PIN"
        )
    }

    /// Type a PIN into the PIN set screen's field and submit it.
    private func submitPIN(_ pin: String) {
        let pinInput = find("pin-input")
        guard pinInput.waitForExistence(timeout: 10) else {
            XCTFail("PIN entry should exist")
            return
        }
        pinInput.tap()
        pinInput.typeText(pin)
        let submit = find("pin-submit")
        guard submit.waitForExistence(timeout: 3) else {
            XCTFail("PIN submit should exist")
            return
        }
        submit.tap()
    }

    /// Lock from the dashboard, landing on the PIN unlock screen.
    private func lockApp() {
        let lockButton = find("lock-app")
        guard lockButton.waitForExistence(timeout: 5) else {
            XCTFail("Lock button should exist on the dashboard")
            return
        }
        lockButton.tap()
    }
}
