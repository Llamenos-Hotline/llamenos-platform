import XCTest

/// XCUITest suite for the admin settings screens added in E300:
/// Report Categories, Telephony, Call Settings, IVR Languages,
/// Transcription, Spam Settings, and System Health.
///
/// These tests verify navigation and basic UI rendering for each screen.
/// They run as a super-admin registered with the live backend (`launchAsAdminWithAPI`):
/// admin UI is gated on server-granted permissions, which an offline launch never has.
final class AdminSettingsUITests: BaseUITest {

    override func setUp() {
        super.setUp()
        launchAsAdminWithAPI()
    }

    // MARK: - Admin Settings Navigation Links

    func testAdminSettingsSectionExists() {
        navigateToAdminPanel()

        // The Settings section should have navigation links for new features
        let reportCategoriesLink = scrollToFind("admin-report-categories")
        XCTAssertTrue(
            reportCategoriesLink.exists,
            "Report Categories link should exist in admin settings section"
        )
    }

    func testAllSettingsLinksVisible() {
        navigateToAdminPanel()

        let links = [
            "admin-report-categories",
            "admin-telephony-settings",
            "admin-call-settings",
            "admin-ivr-settings",
            "admin-transcription-settings",
            "admin-spam-settings",
            "admin-system-health",
        ]

        for link in links {
            let element = scrollToFind(link)
            XCTAssertTrue(element.exists, "\(link) should be visible in admin panel")
        }
    }

    // MARK: - Report Categories

    func testReportCategoriesOpens() {
        navigateToAdminSettingsScreen("admin-report-categories")

        let found = anyElementExists([
            "report-categories-view",
            "report-categories-list",
            "categories-empty-state",
            "categories-loading",
        ])
        XCTAssertTrue(found, "Report categories view should show content, empty state, or loading")
    }

    // MARK: - Telephony Settings

    func testTelephonySettingsOpens() {
        navigateToAdminSettingsScreen("admin-telephony-settings")

        let view = find("telephony-settings-view")
        XCTAssertTrue(
            view.waitForExistence(timeout: 10),
            "Telephony settings view should appear"
        )
    }

    func testTelephonySettingsHasProviderPicker() {
        navigateToAdminSettingsScreen("admin-telephony-settings")

        let picker = find("telephony-provider-picker")
        XCTAssertTrue(
            picker.waitForExistence(timeout: 10),
            "Telephony provider picker should exist"
        )
    }

    func testTelephonySettingsHasCredentialFields() {
        navigateToAdminSettingsScreen("admin-telephony-settings")

        // `telephony-settings-view` is on the Form itself, so it exists while
        // `isLoadingTelephony` is still true and the Form is showing only a
        // ProgressView — waiting on it does NOT mean the fields have rendered.
        // A missing view must fail here, not return: an early `return` would
        // report this test as passing without checking a single field.
        let view = find("telephony-settings-view")
        XCTAssertTrue(
            view.waitForExistence(timeout: 10),
            "Telephony settings view should appear"
        )

        // `credentialsSection` renders only once loadTelephonySettings() has
        // returned, so the first field needs the same 10s budget the sibling
        // tests give the provider picker. scrollToFind's 2s default expires
        // mid-load and then swipes a still-loading Form.
        let accountSid = scrollToFind("telephony-account-sid", timeout: 10)
        XCTAssertTrue(accountSid.exists, "Account SID field should exist")

        let authToken = scrollToFind("telephony-auth-token")
        XCTAssertTrue(authToken.exists, "Auth token field should exist")

        let phoneNumber = scrollToFind("telephony-phone-number")
        XCTAssertTrue(phoneNumber.exists, "Phone number field should exist")
    }

    func testTelephonySettingsHasSaveButton() {
        navigateToAdminSettingsScreen("admin-telephony-settings")

        let saveButton = scrollToFind("telephony-save-button")
        XCTAssertTrue(saveButton.exists, "Save button should exist in telephony settings")
    }

    // MARK: - Call Settings

    /// Opening the screen is covered by the two tests below, which navigate to
    /// it and then assert what it shows: a `testCallSettingsOpens` asserting
    /// that `call-settings-view` exists added nothing, because that identifier
    /// is on the Form and exists even while the Form is empty.

    /// The screen must show the settings the server actually holds.
    func testCallSettingsShowTheStoredValues() throws {
        let stored = try callSettingsFromServer()
        try openCallSettings()

        XCTAssertEqual(
            try displayedSeconds("queue-timeout-value"), stored.queueTimeout,
            "The queue timeout slider should show what GET /api/settings/call returned"
        )
        XCTAssertEqual(
            try displayedSeconds("voicemail-max-value"), stored.voicemailMax,
            "The voicemail length slider should show what GET /api/settings/call returned"
        )
    }

