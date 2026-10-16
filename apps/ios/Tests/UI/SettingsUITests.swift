import XCTest

/// BDD-aligned XCUITest suite for the settings screen.
/// Maps to scenarios from: settings-display.feature, profile-settings.feature,
/// theme.feature, lock-logout.feature, language-selection.feature
final class SettingsUITests: BaseUITest {

    override func setUp() {
        super.setUp()
        launchAuthenticated()
        navigateToSettings()
    }

    // MARK: - Settings Display (settings-display.feature)

    func testSettingsShowsPublicKey() {
        given("I am on the settings screen") {
            // Already navigated in setUp
        }
        then("I should see my signing pubkey") {
            // v3 device keys: the identity is the signing pubkey (hex), not a Bech32 npub.
            let pubkeyRow = find("settings-signing-pubkey")
            XCTAssertTrue(
                pubkeyRow.waitForExistence(timeout: 10),
                "Settings should display the signing pubkey"
            )
        }
    }

    func testSettingsShowsHubURL() {
        given("I am on the settings screen of an app configured with a hub") {
            // setUp launched without a hub, which is the state this scenario is not about.
            // Relaunch with the test hub configured, the way a user who has joined one is.
            app.terminate()
            app.launchArguments += ["--test-hub-url", testHubURL]
            launchAuthenticated()
            navigateToSettings()
        }
        then("I should see the hub URL I am connected to") {
            let hubRow = find("settings-hub-url")
            XCTAssertTrue(
                hubRow.waitForExistence(timeout: 10),
                "Settings should display the configured hub URL"
            )
            XCTAssertEqual(
                hubRow.label, testHubURL,
                "The hub URL row should show the hub the app is configured with"
            )
        }
    }

    func testSettingsShowsLockButton() {
        given("I am on the settings screen") {
            // Already navigated
        }
        then("I should see a lock button") {
            let lockButton = scrollToFind("settings-lock-app", maxSwipes: 10)
            XCTAssertTrue(
                lockButton.exists,
                "Lock app button should exist in settings"
            )
        }
    }

    func testSettingsShowsLogoutButton() {
        given("I am on the settings screen") {
            // Already navigated
        }
        then("I should see a logout button") {
            let logoutButton = scrollToFind("settings-logout", maxSwipes: 10)
            XCTAssertTrue(
                logoutButton.exists,
                "Logout button should exist in settings"
            )
        }
    }

    func testSettingsShowsVersion() {
        given("I am on the settings screen") {
            // Already navigated
        }
        then("I should see the app version") {
            let versionRow = scrollToFind("settings-version", maxSwipes: 10)
            XCTAssertTrue(
                versionRow.exists,
                "Version info should be displayed"
            )
        }
    }

    func testSettingsShowsConnectionStatus() {
        given("I am on the settings screen") {
            // Already navigated
        }
        then("I should see the connection status") {
            let connRow = scrollToFind("settings-connection")
            XCTAssertTrue(
                connRow.exists,
                "Connection status should be displayed in settings"
            )
        }
    }

    // MARK: - Profile (profile-settings.feature)

    func testCopySigningPubkeyShowsConfirmation() {
        given("I am on the account settings screen") {
            let accountLink = find("settings-account-link")
            guard accountLink.waitForExistence(timeout: 5) else {
                XCTFail("Account settings link should exist")
                return
            }
            accountLink.tap()
        }
        when("I tap the copy button next to my signing pubkey") {
            let copyButton = find("copy-signing-pubkey")
            guard copyButton.waitForExistence(timeout: 10) else {
                XCTFail("Copy signing pubkey button should exist")
                return
            }
            copyButton.tap()
        }
        then("I should see a copy confirmation") {
            XCTAssertTrue(
                find("copy-confirmation").waitForExistence(timeout: 5),
                "Copying the signing pubkey should show a confirmation"
            )
        }
    }

    func testAccountSettingsShowsSigningPubkey() {
        given("I am on the account settings screen") {
            let accountLink = find("settings-account-link")
            guard accountLink.waitForExistence(timeout: 5) else {
                XCTFail("Account settings link should exist")
                return
            }
            accountLink.tap()
        }
        then("I should see my signing pubkey and its copy button") {
            XCTAssertTrue(
                find("settings-signing-pubkey").waitForExistence(timeout: 10),
                "The signing pubkey row should exist"
            )
            XCTAssertTrue(find("copy-signing-pubkey").exists, "The signing pubkey copy button should exist")
        }
    }

    func testProfileShowsRoleBadge() {
        given("I am on the settings screen") {
            // Already navigated
        }
        then("I should see my role") {
            let roleRow = find("settings-role")
            XCTAssertTrue(
                roleRow.waitForExistence(timeout: 10),
                "Role display should exist in settings"
            )
        }
    }

    // MARK: - Device Link (not offered, #1300)

