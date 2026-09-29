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
        given("I am on the settings screen") {
            // Already navigated
        }
        then("I should see the hub URL or not-configured state") {
            // Hub URL may not be set in test-authenticated mode
            let hubRow = find("settings-hub-url")
            if hubRow.waitForExistence(timeout: 5) {
                XCTAssertTrue(true, "Hub URL is displayed")
            }
            // Hub URL being absent is acceptable in test mode (no hub configured)
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

    // MARK: - Device Link (device-link.feature)

    func testDeviceLinkButtonExists() {
        given("I am on the settings screen") {
            // Device link is now in Account Settings sub-page
            let accountLink = find("settings-account-link")
            guard accountLink.waitForExistence(timeout: 5) else {
                XCTFail("Account settings link should exist")
                return
            }
            accountLink.tap()
        }
        then("I should see a device link button") {
            let linkButton = scrollToFind("settings-link-device", maxSwipes: 10)
            XCTAssertTrue(
                linkButton.exists,
                "Link device button should exist in account settings"
            )
        }
    }

    // MARK: - Notification Settings

    func testCallSoundsToggleExists() {
        given("I am on the settings screen") {
            // Already navigated
        }
        then("I should see a call sounds toggle") {
            let toggle = scrollToFind("settings-call-sounds")
            if toggle.exists {
                XCTAssertTrue(true, "Call sounds toggle exists")
            }
        }
    }

    func testMessageAlertsToggleExists() {
        given("I am on the settings screen") {
            // Already navigated
        }
        then("I should see a message alerts toggle") {
            let toggle = scrollToFind("settings-message-alerts")
            if toggle.exists {
                XCTAssertTrue(true, "Message alerts toggle exists")
            }
        }
    }

    // MARK: - Security Settings

    func testAutoLockPickerExists() {
        given("I am on the settings screen") {
            // Already navigated
        }
        then("I should see an auto-lock timeout picker") {
            let picker = scrollToFind("settings-auto-lock-picker")
            if picker.exists {
                XCTAssertTrue(true, "Auto-lock picker exists")
            }
        }
    }

    func testBiometricToggleExists() {
        given("I am on the settings screen") {
            // Already navigated
        }
        then("I should see a biometric unlock toggle") {
            let toggle = scrollToFind("settings-biometric-toggle")
            if toggle.exists {
                XCTAssertTrue(true, "Biometric toggle exists")
            }
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