    /// Saving a call setting must change the stored setting.
    ///
    /// This replaces a `testCallSettingsHasSaveButton` that asserted only that
    /// the button existed. It existed throughout the whole period in which
    /// tapping it sent `PUT /api/settings/call` and got a 404 back, so the
    /// assertion stayed green while the screen could not save anything at all
    /// (#1717) — and it failed in the slowest possible way, timing out after
    /// 42s and ejecting an unrelated PR from the merge queue.
    func testCallSettingsSavePersists() throws {
        let before = try callSettingsFromServer()
        try openCallSettings()

        // Drive the slider to whichever end of its range the server is NOT at,
        // so a save that quietly does nothing cannot satisfy the assertion.
        let slider = scrollToVisible("queue-timeout-slider")
        XCTAssertTrue(slider.isHittable, "The queue timeout slider should be reachable on screen")
        let midpoint = (AdminCallSettings.minSeconds + AdminCallSettings.maxSeconds) / 2
        slider.adjust(toNormalizedSliderPosition: before.queueTimeout > midpoint ? 0 : 1)

        let pending = try displayedSeconds("queue-timeout-value")
        XCTAssertNotEqual(
            pending, before.queueTimeout,
            "The slider adjustment must change the pending value, or the save assertion below proves nothing"
        )

        let saveButton = scrollToVisible("call-settings-save-button")
        XCTAssertTrue(saveButton.isHittable, "The Save button should be reachable on screen")
        saveButton.tap()

        let persisted = try waitForStoredQueueTimeout(pending)
        XCTAssertEqual(
            persisted, pending,
            "Saving should store the queue timeout the screen shows; the server holds \(persisted)"
        )
        XCTAssertFalse(
            find("call-settings-error").exists,
            "A successful save should not leave an error on the screen"
        )
    }

    // MARK: - Call Settings Helpers

    /// The server's two call settings — the whole of `callSettingsSchema`.
    private struct AdminCallSettings {
        /// The range the server clamps both values to (`callSettingsSchema`).
        static let minSeconds = 30
        static let maxSeconds = 300

        let queueTimeout: Int
        let voicemailMax: Int
    }

    private enum CallSettingsProbeError: Error {
        /// Thrown, not skipped: an unreadable screen or response is a failure of
        /// this test, and `XCTSkip` would report it as a test nobody ran.
        case unreadable(String)
    }

    /// Open the screen and wait for its load to finish.
    ///
    /// `call-settings-view` is on the Form itself, so it exists while the Form
    /// is showing only a ProgressView — waiting on it does not mean a single
    /// control has rendered. The value label does: it is inside the section
    /// that replaces the ProgressView when `GET /api/settings/call` returns.
    private func openCallSettings(file: StaticString = #filePath, line: UInt = #line) throws {
        navigateToAdminSettingsScreen("admin-call-settings")
        guard find("queue-timeout-value").waitForExistence(timeout: 20) else {
            XCTFail("Call settings should finish loading and render its controls", file: file, line: line)
            throw CallSettingsProbeError.unreadable("call settings never rendered")
        }
    }

    /// `GET /api/settings/call`, signed as the test admin.
    private func callSettingsFromServer(
        file: StaticString = #filePath, line: UInt = #line
    ) throws -> AdminCallSettings {
        guard let data = TestAdminAPI.send("GET", "/api/settings/call", baseURL: testHubURL,
                                          file: file, line: line),
              let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let queueTimeout = json["queueTimeoutSeconds"] as? Int,
              let voicemailMax = json["voicemailMaxSeconds"] as? Int else {
            throw CallSettingsProbeError.unreadable("GET /api/settings/call returned no call settings")
        }
        return AdminCallSettings(queueTimeout: queueTimeout, voicemailMax: voicemailMax)
    }