    func testAccountSettingsDoesNotOfferDeviceLinking() {
        given("I am on the account settings screen") {
            let accountLink = find("settings-account-link")
            guard accountLink.waitForExistence(timeout: 5) else {
                XCTFail("Account settings link should exist")
                return
            }
            accountLink.tap()
        }
        then("the whole list renders without a device link entry") {
            // Erasure is the last section — reaching it means every section has rendered.
            let erasure = scrollToFind("erasure-request-link", maxSwipes: 10)
            XCTAssertTrue(erasure.exists, "Account settings should render through to the erasure section")
            XCTAssertFalse(
                find("settings-link-device").exists,
                "Account settings must not offer device linking — it reports success without moving the keys"
            )
        }
    }

    // MARK: - Notification and Security Preferences
    //
    // These rows live on the Preferences screen (`settings-preferences-link`), not on the
    // top-level settings list. They used to be looked up on the top-level list behind an
    // `if toggle.exists` guard, so they were never found and never asserted.

    private func openPreferences() {
        let link = scrollToFind("settings-preferences-link", maxSwipes: 10)
        XCTAssertTrue(link.exists, "Settings should link to the Preferences screen")
        link.tap()
        XCTAssertTrue(
            find("settings-call-sounds").waitForExistence(timeout: 10),
            "The Preferences screen should open"
        )
    }

    private func isOn(_ element: XCUIElement) -> Bool {
        (element.value as? String) == "1"
    }

    /// Flip a Form `Toggle` and wait for it to hold the opposite value.
    ///
    /// The identifier lands on the merged row, whose centre is over the label; tapping a
    /// Form Toggle's label does not toggle it, so the trailing edge is tried second (see
    /// `AdminSettingsUITests.setSwitch`, where this was measured).
    private func flip(_ toggle: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        let before = isOn(toggle)
        let taps: [() -> Void] = [
            { toggle.tap() },
            { toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap() },
        ]
        for tap in taps {
            tap()
            let deadline = Date().addingTimeInterval(3)
            while isOn(toggle) == before, Date() < deadline {
                Thread.sleep(forTimeInterval: 0.2)
            }
            if isOn(toggle) != before { return }
        }
        XCTFail("Tapping the toggle should flip it from \(before)", file: file, line: line)
    }

    func testCallSoundsToggleExists() {
        given("I am on the preferences screen") {
            openPreferences()
        }
        then("tapping the call sounds toggle should change its value") {
            flip(find("settings-call-sounds"))
        }
    }

    func testMessageAlertsToggleExists() {
        given("I am on the preferences screen") {
            openPreferences()
        }
        then("tapping the message alerts toggle should change its value") {
            flip(find("settings-message-alerts"))
        }
    }

    // MARK: - Security Settings

    func testAutoLockPickerExists() {
        given("I am on the preferences screen") {
            openPreferences()
        }
        then("I should see an auto-lock timeout picker") {
            let picker = scrollToFind("settings-auto-lock-picker")
            XCTAssertTrue(picker.exists, "Preferences should offer an auto-lock timeout picker")
        }
    }

    func testBiometricToggleExists() {
        given("I am on the preferences screen") {
            openPreferences()
        }
        then("I should see a biometric unlock toggle") {
            let toggle = scrollToFind("settings-biometric-toggle")
            XCTAssertTrue(toggle.exists, "Preferences should offer a biometric unlock toggle")
        }
    }

    // MARK: - Lock / Logout (lock-logout.feature)

    func testLockNavigatesToPINScreen() {
        given("I am on the settings screen") {
            // Already navigated
        }
        when("I tap the lock button") {
            let lockButton = scrollToFind("settings-lock-app", maxSwipes: 10)
            XCTAssertTrue(lockButton.exists, "Lock button should exist")
            lockButton.tap()
        }
        then("I should see the PIN unlock screen") {
            let pinPad = find("pin-pad")
            XCTAssertTrue(
                pinPad.waitForExistence(timeout: 5),
                "PIN pad should appear after locking from settings"
            )
        }
    }

    func testLogoutNavigatesToLoginScreen() {
        given("I am on the settings screen") {
            // Already navigated
        }
        when("I tap the logout button") {
            let logoutButton = scrollToFind("settings-logout", maxSwipes: 10)
            XCTAssertTrue(logoutButton.exists, "Logout button should exist")
            logoutButton.tap()
        }
        then("I should see a confirmation dialog or the login screen") {
            // Logout may show an alert first
            let alert = app.alerts.firstMatch
            if alert.waitForExistence(timeout: 3) {
                // Tap the destructive button by matching its label (not by index)
                // NSLocalizedString returns the key when no .strings file exists
                if alert.buttons["logout_confirm_action"].exists {
                    alert.buttons["logout_confirm_action"].tap()
                } else if alert.buttons["Logout"].exists {
                    alert.buttons["Logout"].tap()
                } else {
                    // Fallback: tap whichever button is NOT Cancel
                    let alertButtons = alert.buttons
                    for i in 0..<alertButtons.count {
                        let button = alertButtons.element(boundBy: i)
                        if button.label != "cancel" && button.label != "Cancel" {
                            button.tap()
                            break
                        }
                    }
                }
            }
            // Should return to login screen
            let loginInput = find("hub-url-input")
            let createButton = find("create-identity")
            let found = loginInput.waitForExistence(timeout: 10)
                || createButton.waitForExistence(timeout: 2)
            XCTAssertTrue(found, "Should return to login screen after logout")
        }
    }
}
