import XCTest

/// BDD-aligned XCUITest suite for security-related scenarios.
/// Maps to scenarios from: emergency-wipe.feature, panic-wipe.feature, Epic 260 hardening
final class SecurityUITests: BaseUITest {

    /// XCTest kills a test at 180s by default and xcodebuild raises that to
    /// 300s; this suite drives the PIN lockout policy, which is defined in
    /// failed ATTEMPTS and cannot be made to need fewer of them.
    /// `testPINWipeAfterTenFailedAttempts` must enter a full wrong PIN ten
    /// times to reach `PINLockout.maxAttempts`, and the two lockout tests do
    /// the same five and six times.
    ///
    /// The entry cost that motivated the original allowance is gone — the digit
    /// pad's 160 hierarchy walks per test became one `typeText` when the unlock
    /// screen moved to a SecureField (#2303). The allowance stays as headroom:
    /// hosted macOS runners have shown a 1.86x machine-only spread (168s vs
    /// 313s for the same 62 tests), so the 300s default still sits inside the
    /// variance and a contended runner would kill the shard mid-test.
    override func setUp() {
        super.setUp()
        executionTimeAllowance = 900
    }

    // MARK: - Helpers

    /// Lock the app from the dashboard (or Settings) and wait for the unlock field.
    private func lockApp() {
        let lockButton = find("lock-app")
        if lockButton.waitForExistence(timeout: 10) {
            lockButton.tap()
        } else {
            navigateToSettings()
            let settingsLock = scrollToFind("settings-lock-app", maxSwipes: 10)
            XCTAssertTrue(settingsLock.exists, "No lock button found on the dashboard or in Settings")
            settingsLock.tap()
        }
        XCTAssertTrue(find("pin-input").waitForExistence(timeout: 10), "Locking the app should show the unlock field")
    }

    /// A wrong but well-formed credential (8 digits — the field's submit is gated
    /// at 8, and every stored credential satisfies the 8+ creation rule).
    private let wrongPIN = "99999999"

    /// Enter a wrong PIN and wait for the error that answers it.
    @discardableResult
    private func enterWrongPIN() -> String {
        enterPIN(wrongPIN)
        let error = find("pin-error")
        XCTAssertTrue(error.waitForExistence(timeout: 5), "A wrong PIN should be answered with an error")
        return error.label
    }

    // MARK: - Emergency Wipe (emergency-wipe.feature)

    /// A launch with nothing in the keychain starts at the login screen: no unlock
    /// field, no main tab view — there is no session to resume.
    func testEmergencyWipeFromLoginScreen() {
        given("the keychain is empty") {
            launchClean()
        }
        then("the app shows the login screen and nothing of a session") {
            XCTAssertTrue(find("hub-url-input").waitForExistence(timeout: 20), "A clean launch should show login")
            XCTAssertTrue(find("create-identity").exists, "Login should offer to create an identity")
            XCTAssertFalse(find("pin-input").exists, "There is no identity to unlock")
            XCTAssertFalse(find("main-tab-view").exists, "There is no session to resume")
        }
    }

    func testLockScreenShowsPINEntry() {
        given("I am authenticated") {
            launchAuthenticated()
        }
        when("I lock the app") {
            let lockButton = find("lock-app")
            guard lockButton.waitForExistence(timeout: 10) else {
                // Try settings lock button (may need scrolling)
                navigateToSettings()
                let settingsLock = scrollToFind("settings-lock-app", maxSwipes: 10)
                guard settingsLock.exists else {
                    XCTFail("No lock button found")
                    return
                }
                settingsLock.tap()
                return
            }
            lockButton.tap()
        }
        then("I should see the credential field on the lock screen") {
            let pinInput = find("pin-input")
            XCTAssertTrue(
                pinInput.waitForExistence(timeout: 5),
                "The unlock credential field should be displayed on the lock screen"
            )
        }
        and("I should see the locked identity") {
            // "locked-npub" was the pre-v3 identifier (nsec/npub terminology).
            // The lock screen now shows the device's hex signing pubkey under
            // "locked-identity" (see PINUnlockView.swift).
            let lockedIdentity = find("locked-identity")
            XCTAssertTrue(
                lockedIdentity.waitForExistence(timeout: 3),
                "Locked identity should be displayed on the lock screen"
            )
        }
    }

