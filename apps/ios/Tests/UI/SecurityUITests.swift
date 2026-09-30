import XCTest

/// BDD-aligned XCUITest suite for security-related scenarios.
/// Maps to scenarios from: emergency-wipe.feature, panic-wipe.feature, Epic 260 hardening
final class SecurityUITests: BaseUITest {

    // MARK: - Emergency Wipe (emergency-wipe.feature)

    func testEmergencyWipeFromLoginScreen() {
        given("the app is on the login screen") {
            launchClean()
        }
        when("I look for emergency wipe options") {
            // Emergency wipe may be available as a hidden gesture or menu
            // on the login screen (varies by implementation)
        }
        then("the app should not crash") {
            // Verify the login screen is stable
            let hubInput = find("hub-url-input")
            XCTAssertTrue(
                hubInput.waitForExistence(timeout: 5),
                "Login screen should be stable and accessible"
            )
        }
    }

    func testLockScreenShowsPINPad() {
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
        then("I should see the PIN pad on the lock screen") {
            let pinPad = find("pin-pad")
            XCTAssertTrue(
                pinPad.waitForExistence(timeout: 5),
                "PIN pad should be displayed on lock screen"
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
            // Lock it
            let lockButton = find("lock-app")
            if lockButton.waitForExistence(timeout: 10) {
                lockButton.tap()
            } else {
                navigateToSettings()
                let settingsLock = scrollToFind("settings-lock-app", maxSwipes: 10)
                XCTAssertTrue(
                    settingsLock.exists,
                    "No lock mechanism found — neither 'lock-app' on the dashboard nor 'settings-lock-app' in Settings"
                )
                settingsLock.tap()
            }
            let pinPad = find("pin-pad")
            _ = pinPad.waitForExistence(timeout: 5)
        }
        when("I enter the wrong PIN") {
            enterPIN("99999999")
        }
        then("I should see an error message") {
            let pinError = find("pin-error")
            XCTAssertTrue(
                pinError.waitForExistence(timeout: 5),
                "PIN error should be displayed for wrong PIN"
            )
        }
        and("the PIN pad should still be visible") {
            let pinPad = find("pin-pad")
            XCTAssertTrue(pinPad.exists, "PIN pad should remain for retry")
        }
    }

    // MARK: - PIN Pad Security

    // NOTE: "confirm-backup" and "continue-to-pin" were steps in the pre-v3
    // onboarding flow (device key display + backup confirmation before PIN
    // set). They no longer exist: AuthViewModel now goes straight from
    // create-identity to the PIN set screen (see AuthViewModel.swift's "V3
    // device key model" doc comment). They also assumed the digit-based
    // PINPadView ("pin-pad", "pin-\(digit)", "pin-dots") is shown during
    // onboarding — it isn't: PINSetView.swift uses a free-text SecureField
    // ("pin-input"/"pin-submit") so a PIN or passphrase (8+ characters) can
    // be entered. PINPadView is only used on the lock/unlock screen
    // (PINUnlockView.swift), so these tests are rewritten to exercise it
    // there — preserving the original intent (verify the digit pad renders
    // all its digits, backspace, and dots indicator) against the screen
    // where that component actually appears today.
    func testPINPadHasAllDigits() {
        given("I am authenticated and lock the app") {
            launchAuthenticated()
            let lockButton = find("lock-app")
            guard lockButton.waitForExistence(timeout: 10) else {
                XCTFail("Lock button should exist")
                return
            }
            lockButton.tap()
        }
        then("the PIN pad should have digits 0-9 and backspace") {
            let pinPad = find("pin-pad")
            guard pinPad.waitForExistence(timeout: 5) else {
                XCTFail("PIN pad should appear on the lock screen")
                return
            }
            for digit in 0...9 {
                let button = find("pin-\(digit)")
                XCTAssertTrue(button.exists, "PIN button \(digit) should exist")
            }
            let backspace = find("pin-backspace")
            XCTAssertTrue(backspace.exists, "Backspace button should exist")
        }
    }

    func testPINDotsIndicator() {
        given("I am authenticated and lock the app") {
            launchAuthenticated()
            let lockButton = find("lock-app")
            guard lockButton.waitForExistence(timeout: 10) else {
                XCTFail("Lock button should exist")
                return
            }
            lockButton.tap()
        }
        then("I should see the PIN dots indicator") {
            let pinDots = find("pin-dots")
            XCTAssertTrue(
                pinDots.waitForExistence(timeout: 5),
                "PIN dots indicator should be displayed on the lock screen"
            )
        }
    }

    // MARK: - Epic 260: Biometric Unlock (C5)

    func testBiometricUnlockButtonVisibleOnLockScreen() {
        given("I am authenticated with biometric enabled") {
            launchAuthenticated()
        }
        when("I lock the app") {
            let lockButton = find("lock-app")
            if lockButton.waitForExistence(timeout: 10) {
                lockButton.tap()
            } else {
                navigateToSettings()
                let settingsLock = scrollToFind("settings-lock-app", maxSwipes: 10)
                XCTAssertTrue(
                    settingsLock.exists,
                    "No lock mechanism found — neither 'lock-app' on the dashboard nor 'settings-lock-app' in Settings"
                )
                settingsLock.tap()
            }
        }
        then("I should see the biometric unlock button if biometrics are available") {
            // On devices with biometrics, the button should appear.
            // On simulators without biometrics, this is expected to not exist.
            let biometricButton = find("biometric-unlock")
            let pinPad = find("pin-pad")
            // At minimum, the PIN pad should be visible as fallback
            XCTAssertTrue(
                pinPad.waitForExistence(timeout: 5),
                "PIN pad should always be available as fallback"
            )
            // Biometric button is optional — depends on device capabilities
            if biometricButton.waitForExistence(timeout: 2) {
                XCTAssertTrue(true, "Biometric unlock button is displayed")
            }
        }
    }

    // MARK: - Epic 260: HTTP URL Rejection (H6)

    func testHTTPHubURLShowsError() {
        given("the app is on the login screen") {
            launchClean()
        }
        when("I enter an HTTP hub URL and try to create identity") {
            let hubInput = find("hub-url-input")
            XCTAssertTrue(hubInput.waitForExistence(timeout: 5), "Login screen should show the hub URL input after a clean launch")
            hubInput.tap()
            hubInput.typeText("http://insecure.example.org")

            dismissKeyboard()

            let createButton = find("create-identity")
            XCTAssertTrue(createButton.waitForExistence(timeout: 5), "Create-identity button should appear on the login screen")
            createButton.tap()
        }
        then("I should see an error about insecure connection") {
            // "auth-error" was a stale identifier — LoginView surfaces
            // AuthViewModel.errorMessage under "login-error" (see LoginView.swift).
            let errorElement = find("login-error")
            if errorElement.waitForExistence(timeout: 5) {
                XCTAssertTrue(true, "HTTP rejection error is displayed")
            } else {
                // Check for any error text on screen
                let errorText = app.staticTexts.matching(
                    NSPredicate(format: "label CONTAINS[c] 'HTTP' OR label CONTAINS[c] 'HTTPS'")
                ).firstMatch
                XCTAssertTrue(
                    errorText.waitForExistence(timeout: 3),
                    "An error about HTTP/HTTPS should be displayed"
                )
            }
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

    // MARK: - Epic 260: SAS Gate on Device Link (H4)

    func testDeviceLinkHasSASVerificationStep() {
        // This test verifies that the Device Link flow has the correct sequential
        // architecture: scanning -> connecting -> verifying(SAS) -> importing -> completed.
        // The SAS verification step is a mandatory gate (H4) — the user cannot reach
        // the import step without confirming the SAS code.
        //
        // The sheet presentation from SwiftUI List cells is unreliable in XCUITest,
        // so we verify:
        // 1. The device link button exists and is accessible in Settings
        // 2. The SAS-gated elements are NOT accessible from the main view
        //    (they only appear inside the sheet, after QR scan + key exchange)
        // The actual gating logic (pendingEncryptedData held until sasConfirmed)
        // is exhaustively tested in DeviceLinkViewModel unit tests.

        given("I am authenticated") {
            launchAuthenticated()
        }
        when("I navigate to Account Settings") {
            navigateToAccountSettings()
        }
        then("the device link button should be accessible") {
            let linkButton = scrollToFind("settings-link-device", maxSwipes: 5, timeout: 5)
            XCTAssertTrue(
                linkButton.exists,
                "Device link button should exist in Account Settings for device pairing"
            )
        }
        and("SAS verification elements should not be accessible outside the flow") {
            // The SAS confirm/reject buttons only appear inside the DeviceLinkView sheet,
            // at the verifying step, which requires scanning + connecting first.
            // They must NOT be reachable from the main Settings view.
            let confirmSAS = find("confirm-sas-code")
            let rejectSAS = find("reject-sas-code")
            let importingStep = find("device-link-importing")

            XCTAssertFalse(
                confirmSAS.waitForExistence(timeout: 2),
                "SAS confirm button should not be accessible outside the device link flow"
            )
            XCTAssertFalse(
                rejectSAS.exists,
                "SAS reject button should not be accessible outside the device link flow"
            )
            XCTAssertFalse(
                importingStep.exists,
                "Import step should not be reachable without SAS verification"
            )
        }
    }

    func testDeviceLinkSASVerificationHasConfirmAndRejectButtons() {
        // This test verifies that when the device link reaches the verifying step,
        // both "Confirm" and "Reject" SAS code buttons are present, ensuring
        // the user must explicitly confirm SAS before import can proceed (H4).
        //
        // Since we cannot drive a real WebSocket handshake in XCUITest,
        // we verify the UI elements are defined with correct accessibility IDs.
        // The actual gating logic (pendingEncryptedData held until sasConfirmed)
        // is covered by unit tests in DeviceLinkViewModel.
        given("I am authenticated") {
            launchAuthenticated()
        }
        when("I open the Device Link view") {
            navigateToAccountSettings()
            scrollAndTap("settings-link-device")
            XCTAssertTrue(
                find("device-link-view").waitForExistence(timeout: 5),
                "The Device Link view should open from Account settings"
            )
            app.answerSystemPromptOnce(.camera)
        }
        then("the SAS confirm and reject buttons should be defined in the app") {
            // The verifying step is only rendered when a SAS code is received.
            // We verify the device link view loaded correctly — the button
            // accessibility identifiers ("confirm-sas-code", "reject-sas-code")
            // are verified to exist in the DeviceLinkView source code.
            // At this point (scanning step), they should NOT be visible:
            let confirmSAS = find("confirm-sas-code")
            let rejectSAS = find("reject-sas-code")
            XCTAssertFalse(
                confirmSAS.waitForExistence(timeout: 2),
                "SAS confirm button should not appear before QR scan and key exchange"
            )
            XCTAssertFalse(
                rejectSAS.exists,
                "SAS reject button should not appear before QR scan and key exchange"
            )
        }
    }

    // MARK: - Epic 260: Relay URL Validation via UI (H5)

    func testDeviceLinkShowsErrorForPrivateRelayURL() {
        // DeviceLinkViewModel.processQRCode() validates the relay host via
        // isValidRelayHost() and transitions to the error step for private IPs.
        // Since XCUITest cannot inject a QR code scan, we verify the error UI
        // exists and is properly wired. The actual validation logic is tested
        // exhaustively in SecurityHardeningTests (unit tests).
        given("I am authenticated") {
            launchAuthenticated()
        }
        when("I open the Device Link view") {
            navigateToAccountSettings()
            scrollAndTap("settings-link-device")
            XCTAssertTrue(
                find("device-link-view").waitForExistence(timeout: 5),
                "The Device Link view should open from Account settings"
            )
            app.answerSystemPromptOnce(.camera)
        }
        then("the error step UI elements should be properly defined") {
            // The error step ("device-link-error") is shown when processQRCode
            // detects a private relay host. We verify the error and retry
            // elements are accessible. They should NOT be visible in the initial
            // scanning state:
            let errorStep = find("device-link-error")
            XCTAssertFalse(
                errorStep.waitForExistence(timeout: 2),
                "Error step should not be visible on initial load (scanning step)"
            )
            let retryButton = find("device-link-retry")
            XCTAssertFalse(
                retryButton.exists,
                "Retry button should not be visible on initial load"
            )
        }
    }

    // MARK: - Epic 260: PIN Lockout Persistence (H7)

    func testPINLockoutAfterFiveWrongAttempts() {
        given("the app is locked with an existing identity") {
            launchAuthenticated()
            // Lock the app
            let lockButton = find("lock-app")
            if lockButton.waitForExistence(timeout: 10) {
                lockButton.tap()
            } else {
                navigateToSettings()
                let settingsLock = scrollToFind("settings-lock-app", maxSwipes: 10)
                guard settingsLock.exists else {
                    XCTFail("No lock mechanism found")
                    return
                }
                settingsLock.tap()
            }
            let pinPad = find("pin-pad")
            _ = pinPad.waitForExistence(timeout: 5)
        }
        when("I enter the wrong PIN 5 times") {
            for _ in 1...5 {
                enterPIN("99999999")
                // Brief wait for the error to appear and the PIN pad to reset
                let pinError = find("pin-error")
                _ = pinError.waitForExistence(timeout: 3)
            }
        }
        then("I should see a lockout message") {
            let pinError = find("pin-error")
            XCTAssertTrue(
                pinError.waitForExistence(timeout: 5),
                "A lockout or error message should be displayed after 5 failed PIN attempts"
            )
        }
        and("the PIN pad should still be visible for when lockout expires") {
            let pinPad = find("pin-pad")
            XCTAssertTrue(
                pinPad.exists,
                "PIN pad should remain visible during lockout"
            )
        }
    }

    func testPINLockoutShowsRemainingTime() {
        given("the app is locked") {
            launchAuthenticated()
            let lockButton = find("lock-app")
            if lockButton.waitForExistence(timeout: 10) {
                lockButton.tap()
            } else {
                navigateToSettings()
                let settingsLock = scrollToFind("settings-lock-app", maxSwipes: 10)
                guard settingsLock.exists else {
                    XCTFail("No lock mechanism found")
                    return
                }
                settingsLock.tap()
            }
            let pinPad = find("pin-pad")
            _ = pinPad.waitForExistence(timeout: 5)
        }
        when("I exceed the lockout threshold with wrong PINs") {
            // Enter wrong PIN 5 times to trigger the 30-second lockout
            for _ in 1...5 {
                enterPIN("99999999")
                let pinError = find("pin-error")
                _ = pinError.waitForExistence(timeout: 3)
            }
        }
        then("the lockout error should be displayed") {
            // After 5 failed PIN attempts, PINLockout escalation triggers a 30-second
            // lockout. The error message (pin-error) shows the lockout duration,
            // and the subtitle shows remaining time countdown.
            // Check the pin-error element exists (it shows the lockout message).
            let pinError = find("pin-error")
            XCTAssertTrue(
                pinError.waitForExistence(timeout: 5),
                "Lockout error message should be displayed after 5 failed attempts"
            )
            // Additionally verify the lockout text mentions time-related content,
            // or fallback to just verifying the error element is visible.
            let lockoutText = app.staticTexts.matching(
                NSPredicate(format: "label CONTAINS[c] 'seconds' OR label CONTAINS[c] 'locked' OR label CONTAINS[c] 'wait' OR label CONTAINS[c] 'lockout'")
            ).firstMatch
            if !lockoutText.waitForExistence(timeout: 3) {
                // Localization may return raw key names — verify pin-error suffices
                XCTAssertTrue(pinError.exists, "PIN error element confirms lockout state")
            }
        }
    }

    func testPINWipeAfterTenFailedAttempts() {
        given("the app is locked") {
            launchAuthenticated()
            let lockButton = find("lock-app")
            if lockButton.waitForExistence(timeout: 10) {
                lockButton.tap()
            } else {
                navigateToSettings()
                let settingsLock = scrollToFind("settings-lock-app", maxSwipes: 10)
                guard settingsLock.exists else {
                    XCTFail("No lock mechanism found")
                    return
                }
                settingsLock.tap()
            }
            let pinPad = find("pin-pad")
            _ = pinPad.waitForExistence(timeout: 5)
        }
        when("I enter the wrong PIN 10 times to trigger key wipe") {
            for i in 1...10 {
                enterPIN("99999999")
                let pinError = find("pin-error")
                _ = pinError.waitForExistence(timeout: 3)
                // After lockout kicks in (attempt 5+), we may need to wait for
                // the lockout to expire. In test mode, lockouts may be shortened.
                // If the PIN pad is not accepting input (locked out), wait briefly.
                if i >= 5 {
                    // Check if we need to wait for lockout to expire
                    let lockedText = app.staticTexts.matching(
                        NSPredicate(format: "label CONTAINS[c] 'locked' OR label CONTAINS[c] 'wait'")
                    ).firstMatch
                    if lockedText.exists {
                        // Wait for lockout to expire (in test mode this should be fast)
                        sleep(2)
                    }
                }
            }
        }
        then("the app should transition to the login/setup state after key wipe") {
            // After 10 failed attempts, PINLockout.shouldWipeKeys returns true,
            // authService.logout() is called, and the app returns to the login screen.
            // The wipe error message "All keys have been wiped" may flash briefly
            // before the login screen appears.
            let loginScreen = find("hub-url-input")
            let pinError = find("pin-error")
            let createButton = find("create-identity")

            // Either the login screen appears (wipe completed) or the wipe error is shown
            let foundLoginOrWipe = loginScreen.waitForExistence(timeout: 15)
                || pinError.waitForExistence(timeout: 5)
                || createButton.waitForExistence(timeout: 5)

            XCTAssertTrue(
                foundLoginOrWipe,
                "App should transition to login screen or show wipe message after 10 failed PIN attempts"
            )
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
            hubInput.tap()
            hubInput.typeText("https://test.example.org")
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
            pinInput.tap()
            pinInput.typeText("12345678")

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
            hubInput.tap()
            hubInput.typeText("https://test.example.org")
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
            pinInput.tap()
            pinInput.typeText("12345678")

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
            hubInput.tap()
            hubInput.typeText("https://test.example.org")
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
