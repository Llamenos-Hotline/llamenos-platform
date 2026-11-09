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
        failOnSystemAlert()
        app = XCUIApplication()
        // Reset state for clean test runs; skip hub validation for fake URLs
        app.launchArguments.append(contentsOf: ["--reset-keychain", "--test-skip-hub-validation"])
        app.launchToFirstScreen()
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

        // Device linking is not offered: the flow reported success without carrying the
        // keys across, leaving a second device that reads nothing (#1300).
        XCTAssertFalse(find("link-device").exists, "Login must not offer linking from another device")
    }

    // MARK: - Onboarding Flow

    func testOnboardingFlowCreateIdentity() {
        // V3 device key model: tapping "Create New Identity" validates the hub URL
        // and navigates directly to the PIN set screen — no device key display or backup step.
        let hubURLInput = find("hub-url-input")
        XCTAssertTrue(hubURLInput.waitForExistence(timeout: 5))
        typeText("https://test-hub.example.org", into: hubURLInput)
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

    // MARK: - Device Linking (not offered, #1300)

    func testDeviceLinkDeepLinkDoesNotLeaveLogin() {
        // `llamenos://device-link` used to open the linking flow at any auth state.
        let createButton = find("create-identity")
        XCTAssertTrue(createButton.waitForExistence(timeout: 20), "Login screen should be showing")

        app.open(URL(string: "llamenos://device-link")!)

        XCTAssertTrue(
            createButton.waitForExistence(timeout: 5),
            "A device-link deep link must leave the login screen in place"
        )
        XCTAssertTrue(createButton.isHittable, "Nothing may be pushed over the login screen")
        XCTAssertFalse(find("link-device").exists, "Login must not offer linking from another device")
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

        // The unlock screen's credential field should appear
        let pinInput = find("pin-input")
        XCTAssertTrue(
            pinInput.waitForExistence(timeout: 5),
            "The unlock credential field should appear after locking"
        )
    }

    // MARK: - Unlock Entry (the lock screen is a SecureField, #2303)

    func testUnlockWithTypedPIN() {
        navigateToFullyAuthenticated()
        lockApp()

        submitPIN("12345678")

        XCTAssertTrue(
            find("dashboard-title").waitForExistence(timeout: 20),
            "The typed PIN should unlock the app"
        )
    }

    /// Scenario: A passphrase longer than 8 characters unlocks the app
    func testAPassphraseLongerThan8CharactersUnlocksTheApp() {
        navigateToOnboarding()
        navigateToPINSet()

        // 12 characters, letters and digits — the digit pad this unlock screen
        // used to show could never have typed it (#2303).
        let passphrase = "passw0rd1234"
        submitPIN(passphrase)

        // Confirm phase
        XCTAssertTrue(find("pin-input").waitForExistence(timeout: 5), "PIN entry should remain for confirmation")
        submitPIN(passphrase)

        XCTAssertTrue(
            find("dashboard-title").waitForExistence(timeout: 20),
            "Dashboard should appear after setting the passphrase"
        )

        lockApp()
        submitPIN(passphrase)

        XCTAssertTrue(
            find("dashboard-title").waitForExistence(timeout: 20),
            "A 12-character alphanumeric passphrase should unlock the app"
        )
    }

    // MARK: - Navigation Helpers

    /// Navigate from login to the onboarding screen.
    private func navigateToOnboarding() {
        let hubURLInput = find("hub-url-input")
        XCTAssertTrue(hubURLInput.waitForExistence(timeout: 20), "The login screen should ask for a hub URL")
        typeText("https://test.example.org", into: hubURLInput)
        dismissKeyboard()

        let createButton = find("create-identity")
        XCTAssertTrue(createButton.waitForExistence(timeout: 5), "The login screen should offer to create an identity")
        createButton.tap()
    }

    /// Wait for the PIN set screen (v3: navigateToOnboarding already lands here).
    private func navigateToPINSet() {
        XCTAssertTrue(find("pin-input").waitForExistence(timeout: 10), "Creating an identity should lead to setting a PIN")
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

    /// Type a credential into the "pin-input" field and submit it. Both PIN
    /// screens (set and unlock) share the field and button identifiers since the
    /// unlock screen moved to the same SecureField (#2303).
    private func submitPIN(_ pin: String) {
        let pinInput = find("pin-input")
        guard pinInput.waitForExistence(timeout: 10) else {
            XCTFail("PIN entry should exist")
            return
        }
        typeText(pin, into: pinInput)
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