    func testPINUnlockWithWrongPINShowsError() {
        given("the app is locked") {
            launchAuthenticated()
            lockApp()
        }
        when("I enter the wrong PIN") {
            enterPIN(wrongPIN)
        }
        then("I should be told the PIN is incorrect") {
            let pinError = find("pin-error")
            XCTAssertTrue(
                pinError.waitForExistence(timeout: 5),
                "PIN error should be displayed for wrong PIN"
            )
            XCTAssertTrue(
                pinError.label.contains("Incorrect PIN"),
                "A first wrong PIN is 'Incorrect PIN', not a lockout (got '\(pinError.label)')"
            )
        }
        and("the unlock field should still be visible, and the app still locked") {
            XCTAssertTrue(find("pin-input").exists, "The unlock field should remain for retry")
            XCTAssertFalse(find("main-tab-view").exists, "A wrong PIN must not unlock the app")
        }
    }

    // MARK: - Unlock Entry (#2303)

    // The digit pad these tests used to exercise ("pin-pad", "pin-\(digit)",
    // "pin-dots") is deleted: the unlock screen is a free-text SecureField, the
    // same component the set screen uses, because a credential may be any 8+
    // characters and a 6/8-digit pad could never type one (#2303). Entry-level
    // coverage now lives in AuthFlowUITests (typed-PIN unlock, passphrase
    // unlock); this suite keeps the lockout policy tests below.

    // MARK: - Epic 260: Biometric Unlock (C5)

    /// The biometric button is offered only when biometric unlock is enabled for the
    /// identity AND the device has biometry enrolled. An authenticated test launch
    /// enables neither (a simulator has no enrolment, and `--test-authenticated` never
    /// turns the preference on), so the lock screen must offer the credential field
    /// alone — the button is not a maybe, it must be absent.
    func testBiometricUnlockButtonHiddenWhenBiometricUnlockIsOff() {
        given("I am authenticated with biometric unlock off") {
            launchAuthenticated()
        }
        when("I lock the app") {
            let lockButton = find("lock-app")
            XCTAssertTrue(lockButton.waitForExistence(timeout: 10), "The lock button should exist on the dashboard")
            lockButton.tap()
        }
        then("I should see the unlock field and no biometric unlock button") {
            XCTAssertTrue(
                find("pin-input").waitForExistence(timeout: 5),
                "The credential field should always be available as fallback"
            )
            XCTAssertFalse(
                find("biometric-unlock").exists,
                "Biometric unlock must not be offered when it is not enabled for this identity"
            )
        }
    }

    // MARK: - Epic 260: HTTP URL Rejection (H6)

    func testHTTPHubURLShowsError() {
        given("the app is on the login screen") {
            launchClean()
        }
        when("I enter an HTTP hub URL and try to create identity") {
            let hubInput = find("hub-url-input")
            XCTAssertTrue(hubInput.waitForExistence(timeout: 5), "The hub URL field should exist on the login screen")
            typeText("http://insecure.example.org", into: hubInput)

            dismissKeyboard()

            let createButton = find("create-identity")
            XCTAssertTrue(createButton.waitForExistence(timeout: 5), "The create identity button should exist")
            createButton.tap()
        }
        then("I should see an error about insecure connection") {
            // LoginView surfaces AuthViewModel.errorMessage under "login-error";
            // APIService.configure rejects http:// with the HTTPS-required message.
            let errorElement = find("login-error")
            XCTAssertTrue(errorElement.waitForExistence(timeout: 5), "An HTTP hub URL should be rejected with an error")
            XCTAssertTrue(
                errorElement.label.localizedCaseInsensitiveContains("HTTPS"),
                "The error should say HTTPS is required, not just that something failed (got '\(errorElement.label)')"
            )
            XCTAssertFalse(find("pin-input").exists, "A rejected hub URL must not advance to setting a PIN")
        }
    }

    // MARK: - Epic 260: Privacy Overlay (M28)

    func testPrivacyOverlayIdentifierExists() {
        // This test verifies the privacy overlay view is defined with the correct
        // accessibility identifier. The actual overlay behavior (showing on
        // scenePhase == .inactive) cannot be tested in XCUITest because there's
        // no way to simulate the app switcher programmatically.
        given("I am authenticated") {
            launchAuthenticated()
        }
        then("the privacy overlay should not be visible when app is active") {
            let overlay = find("privacy-overlay")
            // Overlay should NOT be visible in the active state
            XCTAssertFalse(
                overlay.waitForExistence(timeout: 2),
                "Privacy overlay should not be visible when app is active"
            )
        }
    }

    // MARK: - Epic 260: Auto-Lock Timeout Setting (M26)