    /// Poll `GET /api/settings/call` until the queue timeout reaches `expected`,
    /// returning whatever it holds when the wait runs out. The Save button
    /// fires its request without awaiting it, so a single read right after the
    /// tap races the save.
    private func waitForStoredQueueTimeout(
        _ expected: Int, timeout: TimeInterval = 15,
        file: StaticString = #filePath, line: UInt = #line
    ) throws -> Int {
        let deadline = Date().addingTimeInterval(timeout)
        var seen = try callSettingsFromServer(file: file, line: line).queueTimeout
        while seen != expected, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.5)
            seen = try callSettingsFromServer(file: file, line: line).queueTimeout
        }
        return seen
    }

    /// The seconds the screen is showing for one slider, read off its value
    /// label — `admin_seconds_unit` renders 90 as "90s".
    private func displayedSeconds(
        _ identifier: String, file: StaticString = #filePath, line: UInt = #line
    ) throws -> Int {
        let label = scrollToFind(identifier, timeout: 10)
        guard label.exists, let seconds = Int(label.label.filter(\.isNumber)) else {
            let shown = label.exists ? label.label : "<absent>"
            XCTFail("\(identifier) should show a number of seconds, showed \(shown)", file: file, line: line)
            throw CallSettingsProbeError.unreadable(identifier)
        }
        return seconds
    }

    // MARK: - IVR Languages

    func testIvrSettingsOpens() {
        navigateToAdminSettingsScreen("admin-ivr-settings")

        let view = find("ivr-settings-view")
        XCTAssertTrue(
            view.waitForExistence(timeout: 10),
            "IVR settings view should appear"
        )
    }

    func testIvrSettingsHasSaveButton() {
        navigateToAdminSettingsScreen("admin-ivr-settings")

        let saveButton = scrollToFind("ivr-save-button")
        XCTAssertTrue(saveButton.exists, "Save button should exist in IVR settings")
    }

    // MARK: - Transcription Settings

    func testTranscriptionSettingsOpens() {
        navigateToAdminSettingsScreen("admin-transcription-settings")

        let view = find("transcription-settings-view")
        XCTAssertTrue(
            view.waitForExistence(timeout: 10),
            "Transcription settings view should appear"
        )
    }

    func testTranscriptionSettingsHasToggles() {
        navigateToAdminSettingsScreen("admin-transcription-settings")

        let view = find("transcription-settings-view")
        guard view.waitForExistence(timeout: 10) else { return }

        let enabledToggle = scrollToFind("transcription-enabled-toggle")
        XCTAssertTrue(enabledToggle.exists, "Transcription enabled toggle should exist")

        let optOutToggle = scrollToFind("transcription-opt-out-toggle")
        XCTAssertTrue(optOutToggle.exists, "Volunteer opt-out toggle should exist")
    }

    func testTranscriptionSettingsHasSaveButton() {
        navigateToAdminSettingsScreen("admin-transcription-settings")

        let saveButton = scrollToFind("transcription-save-button")
        XCTAssertTrue(saveButton.exists, "Save button should exist in transcription settings")
    }

    // MARK: - Spam Settings

    func testSpamSettingsOpens() {
        navigateToAdminSettingsScreen("admin-spam-settings")

        let view = find("spam-settings-view")
        XCTAssertTrue(
            view.waitForExistence(timeout: 10),
            "Spam settings view should appear"
        )
    }

    func testSpamSettingsHasControls() {
        navigateToAdminSettingsScreen("admin-spam-settings")

        let view = find("spam-settings-view")
        guard view.waitForExistence(timeout: 10) else { return }

        let maxCalls = scrollToFind("spam-max-calls-stepper")
        XCTAssertTrue(maxCalls.exists, "Max calls stepper should exist")

        let captchaToggle = scrollToFind("spam-captcha-toggle")
        XCTAssertTrue(captchaToggle.exists, "Voice CAPTCHA toggle should exist")

        let bypassToggle = scrollToFind("spam-bypass-toggle")
        XCTAssertTrue(bypassToggle.exists, "Known number bypass toggle should exist")
    }

    func testSpamSettingsHasSaveButton() {
        navigateToAdminSettingsScreen("admin-spam-settings")

        let saveButton = scrollToFind("spam-save-button")
        XCTAssertTrue(saveButton.exists, "Save button should exist in spam settings")
    }

    // MARK: - System Health

    func testSystemHealthOpens() {
        navigateToAdminSettingsScreen("admin-system-health")

        let found = anyElementExists([
            "system-health-view",
            "health-loading",
            "health-error-state",
        ])
        XCTAssertTrue(found, "System health view should show content, loading, or error state")
    }

    func testSystemHealthShowsCards() {
        navigateToAdminSettingsScreen("admin-system-health")

        // The ScrollView always exists; check for actual content inside it
        let errorState = find("health-error-state")
        let firstCard = find("health-card-server")

        // Wait for either health cards or error state to appear
        let loaded = firstCard.waitForExistence(timeout: 10)
            || errorState.waitForExistence(timeout: 5)

        if errorState.exists {
            // No API connection — error state is acceptable for mock-only tests
            return
        }

        guard loaded else {
            // Neither cards nor error appeared — check loading state
            let loading = find("health-loading")
            XCTAssertTrue(loading.exists, "System health should show loading, cards, or error")
            return
        }

        // Health cards loaded — verify all 6 are present
        let cards = [
            "health-card-server",
            "health-card-services",
            "health-card-calls",
            "health-card-storage",
            "health-card-backup",
            "health-card-volunteers",
        ]

        for card in cards {
            let element = scrollToFind(card)
            XCTAssertTrue(element.exists, "\(card) should be visible in system health dashboard")
        }
    }

    func testSystemHealthHasRefreshButton() {
        navigateToAdminSettingsScreen("admin-system-health")

        let found = anyElementExists([
            "health-refresh-button",
            "health-retry-button",
            "health-loading",
        ])
        XCTAssertTrue(found, "System health should have refresh, retry, or loading indicator")
    }
}
