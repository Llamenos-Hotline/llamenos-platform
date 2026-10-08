import XCTest

/// XCUITest suite for the admin settings screens: Report Categories,
/// Telephony, Call Settings, IVR Languages, Transcription, Spam Settings and
/// System Health.
///
/// They run as a super-admin registered with the live backend
/// (`launchAsAdminWithAPI`): admin UI is gated on server-granted permissions,
/// which an offline launch never has.
///
/// The telephony, IVR, transcription and spam screens each had a
/// `…HasSaveButton` test asserting that the button existed. All four were green
/// for the entire period in which those screens could not save anything at all:
/// each sent `PUT` to a path the server either does not mount at all
/// (`/api/settings/telephony`) or mounts only under `PATCH`, and each sent a
/// body naming fields no schema declares. The button rendered, was tappable,
/// and did nothing. They are replaced here by save-and-read-back tests, which
/// change a setting, save, then poll the API and assert the server stores what
/// the screen shows (#1724).
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

    /// The screen must show the provider configuration the server holds.
    func testTelephonySettingsShowTheStoredProvider() throws {
        let stored = try storedTelephony()
        try openAdminScreen("admin-telephony-settings", renderedWhenLoaded: "telephony-phone-number")

        XCTAssertEqual(
            try fieldText("telephony-phone-number"), stored["phoneNumber"] as? String ?? "",
            "The phone number field should show what GET /api/settings/telephony-provider returned"
        )
        XCTAssertFalse(
            find("telephony-settings-error").exists,
            "Loading a configured provider should not leave an error on the screen"
        )
    }

    /// Saving the telephony provider must change what the server stores.
    ///
    /// Replaces `testTelephonySettingsHasSaveButton`. The old test could not
    /// have caught any of this: the screen read and wrote
    /// `/api/settings/telephony`, which answers 404 on every verb — the server
    /// mounts `/api/settings/telephony-provider` for the read and
    /// `POST /api/provider-setup/configure` for the write, which is also the
    /// only write path, since `PATCH /api/settings/telephony-provider` answers
    /// 400 "updateTelephonyProvider is deprecated".
    func testTelephonySaveStoresTheProvider() throws {
        try openAdminScreen("admin-telephony-settings", renderedWhenLoaded: "telephony-phone-number")

        // A value the server cannot already be holding, so a save that quietly
        // does nothing cannot satisfy the assertion below.
        let wanted = "+1555\(Int(Date().timeIntervalSince1970) % 1_000_000)"
        try replaceFieldText("telephony-phone-number", with: wanted)
        XCTAssertEqual(
            try fieldText("telephony-phone-number"), wanted,
            "The phone number field must hold the new value, or the save assertion proves nothing"
        )

        tapSave("telephony-save-button")

        let persisted = try waitForStored(
            "/api/settings/telephony-provider", key: "phoneNumber", toEqual: wanted
        )
        XCTAssertEqual(
            persisted, wanted,
            "Saving should store the phone number the screen shows; the server holds \(persisted ?? "nothing")"
        )
        XCTAssertFalse(
            find("telephony-settings-error").exists,
            "A successful save should not leave an error on the screen"
        )
    }

    // MARK: - Call Settings

    func testCallSettingsOpens() {
        navigateToAdminSettingsScreen("admin-call-settings")

        let view = find("call-settings-view")
        XCTAssertTrue(
            view.waitForExistence(timeout: 10),
            "Call settings view should appear"
        )
    }

    func testCallSettingsHasSliders() {
        navigateToAdminSettingsScreen("admin-call-settings")

        let view = find("call-settings-view")
        guard view.waitForExistence(timeout: 10) else { return }

        let ringTimeout = scrollToFind("ring-timeout-slider")
        XCTAssertTrue(ringTimeout.exists, "Ring timeout slider should exist")

        let maxDuration = scrollToFind("max-duration-slider")
        XCTAssertTrue(maxDuration.exists, "Max duration slider should exist")

        let parallelRing = scrollToFind("parallel-ring-slider")
        XCTAssertTrue(parallelRing.exists, "Parallel ring slider should exist")
    }

    func testCallSettingsHasSaveButton() {
        navigateToAdminSettingsScreen("admin-call-settings")

        let saveButton = scrollToFind("call-settings-save-button")
        XCTAssertTrue(saveButton.exists, "Save button should exist in call settings")
    }

    // MARK: - IVR Languages

    /// The screen must show the language order the server holds — the order is
    /// a setting in its own right, since position decides the keypad digit.
    func testIvrSettingsShowTheStoredLanguageOrder() throws {
        let stored = try storedIvrLanguages()
        try openAdminScreen("admin-ivr-settings", renderedWhenLoaded: "ivr-enabled-order")

        XCTAssertEqual(
            try labelText("ivr-enabled-order"), stored.joined(separator: ","),
            "The screen should show the languages GET /api/settings/ivr-languages returned, in order"
        )
    }

    /// Enabling a language and saving must change what the server stores.
    ///
    /// Replaces `testIvrSettingsHasSaveButton`. Two defects stood behind that
    /// green assertion: the save went to `PUT /api/settings/ivr-languages`
    /// (404), and the body was a `{"languages": {code: bool}}` map, which the
    /// verb the server does mount rejects with 400 "expected array, received
    /// undefined" at `enabledLanguages`.
    func testIvrSaveStoresTheEnabledLanguages() throws {
        let before = try storedIvrLanguages()
        try openAdminScreen("admin-ivr-settings", renderedWhenLoaded: "ivr-enabled-order")

        // A language the server does not currently have enabled, so a save that
        // stores nothing cannot satisfy the assertion. "de" is in
        // `LANGUAGE_CODES`, so the route accepts it.
        let added = ["de", "pt", "hi"].first { !before.contains($0) }
        let wanted: [String]
        if let added {
            toggleOn("ivr-language-\(added)")
            wanted = before + [added]
        } else {
            // Every candidate is already on: turn one off instead.
            let removed = try XCTUnwrap(before.last, "the hub should have at least one IVR language")
            toggleOff("ivr-language-\(removed)")
            wanted = before.filter { $0 != removed }
        }

        XCTAssertEqual(
            try labelText("ivr-enabled-order"), wanted.joined(separator: ","),
            "The toggle must change the pending order, or the save assertion proves nothing"
        )

        tapSave("ivr-save-button")

        let persisted = try waitForStoredIvrLanguages(wanted)
        XCTAssertEqual(
            persisted, wanted,
            "Saving should store the languages the screen shows; the server holds \(persisted)"
        )
        XCTAssertFalse(
            find("ivr-settings-error").exists,
            "A successful save should not leave an error on the screen"
        )
    }

    // MARK: - Transcription Settings

    /// The screen must show the settings the server holds.
    func testTranscriptionSettingsShowTheStoredValues() throws {
        let stored = try settingsJSON("/api/settings/transcription")
        try openAdminScreen(
            "admin-transcription-settings", renderedWhenLoaded: "transcription-enabled-toggle"
        )

        XCTAssertEqual(
            try switchValue("transcription-enabled-toggle"), stored["globalEnabled"] as? Bool,
            "The transcription switch should show what GET /api/settings/transcription returned"
        )
        XCTAssertEqual(
            try switchValue("transcription-opt-out-toggle"), stored["allowUserOptOut"] as? Bool,
            "The opt-out switch should show what GET /api/settings/transcription returned"
        )
    }

    /// Turning transcription on or off and saving must change what the server
    /// stores.
    ///
    /// Replaces `testTranscriptionSettingsHasSaveButton`. The save went to
    /// `PUT /api/settings/transcription` (404) carrying `{enabled,
    /// allowVolunteerOptOut}` — neither of which is a field
    /// `transcriptionSettingsSchema` declares.
    func testTranscriptionSaveStoresTheGlobalSetting() throws {
        let before = try settingsJSON("/api/settings/transcription")
        let wanted = !(before["globalEnabled"] as? Bool ?? true)

        try openAdminScreen(
            "admin-transcription-settings", renderedWhenLoaded: "transcription-enabled-toggle"
        )
        setSwitch("transcription-enabled-toggle", to: wanted)
        XCTAssertEqual(
            try switchValue("transcription-enabled-toggle"), wanted,
            "The switch must change, or the save assertion below proves nothing"
        )

        tapSave("transcription-save-button")

        let persisted = try waitForStored(
            "/api/settings/transcription", key: "globalEnabled", toEqual: wanted
        )
        XCTAssertEqual(
            persisted, Self.describe(wanted),
            "Saving should store the transcription setting the screen shows; the server holds \(persisted ?? "nothing")"
        )
        XCTAssertFalse(
            find("transcription-settings-error").exists,
            "A successful save should not leave an error on the screen"
        )
    }

    // MARK: - Spam Settings

    /// The screen must show the settings the server holds.
    func testSpamSettingsShowTheStoredValues() throws {
        let stored = try settingsJSON("/api/settings/spam")
        try openAdminScreen("admin-spam-settings", renderedWhenLoaded: "spam-max-calls-value")

        XCTAssertEqual(
            try numberLabel("spam-max-calls-value"), stored["maxCallsPerMinute"] as? Int,
            "The rate limit should show what GET /api/settings/spam returned"
        )
        XCTAssertEqual(
            try numberLabel("spam-block-duration-value"), stored["blockDurationMinutes"] as? Int,
            "The block duration should show what GET /api/settings/spam returned"
        )
        XCTAssertEqual(
            try switchValue("spam-captcha-toggle"), stored["voiceCaptchaEnabled"] as? Bool,
            "The CAPTCHA switch should show what GET /api/settings/spam returned"
        )
    }

    /// Raising the rate limit and saving must change what the server stores.
    ///
    /// Replaces `testSpamSettingsHasSaveButton`. The save went to
    /// `PUT /api/settings/spam` (404) carrying `maxCallsPerHour` and
    /// `knownNumberBypass`: the server's limit is per *minute*, and it has no
    /// known-number bypass at all.
    func testSpamSaveStoresTheRateLimit() throws {
        let before = try settingsJSON("/api/settings/spam")
        let stored = try XCTUnwrap(
            before["maxCallsPerMinute"] as? Int, "GET /api/settings/spam returned no rate limit"
        )

        try openAdminScreen("admin-spam-settings", renderedWhenLoaded: "spam-max-calls-value")
        incrementStepper("spam-max-calls-stepper", times: 2)

        let pending = try numberLabel("spam-max-calls-value")
        XCTAssertEqual(
            pending, stored + 2,
            "The stepper must raise the pending rate limit, or the save assertion proves nothing"
        )

        tapSave("spam-save-button")

        let persisted = try waitForStored(
            "/api/settings/spam", key: "maxCallsPerMinute", toEqual: stored + 2
        )
        XCTAssertEqual(
            persisted, Self.describe(stored + 2),
            "Saving should store the rate limit the screen shows; the server holds \(persisted ?? "nothing")"
        )
        XCTAssertFalse(
            find("spam-settings-error").exists,
            "A successful save should not leave an error on the screen"
        )
    }


    // MARK: - Settings Probe Helpers
    //
    // Shared by the four save-and-read-back tests above. They read the real API
    // signed as the test admin, the same way `tests/api-helpers.ts` does for
    // desktop, so each test asserts what the server stores rather than what the
    // screen was asked to show.

    private enum SettingsProbeError: Error {
        /// Thrown, not skipped: an unreadable screen or response is a failure of
        /// the test, and `XCTSkip` would report it as a test nobody ran.
        case unreadable(String)
    }

    /// One admin settings route's JSON, signed as the test admin.
    private func settingsJSON(
        _ path: String, file: StaticString = #filePath, line: UInt = #line
    ) throws -> [String: Any] {
        guard let data = TestAdminAPI.send("GET", path, baseURL: testHubURL, file: file, line: line),
              let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw SettingsProbeError.unreadable("GET \(path) returned no JSON object")
        }
        return json
    }

    /// `GET /api/settings/telephony-provider`, which answers a bare `null` when
    /// no provider is configured — an empty dictionary here, not a failure.
    private func storedTelephony(
        file: StaticString = #filePath, line: UInt = #line
    ) throws -> [String: Any] {
        guard let data = TestAdminAPI.send(
            "GET", "/api/settings/telephony-provider", baseURL: testHubURL, file: file, line: line
        ) else {
            throw SettingsProbeError.unreadable("GET /api/settings/telephony-provider failed")
        }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    private func storedIvrLanguages(
        file: StaticString = #filePath, line: UInt = #line
    ) throws -> [String] {
        guard let languages = try settingsJSON(
            "/api/settings/ivr-languages", file: file, line: line
        )["enabledLanguages"] as? [String] else {
            throw SettingsProbeError.unreadable("GET /api/settings/ivr-languages returned no list")
        }
        return languages
    }

    /// Poll one key of one settings route until it reads as `expected`,
    /// returning whatever it holds when the wait runs out. The Save buttons fire
    /// their request without awaiting it, so a single read right after the tap
    /// races the save.
    ///
    /// Values are compared as strings rather than through `AnyHashable`:
    /// `JSONSerialization` hands back `NSNumber` for both integers and booleans,
    /// and a comparison that silently never matches would turn every one of
    /// these tests into a 15-second wait followed by a confusing failure.
    private func waitForStored(
        _ path: String, key: String, toEqual expected: Any,
        timeout: TimeInterval = 15, file: StaticString = #filePath, line: UInt = #line
    ) throws -> String? {
        let wanted = Self.describe(expected)
        let deadline = Date().addingTimeInterval(timeout)
        var seen = Self.describe(try settingsJSON(path, file: file, line: line)[key])
        while seen != wanted, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.5)
            seen = Self.describe(try settingsJSON(path, file: file, line: line)[key])
        }
        return seen
    }

    /// A stable string for a JSON scalar, bridging `NSNumber` booleans and
    /// integers to the same spelling Swift's own `Bool`/`Int` produce.
    private static func describe(_ value: Any?) -> String? {
        switch value {
        case let bool as Bool: return bool ? "true" : "false"
        case let int as Int: return String(int)
        case let string as String: return string
        case let number as NSNumber:
            return CFGetTypeID(number) == CFBooleanGetTypeID()
                ? (number.boolValue ? "true" : "false")
                : String(number.intValue)
        default: return nil
        }
    }

    private func waitForStoredIvrLanguages(
        _ expected: [String], timeout: TimeInterval = 15,
        file: StaticString = #filePath, line: UInt = #line
    ) throws -> [String] {
        let deadline = Date().addingTimeInterval(timeout)
        var seen = try storedIvrLanguages(file: file, line: line)
        while seen != expected, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.5)
            seen = try storedIvrLanguages(file: file, line: line)
        }
        return seen
    }

    // MARK: - Screen Helpers

    /// Open one admin settings screen and wait until it has finished loading.
    ///
    /// `renderedWhenLoaded` must be an identifier inside the section that
    /// replaces the ProgressView, never the Form's own identifier: every one of
    /// these screens puts its `…-settings-view` identifier on the Form, so that
    /// identifier exists while the Form is still empty.
    private func openAdminScreen(
        _ link: String, renderedWhenLoaded: String,
        file: StaticString = #filePath, line: UInt = #line
    ) throws {
        navigateToAdminSettingsScreen(link)
        guard find(renderedWhenLoaded).waitForExistence(timeout: 20) else {
            XCTFail("\(link) should finish loading and render its controls", file: file, line: line)
            throw SettingsProbeError.unreadable("\(link) never rendered")
        }
    }

    /// Scroll the Save button into view and tap it, asserting it was reachable —
    /// a `scrollToFind` hit on an off-screen button is not tappable, and the
    /// tap would silently do nothing.
    private func tapSave(_ identifier: String, file: StaticString = #filePath, line: UInt = #line) {
        let button = scrollToVisible(identifier)
        XCTAssertTrue(button.isHittable, "\(identifier) should be reachable on screen",
                      file: file, line: line)
        button.tap()
    }

    /// A text field's current contents.
    private func fieldText(
        _ identifier: String, file: StaticString = #filePath, line: UInt = #line
    ) throws -> String {
        let field = app.textFields[identifier].firstMatch
        guard field.waitForExistence(timeout: 10) else {
            XCTFail("\(identifier) should be a text field on screen", file: file, line: line)
            throw SettingsProbeError.unreadable(identifier)
        }
        // An empty SwiftUI TextField reports its placeholder as `value`.
        let value = field.value as? String ?? ""
        return value == field.placeholderValue ? "" : value
    }

    /// Clear a text field and type `text` into it.
    private func replaceFieldText(
        _ identifier: String, with text: String,
        file: StaticString = #filePath, line: UInt = #line
    ) throws {
        let field = scrollToVisible(identifier)
        guard field.exists, field.isHittable else {
            XCTFail("\(identifier) should be reachable on screen", file: file, line: line)
            throw SettingsProbeError.unreadable(identifier)
        }
        field.tap()
        let existing = try fieldText(identifier, file: file, line: line)
        if !existing.isEmpty {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count))
        }
        field.typeText(text)
    }

    /// A static text's label.
    private func labelText(
        _ identifier: String, file: StaticString = #filePath, line: UInt = #line
    ) throws -> String {
        let label = scrollToFind(identifier, timeout: 10)
        guard label.exists else {
            XCTFail("\(identifier) should be on screen", file: file, line: line)
            throw SettingsProbeError.unreadable(identifier)
        }
        return label.label
    }

    /// The whole number a value label is showing.
    private func numberLabel(
        _ identifier: String, file: StaticString = #filePath, line: UInt = #line
    ) throws -> Int {
        let shown = try labelText(identifier, file: file, line: line)
        guard let value = Int(shown.filter(\.isNumber)) else {
            XCTFail("\(identifier) should show a number, showed \(shown)", file: file, line: line)
            throw SettingsProbeError.unreadable(identifier)
        }
        return value
    }

    /// A switch's state. `app.switches[...]`, not `find(...)`: `find` is
    /// `descendants(matching: .any)`, which matches the row containing the
    /// switch before the switch itself and so never reports a value.
    private func switchValue(
        _ identifier: String, file: StaticString = #filePath, line: UInt = #line
    ) throws -> Bool {
        let toggle = app.switches[identifier].firstMatch
        guard toggle.waitForExistence(timeout: 10) else {
            XCTFail("\(identifier) should be a switch on screen", file: file, line: line)
            throw SettingsProbeError.unreadable(identifier)
        }
        return (toggle.value as? String) == "1"
    }

    private func setSwitch(
        _ identifier: String, to wanted: Bool,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        let toggle = app.switches[identifier].firstMatch
        guard toggle.waitForExistence(timeout: 10) else {
            XCTFail("\(identifier) should be a switch on screen", file: file, line: line)
            return
        }
        if ((toggle.value as? String) == "1") != wanted { toggle.tap() }
    }

    private func toggleOn(_ identifier: String) { setSwitch(identifier, to: true) }
    private func toggleOff(_ identifier: String) { setSwitch(identifier, to: false) }

    /// Tap a Stepper's increment button. A SwiftUI Stepper exposes its two
    /// buttons as children named "Increment"/"Decrement".
    private func incrementStepper(
        _ identifier: String, times: Int,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        let stepper = scrollToVisible(identifier)
        guard stepper.exists else {
            XCTFail("\(identifier) should be on screen", file: file, line: line)
            return
        }
        let increment = stepper.buttons["Increment"]
        guard increment.waitForExistence(timeout: 5) else {
            XCTFail("\(identifier) should expose an Increment button", file: file, line: line)
            return
        }
        for _ in 0..<times { increment.tap() }
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