    func testAutoLockPickerExistsInSettings() {
        given("I am authenticated") {
            launchAuthenticated()
        }
        when("I navigate to preferences settings") {
            navigateToPreferencesSettings()
        }
        then("the auto-lock timeout picker should exist") {
            let picker = scrollToFind("settings-auto-lock-picker", maxSwipes: 10)
            XCTAssertTrue(
                picker.exists,
                "Auto-lock timeout picker should exist in preferences settings"
            )
        }
    }

    // MARK: - Epic 260: PIN Lockout Persistence (H7)

    func testPINLockoutAfterFiveWrongAttempts() {
        given("the app is locked with an existing identity") {
            launchAuthenticated()
            lockApp()
        }
        when("I enter the wrong PIN 4 times") {
            for attempt in 1...4 {
                let message = enterWrongPIN()
                XCTAssertTrue(
                    message.contains("Incorrect PIN"),
                    "Attempt \(attempt) is still just incorrect, not a lockout (got '\(message)')"
                )
            }
        }
        and("a fifth time") {
            enterWrongPIN()
        }
        then("I should be locked out for 30 seconds") {
            let pinError = find("pin-error")
            XCTAssertTrue(
                pinError.label.contains("Try again in 30 seconds"),
                "The fifth wrong PIN should lock the pad for 30 seconds (got '\(pinError.label)')"
            )
        }
        and("the unlock field should still be visible for when lockout expires") {
            XCTAssertTrue(find("pin-input").exists, "The unlock field should remain visible during lockout")
            XCTAssertFalse(find("main-tab-view").exists)
        }
    }

    func testPINLockoutShowsRemainingTime() {
        given("the app is locked") {
            launchAuthenticated()
            lockApp()
        }
        when("I exceed the lockout threshold with wrong PINs") {
            for _ in 1...5 { enterWrongPIN() }
        }
        then("the lock screen counts down the remaining time") {
            let remaining = app.staticTexts.matching(
                NSPredicate(format: "label BEGINSWITH 'Locked out. Try again in'")
            ).firstMatch
            XCTAssertTrue(remaining.waitForExistence(timeout: 5), "The subtitle should say how long the lockout lasts")
            let seconds = Int(remaining.label.filter(\.isNumber)) ?? -1
            XCTAssertTrue(
                (1...30).contains(seconds),
                "A first lockout lasts at most 30 seconds (reads '\(remaining.label)')"
            )
        }
    }

    /// Attempts made while locked out are refused, not counted: the policy escalates on
    /// attempts the app actually evaluated, so hammering the pad during a lockout neither
    /// unlocks nor advances toward the key wipe. (The ten-attempt wipe itself needs fifteen
    /// minutes of real lockouts; `PINLockout` is covered by `SecurityHardeningTests`.)
    func testPINWipeAfterTenFailedAttempts() {
        given("the app is locked and a five-attempt lockout is in force") {
            launchAuthenticated()
            lockApp()
            for _ in 1...5 { enterWrongPIN() }
            XCTAssertTrue(find("pin-error").label.contains("Try again in 30 seconds"))
        }
        when("I keep entering wrong PINs during the lockout") {
            for _ in 1...5 { enterPIN(wrongPIN) }
        }
        then("they are refused, and the app is neither unlocked nor wiped") {
            XCTAssertTrue(
                find("pin-error").waitForExistence(timeout: 5)
                    && find("pin-error").label.contains("Please wait and try again"),
                "Attempts during a lockout should be refused (got '\(find("pin-error").label)')"
            )
            XCTAssertTrue(find("pin-input").exists, "The app should still be locked")
            XCTAssertFalse(find("hub-url-input").exists, "Refused attempts must not wipe the keys")
            XCTAssertFalse(find("main-tab-view").exists)
        }
    }

    // MARK: - Epic 260 / Issue #755: Sensitive Credential Input Not Retained (M27)
    //
    // Originally "device key input cleared after import": the v2 model let a
    // user paste a raw device key (nsec) into an "import-key" screen, and
    // this suite checked that AuthViewModel.cancelImport() cleared it. The
    // v3 device-key migration deleted that whole screen — "there is no nsec
    // to display for backup" (see AuthViewModel.swift's doc comment) —
    // device keys are now generated atomically inside PIN set
    // (PINViewModel.handleSetPIN), and multi-device support uses QR/ECDH
    // device linking instead of key paste/import.
    //
    // `find("import-key")` on the deleted screen still returned a valid
    // (non-existent) XCUIElement, so `waitForExistence` just returned false
    // and the test read as "the button never showed up in time" instead of
    // "this feature doesn't exist" — a stale identifier degrading a real
    // regression test into one that could pass without checking anything.
    // These two tests assert the *current* place sensitive credential input
    // must not be retained: the PIN SecureField in PINSetView.

