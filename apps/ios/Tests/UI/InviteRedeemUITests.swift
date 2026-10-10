import XCTest

/// E2E coverage for invite-code onboarding on iOS (#1046), against the
/// scenarios "Admin creates invite and volunteer completes onboarding" and
/// "Invalid invite code shows error" in
/// `packages/test-specs/features/core/auth-login.feature`.
///
/// The redeem path is the one this file exists to prove: the app signs
/// `POST /api/invites/redeem` with the freshly generated device key
/// (nonce-less Ed25519 token) immediately after PIN set, and only then lands
/// on the dashboard. Requires the Docker Compose backend at TEST_HUB_URL
/// (default http://127.0.0.1:3000).
final class InviteRedeemUITests: BaseUITest {

    /// Create an invite in this class's hub via the signed admin API and
    /// return its code. Fails the test when the server does not answer 2xx
    /// with `{invite: {code}}`.
    private func createInviteViaAPI(
        name: String = "E2E Redeemer",
        file: StaticString = #filePath, line: UInt = #line
    ) -> String {
        let data = TestAdminAPI.send("POST", "/api/invites", [
            "name": name,
            "phone": "+15555550124",
            "roleIds": ["role-volunteer"],
            "hubId": testHubId,
        ], baseURL: testHubURL, file: file, line: line)
        guard let data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let invite = json["invite"] as? [String: Any],
              let code = invite["code"] as? String else {
            XCTFail("Invite creation should return {invite: {code}}", file: file, line: line)
            return ""
        }
        return code
    }

    /// Clean launch for interactive onboarding. `--test-skip-hub-validation`
    /// skips the `/api/health` connectivity pre-flight — the native test
    /// backend deliberately runs without storage, so /api/health answers 503
    /// while every route these tests exercise (validate, redeem) works. The
    /// invite validation and redemption calls still hit the real server.
    private func launchForOnboarding() {
        app.launchArguments.append(contentsOf: ["--reset-keychain", "--test-skip-hub-validation"])
        app.launchAnsweringSystemPrompts()
    }

    /// Type hub URL + invite code into the login form and tap Create New
    /// Identity, leaving the app on the PIN set screen (or on an error).
    private func beginOnboarding(hubURL: String, inviteCode: String) {
        let hubURLInput = find("hub-url-input")
        guard hubURLInput.waitForExistence(timeout: 10) else {
            XCTFail("Login screen should show the hub URL field")
            return
        }
        hubURLInput.tap()
        hubURLInput.typeText(hubURL)

        let inviteInput = find("invite-code-input")
        guard inviteInput.waitForExistence(timeout: 5) else {
            XCTFail("Login screen should show the invite code field")
            return
        }
        inviteInput.tap()
        inviteInput.typeText(inviteCode)
        dismissKeyboard()

        let createButton = find("create-identity")
        guard createButton.waitForExistence(timeout: 5) else {
            XCTFail("Create identity button should exist")
            return
        }
        createButton.tap()
    }

    /// Enter + confirm the PIN on PINSetView.
    private func setPIN(_ pin: String) {
        let pinInput = find("pin-input")
        let submitButton = find("pin-submit")
        for phase in 0...1 {
            guard pinInput.waitForExistence(timeout: 10) else {
                XCTFail("PIN field should appear (entry phase \(phase))")
                return
            }
            pinInput.tap()
            pinInput.typeText(pin)
            guard submitButton.waitForExistence(timeout: 5) else {
                XCTFail("PIN submit button should exist (entry phase \(phase))")
                return
            }
            submitButton.tap()
        }
    }

    func testAdminCreatesInviteAndVolunteerCompletesOnboarding() {
        var inviteCode = ""
        given("an invite created by an admin via the API") {
            inviteCode = createInviteViaAPI()
        }
        when("the volunteer onboards with that invite code") {
            launchForOnboarding()
            beginOnboarding(hubURL: testHubURL, inviteCode: inviteCode)
            setPIN("12345678")
        }
        then("the invite redeems and they arrive at the dashboard") {
            let dashboard = find("dashboard-title")
            XCTAssertTrue(
                dashboard.waitForExistence(timeout: 30),
                "Volunteer should reach the dashboard after invite redemption"
            )
            // Only meaningful once the dashboard is up — an enrollment failure
            // would have left the retry/skip UI on the PIN screen instead.
            XCTAssertFalse(
                find("enroll-error").exists,
                "Redemption of a fresh invite should succeed"
            )
            XCTAssertFalse(
                find("invite-error").exists,
                "A freshly created invite should validate"
            )
        }
    }

    func testInvalidInviteCodeShowsError() {
        given("the login screen") {
            launchForOnboarding()
        }
        when("I enter an invite code that is not a code at all") {
            beginOnboarding(hubURL: testHubURL, inviteCode: "not-a-real-code")
        }
        then("I should see an invalid invite error and stay on the login screen") {
            let inviteError = find("invite-error")
            XCTAssertTrue(
                inviteError.waitForExistence(timeout: 10),
                "An unparseable invite code should show the invite error"
            )
            // Local parse failure — no network round-trip, no PIN screen.
            XCTAssertFalse(
                find("pin-input").waitForExistence(timeout: 3),
                "An invalid invite code must not advance to PIN set"
            )
        }
    }
}
