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

    func testSettingsShowsHubURL() throws {
        given("I am on the settings screen") {
            // Already navigated
        }
        try then("I should see the hub URL") {
            // SettingsView only renders "settings-hub-url" `if let hubURL =
            // appState.authService.hubURL` — this class's setUp() calls
            // `launchAuthenticated()`, which never configures a hub URL, so the
            // row is guaranteed absent here, not merely "may not be set".
            // `APIConnectedUITests.testSettingsShowsHubURL` covers the
            // hub-configured case against a real connection.
            throw XCTSkip("This test class launches with no hub configured; settings-hub-url never renders")
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

    // MARK: - Notification Settings

    func testCallSoundsToggleExists() {
        given("I am on the preferences settings screen") {
            // These toggles live on PreferencesSettingsView, not the top-level
            // Settings screen — `scrollToFind` against the top-level screen
            // alone never located them, so `if toggle.exists` was always false
            // and this test asserted nothing.
            navigateToPreferencesSettings()
        }
        then("I should see a call sounds toggle") {
            XCTAssertTrue(
                scrollToFind("settings-call-sounds").exists,
                "Call sounds toggle should exist in preferences"
            )
        }
    }

    func testMessageAlertsToggleExists() {
        given("I am on the preferences settings screen") {
            navigateToPreferencesSettings()
        }
        then("I should see a message alerts toggle") {
            XCTAssertTrue(
                scrollToFind("settings-message-alerts").exists,
                "Message alerts toggle should exist in preferences"
            )
        }
    }

    // MARK: - Security Settings

    func testAutoLockPickerExists() {
        given("I am on the preferences settings screen") {
            navigateToPreferencesSettings()
        }
        then("I should see an auto-lock timeout picker") {
            XCTAssertTrue(
                scrollToFind("settings-auto-lock-picker").exists,
                "Auto-lock picker should exist in preferences"
            )
        }
    }

    func testBiometricToggleExists() {
        given("I am on the preferences settings screen") {
            navigateToPreferencesSettings()
        }
        then("I should see a biometric unlock toggle") {
            XCTAssertTrue(
                scrollToFind("settings-biometric-toggle").exists,
                "Biometric toggle should exist in preferences"
            )
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