    func testPINInputClearedBetweenEnterAndConfirmPhase() {
        given("the app is on the login screen") {
            app.launchArguments.append("--test-skip-hub-validation")
            launchClean()
        }
        when("I create a new identity and enter a PIN") {
            let hubInput = find("hub-url-input")
            guard hubInput.waitForExistence(timeout: 20) else {
                XCTFail("Hub URL input should exist")
                return
            }
            typeText("https://test.example.org", into: hubInput)
            dismissKeyboard()

            let createButton = find("create-identity")
            guard createButton.waitForExistence(timeout: 5) else {
                XCTFail("Create identity button should exist")
                return
            }
            createButton.tap()

            let pinInput = find("pin-input")
            guard pinInput.waitForExistence(timeout: 10) else {
                XCTFail("PIN input field should appear after creating a new identity")
                return
            }
            typeText("12345678", into: pinInput)

            let submitButton = find("pin-submit")
            guard submitButton.waitForExistence(timeout: 3) else {
                XCTFail("PIN submit button should exist")
                return
            }
            submitButton.tap()
        }
        then("the PIN field should be cleared for the confirm phase, not retaining the first entry") {
            // PINViewModel.handleSetPIN(.enter) stores the first entry and resets
            // `pin = ""` before moving to `.confirm` — the SecureField is bound to
            // that property, so it must render empty again, not the prior PIN.
            let pinInput = find("pin-input")
            guard pinInput.waitForExistence(timeout: 5) else {
                XCTFail("PIN input field should still be present for the confirm phase")
                return
            }
            let fieldValue = pinInput.value as? String ?? ""
            XCTAssertTrue(
                fieldValue.isEmpty || fieldValue == pinInput.placeholderValue,
                "PIN field should not retain the first entry once the confirm phase begins"
            )
        }
    }

    func testPINInputNotRetainedAfterCancellingIdentityCreation() {
        given("the app is on the login screen") {
            app.launchArguments.append("--test-skip-hub-validation")
            launchClean()
        }
        when("I start creating an identity, enter a PIN, then cancel back to login") {
            let hubInput = find("hub-url-input")
            guard hubInput.waitForExistence(timeout: 20) else {
                XCTFail("Hub URL input should exist")
                return
            }
            typeText("https://test.example.org", into: hubInput)
            dismissKeyboard()

            let createButton = find("create-identity")
            guard createButton.waitForExistence(timeout: 5) else {
                XCTFail("Create identity button should exist")
                return
            }
            createButton.tap()

            let pinInput = find("pin-input")
            guard pinInput.waitForExistence(timeout: 10) else {
                XCTFail("PIN input field should appear after creating a new identity")
                return
            }
            typeText("12345678", into: pinInput)

            // Cancel out via the PIN set screen's back button (PINSetView.swift),
            // returning to the login screen without completing identity creation.
            let backButton = find("back-button")
            guard backButton.waitForExistence(timeout: 5) else {
                XCTFail("Back button should exist on the PIN set screen")
                return
            }
            backButton.tap()
        }
        then("the login screen should be shown again") {
            let createButton = find("create-identity")
            XCTAssertTrue(
                createButton.waitForExistence(timeout: 5),
                "Should return to the login screen after cancelling identity creation"
            )
        }
        and("re-entering identity creation should show an empty PIN field, not the typed PIN") {
            let hubInput = find("hub-url-input")
            guard hubInput.waitForExistence(timeout: 5) else {
                XCTFail("Hub URL input should exist")
                return
            }
            typeText("https://test.example.org", into: hubInput)
            dismissKeyboard()

            let createButton = find("create-identity")
            guard createButton.waitForExistence(timeout: 5) else {
                XCTFail("Create identity button should exist")
                return
            }
            createButton.tap()

            // PINSetView holds its PINViewModel in @State, so navigating back to
            // login and pushing PIN set again creates a fresh view/view-model —
            // the cancelled PIN must not survive the round trip.
            let pinInput = find("pin-input")
            guard pinInput.waitForExistence(timeout: 10) else {
                XCTFail("PIN input field should appear again after re-entering identity creation")
                return
            }
            let fieldValue = pinInput.value as? String ?? ""
            XCTAssertTrue(
                fieldValue.isEmpty || fieldValue == pinInput.placeholderValue,
                "PIN input should not retain the previously typed PIN after cancel"
            )
        }
    }

}
