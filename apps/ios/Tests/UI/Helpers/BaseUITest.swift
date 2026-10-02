import XCTest

/// Base class for all BDD-aligned UI tests.
/// Provides shared setup, BDD step helpers (given/when/then), and navigation utilities.
///
/// Each test *class* gets one isolated hub created via POST /api/test-create-hub in
/// `class func setUp()`. All test methods within the class share this hub. This enables
/// Xcode parallel testing: each parallel worker runs a different test class, and each
/// class has its own hub — no shared state between workers.
class BaseUITest: XCTestCase {
    var app: XCUIApplication!

    // MARK: - Class-Level Hub Isolation

    /// Thread-safe storage of hub IDs keyed by test class name.
    /// Each subclass gets its own hub, created once in `class func setUp()`.
    private static var classHubIds: [String: String] = [:]
    private static let hubLock = NSLock()

    /// Hub ID for this test class, created once in `class func setUp()`.
    var testHubId: String {
        let key = String(describing: type(of: self))
        Self.hubLock.lock()
        defer { Self.hubLock.unlock() }
        return Self.classHubIds[key] ?? ""
    }

    override class func setUp() {
        super.setUp()
        let key = String(describing: self)
        let hubId = createClassHub()
        hubLock.lock()
        classHubIds[key] = hubId
        hubLock.unlock()
    }

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        app = XCUIApplication()
        // Tab titles and system labels ("More") are matched by text; pin the language.
        app.launchArguments += ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
    }

    override func tearDown() {
        app = nil
        super.tearDown()
    }

    // MARK: - Hub URL

    /// The test hub URL, read from environment or defaulting to 127.0.0.1 (Docker Compose).
    /// Uses 127.0.0.1 instead of localhost to force IPv4 — Bun's HTTP server binds to
    /// 0.0.0.0 (IPv4 only), and the iOS Simulator's URLSession may try IPv6 [::1] first,
    /// causing connection timeouts on macOS CI runners.
    var testHubURL: String {
        ProcessInfo.processInfo.environment["TEST_HUB_URL"]
            ?? "http://127.0.0.1:3000"
    }

    // MARK: - Test Secret

    /// The test secret, matching DEV_RESET_SECRET / E2E_TEST_SECRET in docker-compose.test.yml.
    private var testSecret: String {
        ProcessInfo.processInfo.environment["E2E_TEST_SECRET"]
            ?? ProcessInfo.processInfo.environment["TEST_RESET_SECRET"]
            ?? "test-reset-secret"
    }

    // MARK: - Hub Creation (Class-Level)

    /// Create a fresh isolated hub for this test class.
    /// Called once per class in `class func setUp()` — not per test method.
    private class func createClassHub() -> String {
        let hubURL = ProcessInfo.processInfo.environment["TEST_HUB_URL"]
            ?? "http://127.0.0.1:3000"
        let secret = ProcessInfo.processInfo.environment["E2E_TEST_SECRET"]
            ?? ProcessInfo.processInfo.environment["TEST_RESET_SECRET"]
            ?? "test-reset-secret"
        let className = String(describing: self)
        let hubName = "ios-\(className)-\(Int(Date().timeIntervalSince1970 * 1000))"
        guard let url = URL(string: "\(hubURL)/api/test-create-hub") else {
            print("BaseUITest: invalid test hub URL: \(hubURL)")
            return ""
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(secret, forHTTPHeaderField: "X-Test-Secret")
        // Setup, not an assertion: the first request on a freshly booted CI runner has
        // taken 30-49s, and a class without a hub fails every connected test in it.
        request.timeoutInterval = 60
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["name": hubName])

        var hubId = ""
        let semaphore = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }
            if let error {
                print("Warning: createClassHub(\(className)) failed: \(error.localizedDescription)")
                return
            }
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                let code = (response as? HTTPURLResponse)?.statusCode ?? -1
                print("Warning: createClassHub(\(className)) returned \(code)")
                return
            }
            if let data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let id = json["id"] as? String {
                hubId = id
            }
        }.resume()
        _ = semaphore.wait(timeout: .now() + 65)
        if hubId.isEmpty {
            print("Warning: createClassHub(\(className)) returned empty hub ID — is the backend running?")
        }
        return hubId
    }

    // MARK: - Launch Helpers

    /// Launch the app with a clean keychain (login screen).
    func launchClean() {
        app.launchArguments.append("--reset-keychain")
        app.launchAnsweringSystemPrompts()
    }

    /// Launch the app in a pre-authenticated volunteer state (no API connection).
    func launchAuthenticated() {
        app.launchArguments.append(contentsOf: ["--reset-keychain", "--test-authenticated"])
        app.launchAnsweringSystemPrompts()
        waitForMainScreen()
    }

    /// An authenticated launch is done when the main tab view is up. A cold first
    /// launch on a busy CI runner has taken ~50s (run 36352561511), so a test's own
    /// short waits started before anything had rendered. Failing here also makes a
    /// launch that never reaches the main screen say so, instead of surfacing as a
    /// missing element further down.
    private func waitForMainScreen(file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(
            find("main-tab-view").waitForExistence(timeout: 60),
            "The app should reach its main screen after an authenticated launch",
            file: file, line: line
        )
    }

    /// Launch the app against the live backend with a freshly registered device
    /// identity, member of this class's hub, which becomes the active hub.
    ///
    /// Fails the test before launching when the class hub could not be created —
    /// a backend that is not reachable must not turn into assertions about
    /// connection-error screens.
    private func launchConnected(_ identityArgs: [String]) {
        guard !testHubId.isEmpty else {
            XCTFail("No test hub for \(type(of: self)) — is the backend running at \(testHubURL)?")
            return
        }
        // The app registers its own fresh device key through the real admin API,
        // signed as the test admin (UI_TESTING builds only — AppState).
        app.launchEnvironment["XCTEST_ADMIN_SECRET"] = TestAdminAPI.seedHex
        app.launchArguments.append(contentsOf: [
            "--reset-keychain",
            "--test-authenticated",
        ] + identityArgs + [
            "--test-hub-url", testHubURL,
            "--test-hub-id", testHubId,
            "--test-register",
        ])
        app.launchAnsweringSystemPrompts()
        waitForMainScreen()
    }

    /// Launch connected to the live backend as a super-admin (hub admin of this
    /// class's hub).
    func launchWithAPI() {
        launchConnected([])
    }

    /// Launch connected to the live backend as a volunteer of this class's hub.
    func launchAsVolunteerWithAPI() {
        launchConnected(["--test-volunteer-identity"])
    }

    /// Launch connected to the live backend as a super-admin, with the admin UI
    /// role set before the server's `/api/auth/me` answer arrives.
    func launchAsAdminWithAPI() {
        launchConnected(["--test-admin"])
    }

    // MARK: - Server State (deprecated)

    /// Deprecated: hub isolation via class-level createClassHub() replaces this.
    /// Each test class gets its own fresh hub — no global reset needed.
    func resetServerState() {
        fatalError("resetServerState() is removed — class-level hub isolation provides per-class isolation. Remove this call.")
    }

    // MARK: - Simulation Helpers

    /// Simulate an incoming call via the test simulation API.
    /// Returns (callId, status) on success, or nil values on failure.
    @discardableResult
    func simulateIncomingCall(callerNumber: String = "+15551234567") -> (callId: String, status: String) {
        return simulationRequest(
            endpoint: "incoming-call",
            body: ["callerNumber": callerNumber],
            extractKeys: ("callId", "status")
        )
    }

    /// Simulate answering a call via the test simulation API.
    /// Returns the call status string.
    @discardableResult
    func simulateAnswerCall(callId: String, pubkey: String) -> String {
        let result = simulationRequest(
            endpoint: "answer-call",
            body: ["callId": callId, "pubkey": pubkey],
            extractKeys: ("status", "status")
        )
        return result.0
    }

    /// Simulate ending a call via the test simulation API.
    /// Returns the call status string.
    @discardableResult
    func simulateEndCall(callId: String) -> String {
        let result = simulationRequest(
            endpoint: "end-call",
            body: ["callId": callId],
            extractKeys: ("status", "status")
        )
        return result.0
    }

    /// Simulate a voicemail (unanswered call) via the test simulation API.
    /// Returns the call status string.
    @discardableResult
    func simulateVoicemail(callId: String) -> String {
        let result = simulationRequest(
            endpoint: "voicemail",
            body: ["callId": callId],
            extractKeys: ("status", "status")
        )
        return result.0
    }

    /// Simulate an incoming message via the test simulation API.
    /// Returns (conversationId, messageId) on success.
    @discardableResult
    func simulateIncomingMessage(
        senderNumber: String = "+15559876543",
        body: String = "Test message",
        channel: String = "sms"
    ) -> (conversationId: String, messageId: String) {
        return simulationRequest(
            endpoint: "incoming-message",
            body: ["senderNumber": senderNumber, "body": body, "channel": channel],
            extractKeys: ("conversationId", "messageId")
        )
    }

    /// Generic simulation request helper using synchronous URLSession + DispatchSemaphore.
    private func simulationRequest(
        endpoint: String,
        body: [String: String],
        extractKeys: (String, String)
    ) -> (String, String) {
        guard let url = URL(string: "\(testHubURL)/api/test-simulate/\(endpoint)") else {
            XCTFail("Invalid simulation URL for endpoint: \(endpoint)")
            return ("", "")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(testSecret, forHTTPHeaderField: "X-Test-Secret")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        } catch {
            XCTFail("Failed to serialize simulation request body: \(error)")
            return ("", "")
        }

        var resultFirst = ""
        var resultSecond = ""
        let semaphore = DispatchSemaphore(value: 0)

        URLSession.shared.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }

            if let error {
                print("Warning: Simulation request '\(endpoint)' failed: \(error.localizedDescription)")
                return
            }
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                let code = (response as? HTTPURLResponse)?.statusCode ?? -1
                print("Warning: Simulation request '\(endpoint)' returned \(code)")
                return
            }
            guard let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                print("Warning: Simulation request '\(endpoint)' returned invalid JSON")
                return
            }

            resultFirst = json[extractKeys.0] as? String ?? ""
            resultSecond = json[extractKeys.1] as? String ?? ""
        }.resume()

        let timeout = semaphore.wait(timeout: .now() + 20)
        if timeout == .timedOut {
            print("Warning: Simulation request '\(endpoint)' timed out")
        }
        return (resultFirst, resultSecond)
    }

    // MARK: - BDD Step Helpers

    /// Wraps an action in an XCTContext activity for structured Given/When/Then reporting.
    func given(_ description: String, block: () throws -> Void) rethrows {
        try XCTContext.runActivity(named: "Given \(description)") { _ in
            try block()
        }
    }

    func when(_ description: String, block: () throws -> Void) rethrows {
        try XCTContext.runActivity(named: "When \(description)") { _ in
            try block()
        }
    }

    func then(_ description: String, block: () throws -> Void) rethrows {
        try XCTContext.runActivity(named: "Then \(description)") { _ in
            try block()
        }
    }

    func and(_ description: String, block: () throws -> Void) rethrows {
        try XCTContext.runActivity(named: "And \(description)") { _ in
            try block()
        }
    }

    // MARK: - Navigation

    /// MainTabView's tabs, in order, by their English titles (setUp pins English).
    private static let mainTabTitles = ["Dashboard", "Notes", "Cases", "Messages", "Shifts", "Settings"]

    /// Select a main tab the way a user does. Indices follow `mainTabTitles`.
    ///
    /// An iPhone tab bar shows at most five items, so with six tabs Shifts and
    /// Settings are reached through "More". This helper used to tap the button at
    /// `index` if one existed and silently do nothing otherwise — so every test that
    /// opened Shifts or Settings on an iPhone was asserting against the dashboard.
    func navigateToTab(index: Int) {
        guard find("main-tab-view").waitForExistence(timeout: 10) else {
            XCTFail("Main tab view should be visible")
            return
        }
        let tabBar = app.tabBars.firstMatch
        guard tabBar.waitForExistence(timeout: 5) else {
            XCTFail("Tab bar should exist")
            return
        }
        let title = Self.mainTabTitles[index]
        let direct = tabBar.buttons[title]
        if direct.exists {
            direct.tap()
            return
        }
        let more = tabBar.buttons["More"]
        guard more.exists else {
            XCTFail("Tab '\(title)' is neither in the tab bar nor behind More")
            return
        }
        more.tap()
        let row = app.tables.cells.staticTexts[title]
        if !row.waitForExistence(timeout: 2) {
            // More re-opens the overflow tab shown last; tapping it again pops to its list.
            more.tap()
        }
        guard row.waitForExistence(timeout: 5) else {
            XCTFail("Tab '\(title)' should be listed under More")
            return
        }
        row.tap()
    }

    func navigateToDashboard() { navigateToTab(index: 0) }
    func navigateToNotes() { navigateToTab(index: 1) }
    func navigateToCases() { navigateToTab(index: 2) }
    func navigateToConversations() { navigateToTab(index: 3) }
    func navigateToShifts() { navigateToTab(index: 4) }
    func navigateToSettings() { navigateToTab(index: 5) }

    /// Open the admin panel from Settings, failing the test if it does not open.
    func navigateToAdminPanel() {
        navigateToSettings()

        let adminLink = scrollToFind("settings-admin-link", maxSwipes: 5, timeout: 10)
        guard adminLink.exists else {
            XCTFail("Admin panel link should exist for admin users")
            return
        }
        adminLink.tap()

        guard anyElementExists(["admin-sidebar-list", "admin-tab-view"]) else {
            XCTFail("Admin panel should appear after tapping the admin link")
            return
        }
    }

    /// Open one admin settings screen from the admin panel.
    func navigateToAdminSettingsScreen(_ linkIdentifier: String) {
        navigateToAdminPanel()

        let link = scrollToFind(linkIdentifier)
        guard link.exists else {
            XCTFail("\(linkIdentifier) should exist in admin panel")
            return
        }
        link.tap()
    }

    func navigateToAccountSettings() {
        navigateToSettings()

        let accountLink = find("settings-account-link")
        guard accountLink.waitForExistence(timeout: 5) else {
            XCTFail("Account settings link should exist")
            return
        }
        accountLink.tap()
    }

    func navigateToPreferencesSettings() {
        navigateToSettings()

        let preferencesLink = find("settings-preferences-link")
        guard preferencesLink.waitForExistence(timeout: 5) else {
            XCTFail("Preferences settings link should exist")
            return
        }
        preferencesLink.tap()
    }

    // MARK: - PIN Helpers

    /// Taps a PIN into the pad, one digit at a time.
    ///
    /// Uses `app.buttons[...]` rather than this file's `find(...)`, and the
    /// difference is the whole cost of the slowest test in the suite.
    /// `find` is `app.descendants(matching: .any)[id]`, which walks EVERY
    /// element type in the accessibility hierarchy. The digits are plain
    /// SwiftUI `Button`s (`PINPadView.PINDigitButton` applies
    /// `.accessibilityIdentifier("pin-\(digit)")`), so a typed query resolves
    /// them without that walk — and the walk happened twice per digit, once
    /// for the existence check and again inside `tap()`.
    ///
    /// `testPINWipeAfterTenFailedAttempts` calls this ten times with an
    /// eight-digit PIN: 80 digits, 160 hierarchy walks, and essentially the
    /// entire runtime of a test that has been taking 168-313s depending on
    /// how fast a runner GitHub hands out.
    ///
    /// A missing button now fails loudly. The previous `if
    /// button.waitForExistence { tap() }` silently skipped the digit, which
    /// submits a DIFFERENT PIN than the test asked for — a lockout test that
    /// quietly enters seven digits instead of eight is not testing what it
    /// claims to.
    func enterPIN(_ pin: String) {
        for char in pin {
            let button = app.buttons["pin-\(char)"]
            guard button.waitForExistence(timeout: 2) else {
                XCTFail("PIN pad button `pin-\(char)` never appeared; the entered PIN would be incomplete")
                return
            }
            button.tap()
        }
    }

    /// Navigate through full onboarding: create identity, set + confirm PIN, reach dashboard.
    ///
    /// V3 device key model: there is no backup-confirmation step and no digit
    /// PIN pad here — PINSetView.swift uses a free-text SecureField
    /// ("pin-input"/"pin-submit") so a PIN or passphrase (8+ characters) can
    /// be entered, and device keys are generated atomically once the same
    /// value is entered twice (PINViewModel.handleSetPIN). The digit
    /// PINPadView ("pin-pad", `enterPIN`) is only used on the lock/unlock
    /// screen — see PINUnlockView.swift.
    func completeOnboarding(hubURL: String = "https://test.example.org", pin: String = "12345678") {
        // Enter hub URL
        let hubURLInput = find("hub-url-input")
        if hubURLInput.waitForExistence(timeout: 5) {
            hubURLInput.tap()
            hubURLInput.typeText(hubURL)
            dismissKeyboard()
        }

        // Create identity
        let createButton = find("create-identity")
        if createButton.waitForExistence(timeout: 3) {
            createButton.tap()
        }

        // Enter PIN (first entry)
        let pinInput = find("pin-input")
        guard pinInput.waitForExistence(timeout: 10) else { return }
        pinInput.tap()
        pinInput.typeText(pin)

        let submitButton = find("pin-submit")
        if submitButton.waitForExistence(timeout: 3) {
            submitButton.tap()
        }

        // Confirm PIN (second entry)
        if pinInput.waitForExistence(timeout: 5) {
            pinInput.tap()
            pinInput.typeText(pin)

            if submitButton.waitForExistence(timeout: 3) {
                submitButton.tap()
            }
        }

        // Wait for dashboard
        let dashboardTitle = find("dashboard-title")
        _ = dashboardTitle.waitForExistence(timeout: 10)
    }

    /// Dismiss the keyboard by tapping a neutral area of the screen.
    func dismissKeyboard() {
        let coordinate = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1))
        coordinate.tap()
    }

    // MARK: - Element Helpers

    /// Find any element by accessibility identifier, regardless of XCUIElement type.
    /// SwiftUI exposes elements as varying types (cells, groups, other, etc.)
    /// depending on container context. This helper avoids type-mismatch failures.
    func find(_ identifier: String) -> XCUIElement {
        return app.descendants(matching: .any)[identifier].firstMatch
    }

    /// Wait for an element by accessibility identifier, asserting it exists.
    @discardableResult
    func waitForElement(_ identifier: String, timeout: TimeInterval = 5) -> XCUIElement {
        let element = find(identifier)
        XCTAssertTrue(
            element.waitForExistence(timeout: timeout),
            "Element '\(identifier)' should exist within \(timeout)s"
        )
        return element
    }

    /// Check if any of the given elements exist (returns true if at least one is found).
    func anyElementExists(_ identifiers: [String], timeout: TimeInterval = 10) -> Bool {
        for (i, id) in identifiers.enumerated() {
            let element = find(id)
            let wait: TimeInterval = i == 0 ? timeout : 2
            if element.waitForExistence(timeout: wait) {
                return true
            }
        }
        return false
    }

    /// Scroll down in the current view to find an element that may be off-screen.
    /// Swipes up on the app's main scrollable area until the element is found or max attempts reached.
    @discardableResult
    func scrollToFind(_ identifier: String, maxSwipes: Int = 5, timeout: TimeInterval = 2) -> XCUIElement {
        let element = find(identifier)
        if element.waitForExistence(timeout: timeout) {
            return element
        }

        // Try swiping up to scroll down
        for _ in 0..<maxSwipes {
            app.swipeUp()
            if element.waitForExistence(timeout: 1) {
                return element
            }
        }
        return element
    }

    /// Scroll down until an element is visible (hittable) on screen.
    /// Unlike `scrollToFind` which uses `exists` (true for off-screen elements
    /// in SwiftUI Lists), this checks `isHittable` to guarantee visibility.
    @discardableResult
    func scrollToVisible(_ identifier: String, maxSwipes: Int = 10) -> XCUIElement {
        let element = find(identifier)

        // Check if already visible
        if element.waitForExistence(timeout: 2) && element.isHittable {
            return element
        }

        // Scroll until visible
        for _ in 0..<maxSwipes {
            app.swipeUp()
            if element.waitForExistence(timeout: 1) && element.isHittable {
                return element
            }
        }
        return element
    }

    /// Scroll until an element is hittable (visible on screen), then tap it.
    /// Use this for elements deep in scrollable lists that may exist in the
    /// hierarchy but are off-screen and can't be tapped.
    func scrollAndTap(_ identifier: String, maxSwipes: Int = 8) {
        let element = find(identifier)

        // Check if already hittable
        if element.waitForExistence(timeout: 2) && element.isHittable {
            element.tap()
            return
        }

        // Scroll until hittable
        for _ in 0..<maxSwipes {
            app.swipeUp()
            if element.waitForExistence(timeout: 1) && element.isHittable {
                element.tap()
                return
            }
        }

        // Last resort: tap even if not confirmed hittable
        if element.exists {
            element.tap()
        } else {
            XCTFail("Element '\(identifier)' not found after \(maxSwipes) swipes")
        }
    }
}
