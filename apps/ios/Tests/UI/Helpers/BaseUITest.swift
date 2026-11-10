import XCTest

/// Base class for all BDD-aligned UI tests.
/// Provides shared setup, BDD step helpers (given/when/then), and navigation utilities.
///
/// Each test *class* gets one isolated hub created via POST /api/hubs in
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
        failOnSystemAlert()
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
        let className = String(describing: self)
        let hubName = "ios-\(className)-\(Int(Date().timeIntervalSince1970 * 1000))"
        // POST /api/hubs — the route an operator uses — not /api/test-create-hub.
        // `devGuard` (apps/worker/app.ts) answers 404 for every /api/test-* outside
        // a development server, so the dev route tied this entire suite to a dev
        // box. The admin seed TestAdminAPI already holds carries
        // role-super-admin (permissions: ['*']), and POST /api/hubs assigns the
        // creator hub membership, which is what the dev route arranged by taking
        // an `adminPubkey`. See #1423.
        let path = "/api/hubs"
        guard let url = URL(string: "\(hubURL)\(path)") else {
            print("BaseUITest: invalid test hub URL: \(hubURL)")
            return ""
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        do {
            request.setValue("Bearer \(try TestAdminAPI.authorization(method: "POST", path: path))",
                             forHTTPHeaderField: "Authorization")
        } catch {
            print("Warning: createClassHub(\(className)) could not sign the request: \(error)")
            return ""
        }
        // Setup, not an assertion: the first request on a freshly booted CI runner has
        // taken 30-49s, and a class without a hub fails every connected test in it. The
        // request returns when the server answers; this only bounds one that never does.
        request.timeoutInterval = Self.eventBackstop
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
            // POST /api/hubs answers 201 with `{ hub: { id } }`; the dev route
            // answered 200 with a bare `{ id }`.
            if let data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let hub = json["hub"] as? [String: Any],
               let id = hub["id"] as? String {
                hubId = id
            }
        }.resume()
        _ = semaphore.wait(timeout: .now() + Self.eventBackstop + 5)
        if hubId.isEmpty {
            print("Warning: createClassHub(\(className)) returned empty hub ID — is the backend running?")
        }
        return hubId
    }

    // MARK: - Launch Helpers

    /// Launch the app with a clean keychain (login screen).
    func launchClean() {
        app.launchArguments.append("--reset-keychain")
        app.launchToFirstScreen()
    }

    /// Launch the app in a pre-authenticated volunteer state (no API connection).
    func launchAuthenticated() {
        app.launchArguments.append(contentsOf: ["--reset-keychain", "--test-authenticated"])
        app.launchToFirstScreen(awaiting: "main-tab-view")
    }

    /// Launch the app against the live backend with a freshly registered device
    /// identity, member of this class's hub, which becomes the active hub.
    ///
    /// Fails the test before launching when the class hub could not be created —
    /// a backend that is not reachable must not turn into assertions about
    /// connection-error screens.
    private func launchConnected(_ identityArgs: [String], hubId overrideHubId: String? = nil) {
        let hubId = overrideHubId ?? testHubId
        guard !hubId.isEmpty else {
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
            "--test-hub-id", hubId,
            "--test-register",
        ])
        app.launchToFirstScreen(awaiting: "main-tab-view")
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
    ///
    /// `hubId` launches into a hub other than the class's shared one — for a scenario that
    /// needs a hub in a state no other test in the class has touched.
    func launchAsAdminWithAPI(hubId: String? = nil) {
        launchConnected(["--test-admin"], hubId: hubId)
    }

    // MARK: - Server State (deprecated)

    /// Deprecated: hub isolation via class-level createClassHub() replaces this.
    /// Each test class gets its own fresh hub — no global reset needed.
    func resetServerState() {
        fatalError("resetServerState() is removed — class-level hub isolation provides per-class isolation. Remove this call.")
    }

    // MARK: - Simulation Helpers

    /// Simulate an incoming call in this class's hub via the test simulation API.
    /// Returns (callId, status) on success, or nil values on failure.
    ///
    /// The call must carry the class hub: the app lists calls per member hub
    /// (`/api/hubs/:id/calls/active`), so a call the server files under no hub is
    /// never returned to any client and no active-call UI can ever appear for it.
    @discardableResult
    func simulateIncomingCall(callerNumber: String = "+15551234567", hubId: String? = nil) -> (callId: String, status: String) {
        // Default to the class hub; a test that needs a hub of its own passes it.
        let body = ["callerNumber": callerNumber, "hubId": hubId ?? testHubId]
        return simulationRequest(
            endpoint: "incoming-call",
            body: body,
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
    ///
    /// The message must carry the class hub: conversations exist only inside a hub and the
    /// app lists them per member hub (`/api/hubs/:id/conversations`), so a conversation the
    /// server files under no hub is never returned to any client (#2381).
    @discardableResult
    func simulateIncomingMessage(
        senderNumber: String = "+15559876543",
        body: String = "Test message",
        channel: String = "sms",
        hubId: String? = nil
    ) -> (conversationId: String, messageId: String) {
        // Default to the class hub; a test that needs a hub of its own passes it.
        return simulationRequest(
            endpoint: "incoming-message",
            body: ["senderNumber": senderNumber, "body": body, "channel": channel, "hubId": hubId ?? testHubId],
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
        // The request completes when the server answers; this bounds one that never does. The
        // semaphore outlasts the request's own deadline so URLSession reports the timeout,
        // with its cause, instead of this wait.
        request.timeoutInterval = Self.eventBackstop

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        } catch {
            XCTFail("Failed to serialize simulation request body: \(error)")
            return ("", "")
        }

        var resultFirst = ""
        var resultSecond = ""
        let semaphore = DispatchSemaphore(value: 0)

        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }

            // A transport failure leaves the server's state unknown (the call may or may not
            // exist), so it fails the test with its cause rather than handing back an empty
            // id that surfaces three assertions later as "'' is not equal to 'in-progress'".
            if let error {
                XCTFail("Simulation request '\(endpoint)' failed: \(error.localizedDescription)")
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
        }
        task.resume()

        if semaphore.wait(timeout: .now() + Self.eventBackstop + 5) == .timedOut {
            XCTFail("Simulation request '\(endpoint)' got no answer within \(Self.eventBackstop)s")
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
        guard find("main-tab-view").waitForExistence(timeout: Self.eventBackstop) else {
            XCTFail("Main tab view should be visible")
            return
        }
        let tabBar = app.tabBars.firstMatch
        guard tabBar.waitForExistence(timeout: Self.eventBackstop) else {
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
        // More re-opens the overflow tab shown last rather than its list, and that tab carries a
        // back button named "More". Which of the two landed is read off the screen: tapping
        // More a second time because the first has not shown up yet would pop the list back
        // off on a host slow enough that it had.
        let row = app.tables.cells.staticTexts[title]
        let back = app.navigationBars.buttons["More"]
        _ = awaitCondition(timeout: Self.eventBackstop) { row.exists || back.exists }
        if !row.exists, back.exists { back.tap() }
        guard row.waitForExistence(timeout: Self.eventBackstop) else {
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

        let adminLink = scrollToFind("settings-admin-link", maxSwipes: 5)
        guard adminLink.exists else {
            XCTFail("Admin panel link should exist for admin users")
            return
        }
        adminLink.tap()

        // The app presents AdminTabView here. (AdminSidebarView — the
        // "admin-sidebar-list" this used to probe for first, at the cost of a
        // full 10s timeout on every admin navigation — was dead code presented
        // by nothing, and is deleted: #1776.)
        guard find("admin-tab-view").waitForExistence(timeout: Self.eventBackstop) else {
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
        guard accountLink.waitForExistence(timeout: Self.eventBackstop) else {
            XCTFail("Account settings link should exist")
            return
        }
        accountLink.tap()
    }

    func navigateToPreferencesSettings() {
        navigateToSettings()

        let preferencesLink = find("settings-preferences-link")
        guard preferencesLink.waitForExistence(timeout: Self.eventBackstop) else {
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
            guard button.waitForExistence(timeout: Self.eventBackstop) else {
                XCTFail("PIN pad button `pin-\(char)` never appeared; the entered PIN would be incomplete")
                return
            }
            button.tap()
        }
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
    func waitForElement(_ identifier: String, timeout: TimeInterval = BaseUITest.eventBackstop) -> XCUIElement {
        let element = find(identifier)
        XCTAssertTrue(
            element.waitForExistence(timeout: timeout),
            "Element '\(identifier)' should exist within \(timeout)s"
        )
        return element
    }

    /// Wait until any one of the given elements exists, and say whether one did.
    ///
    /// One query over all the identifiers, so the wait ends the moment the first of them
    /// renders. It used to wait out the whole `timeout` on the first identifier before it
    /// looked at the second, which made a screen that rendered its second identifier
    /// (an empty state, say) cost the full timeout and then pass.
    func anyElementExists(_ identifiers: [String], timeout: TimeInterval = BaseUITest.eventBackstop) -> Bool {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier IN %@", identifiers))
            .firstMatch
            .waitForExistence(timeout: timeout)
    }

    /// Swipe up until `element` is rendered (and, if `hittable`, on screen), and say whether it
    /// got there.
    ///
    /// A SwiftUI `List` or `Form` only instantiates rows near the viewport, so a row below the
    /// fold does not *exist* until it is scrolled to — `waitForExistence` alone will never find
    /// it, however long it waits. The screen has to be up before it can be scrolled, so the first
    /// look waits for the element or for a scroll container to be on screen. After that the only
    /// thing between swipes is the swipe: `swipeUp()` returns once the app is idle again, so the
    /// element is read from a settled screen and a miss is a miss, not a reason to wait a second
    /// (a fixed second after each swipe was a guess at how long rendering takes).
    func scroll(to element: XCUIElement, maxSwipes: Int, hittable: Bool) -> Bool {
        let reached = { element.exists && (!hittable || element.isHittable) }
        let containers = app.scrollViews.firstMatch
        let lists = app.tables.firstMatch
        let grids = app.collectionViews.firstMatch
        _ = awaitCondition(timeout: Self.eventBackstop) {
            reached() || containers.exists || lists.exists || grids.exists
        }
        if reached() { return true }
        for _ in 0..<maxSwipes {
            app.swipeUp()
            if reached() { return true }
        }
        return false
    }

    /// Scroll down in the current view to find an element that may be off-screen.
    /// Swipes up on the app's main scrollable area until the element is found or max attempts reached.
    @discardableResult
    func scrollToFind(_ identifier: String, maxSwipes: Int = 5) -> XCUIElement {
        let element = find(identifier)
        _ = scroll(to: element, maxSwipes: maxSwipes, hittable: false)
        return element
    }

    /// Scroll until the element matching `predicate` is in the list's rendered
    /// window, and return it.
    @discardableResult
    func scrollToMatch(_ predicate: NSPredicate, maxSwipes: Int = 8) -> XCUIElement {
        let element = app.descendants(matching: .any).matching(predicate).firstMatch
        _ = scroll(to: element, maxSwipes: maxSwipes, hittable: false)
        return element
    }

    /// Scroll down until an element is visible (hittable) on screen.
    /// Unlike `scrollToFind` which uses `exists` (true for off-screen elements
    /// in SwiftUI Lists), this checks `isHittable` to guarantee visibility.
    @discardableResult
    func scrollToVisible(_ identifier: String, maxSwipes: Int = 10) -> XCUIElement {
        let element = find(identifier)
        _ = scroll(to: element, maxSwipes: maxSwipes, hittable: true)
        return element
    }

    /// Scroll until an element is hittable (visible on screen), then tap it.
    /// Use this for elements deep in scrollable lists that may exist in the
    /// hierarchy but are off-screen and can't be tapped.
    func scrollAndTap(_ identifier: String, maxSwipes: Int = 8) {
        let element = find(identifier)
        if scroll(to: element, maxSwipes: maxSwipes, hittable: true) || element.exists {
            // Last resort when it exists but never became hittable: tap it anyway.
            element.tap()
        } else {
            XCTFail("Element '\(identifier)' not found after \(maxSwipes) swipes")
        }
    }
}

// MARK: - Settling, Focus and Typing

// An extension on XCTestCase rather than BaseUITest members so that every UI test class
// types the same way — including AuthFlowUITests, which runs without a hub and therefore
// does not inherit BaseUITest's per-class hub setup.
extension XCTestCase {
    /// Wait until `condition` holds, and say whether it did.
    ///
    /// The condition is re-evaluated while the run loop spins (the same mechanism as
    /// `waitForExistence`), so the wait ends the moment it is true and no clock paces it. A
    /// sample can be an accessibility snapshot, and on a saturated hosted simulator ONE costs
    /// ~19s (merge group 41489316840) — more than a whole budget. So the verdict is never the
    /// stale sample the waiter happened to be holding when its clock ran out: a failed wait is
    /// settled by one more sample that begins after the deadline.
    func awaitCondition(timeout: TimeInterval, _ condition: @escaping () -> Bool) -> Bool {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in condition() }, object: nil
        )
        if XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed { return true }
        return condition()
    }

    /// Drive a Form `Toggle` to `wanted` with ONE tap, then wait on the value it reports.
    ///
    /// Two waits, each on the thing it is about, and one tap between them:
    ///
    /// 1. **Before the tap, the row must be settled** (`awaitSettled`: hittable, enabled, frame
    ///    unchanged). A screen that was just pushed reports `exists` while it is still sliding in,
    ///    and a tap that lands then is swallowed with no error (#2091). That is a different failure
    ///    from a slow flip, and no wait *after* the tap can cure it: the failure that kept
    ///    ejecting PRs from the merge queue (`testCallSoundsToggleChangesValueWhenTapped`, then named `testCallSoundsToggleExists`, #2618) already waited
    ///    the whole `eventBackstop` plus a fresh sample for a value that was never going to
    ///    change, because the one tap had gone nowhere. Retrying the tap is not the answer either:
    ///    a flip that is merely late would be flipped back, which is what the earlier
    ///    tap-poll-tap version did (merge group 41489316840).
    /// 2. **After the tap, wait for the value.** The toggle is the event; no clock paces it.
    ///
    /// `.accessibilityIdentifier` on a Form `Toggle` lands on the merged row, whose frame is the
    /// whole row: `tap()` hits the centre, over the label, and tapping a Form Toggle's label does
    /// not toggle it (measured on `transcription-enabled-toggle` and `ivr-language-de`). The
    /// control is at the trailing edge, so that is where the one tap goes.
    func setToggle(
        _ toggle: XCUIElement, to wanted: Bool, timeout: TimeInterval,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        let isOn = { (toggle.value as? String) == "1" }
        if isOn() == wanted { return }
        let settled = awaitSettled(toggle, timeout: timeout)
        guard settled.settled else {
            XCTFail(
                "\(toggle) should be on screen, enabled and still before it is tapped"
                    + " (last seen: \(settled.lastSeen))",
                file: file, line: line
            )
            return
        }
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        XCTAssertTrue(
            awaitCondition(timeout: timeout) { isOn() == wanted },
            "\(toggle) should be \(wanted ? "on" : "off") after being tapped",
            file: file, line: line
        )
    }

    /// Wait until `element` is on screen (hittable), enabled (a tap on a disabled
    /// control is silently dropped) AND has held the same frame for `settle` seconds.
    /// `exists` is true for a SwiftUI `List` row that is mid-push-transition or about
    /// to be reflowed by rows inserted above it, and a tap that lands then is
    /// swallowed with no error (#2091: hosted `macos-15` lost the tap on
    /// `admin-events` while the Mac, which settles in time, never did). Waiting on the
    /// element's state — not a fixed delay — makes the tap land on a stable target.
    ///
    /// Judging "still" takes at least two samples, and every sample pays for fresh
    /// accessibility resolves. On hosted `macos-15` one resolve costs 0.7–1.8 s, and on a
    /// saturated simulator ONE snapshot has cost 19–27 s (merge groups 41754174476 and
    /// 41808315098: a field that was "hittable and enabled, frame unchanged for 0.0s over 1
    /// sample(s)" when a 30 s clock ran out, and one reported "not hittable" from a sample
    /// that started before the next one finished). A wall-clock budget cannot hold across a
    /// 40x spread in how long a sample takes, so the budget is not what decides the verdict:
    ///
    /// - The wait is `awaitCondition`, so a wait that outlasts its ceiling is settled by one
    ///   more sample that BEGINS after the ceiling, never by the stale sample the waiter held
    ///   when its clock ran out. The stability window lives in `SettleWatch`, which survives
    ///   across samples, so that one fresh sample is enough to judge "still" against the
    ///   frame an earlier sample saw.
    /// - The ceiling is `BaseUITest.eventBackstop`, the one fault bound every observable
    ///   condition shares: it bounds a field that really never becomes hittable, and is not
    ///   spent on a healthy run, where the wait returns the instant the element is still.
    ///
    /// A sample takes ONE snapshot (existence, enabled, frame together) plus one `isHittable`.
    private func awaitSettled(
        _ element: XCUIElement, timeout: TimeInterval, settle: TimeInterval = 0.5
    ) -> (settled: Bool, lastSeen: String) {
        let watch = SettleWatch()
        let settled = NSPredicate { _, _ in
            guard let snapshot = try? element.snapshot() else {
                watch.observed = "not in the hierarchy"
                watch.frame = .null
                return false
            }
            guard snapshot.isEnabled else {
                watch.observed = "disabled"
                watch.frame = .null
                return false
            }
            guard element.isHittable else {
                watch.observed = "not hittable"
                watch.frame = .null
                return false
            }
            watch.samples += 1
            if snapshot.frame != watch.frame {
                watch.frame = snapshot.frame
                watch.since = Date()
            }
            let held = Date().timeIntervalSince(watch.since)
            watch.observed = "hittable and enabled, frame unchanged for \(String(format: "%.1f", held))s"
                + " over \(watch.samples) sample(s)"
            return held >= settle
        }
        let sample = { settled.evaluate(with: element) }
        // `awaitCondition` already ends a failed wait on one sample that begins after the
        // ceiling. "Still" needs two, though: an element that only became hittable in that
        // last sample has been seen once, and a verdict of "not still" on a single sighting
        // is the stale-sample failure again. So the fresh pair is `awaitCondition`'s sample
        // plus this one; both begin after the ceiling.
        let isSettled = awaitCondition(timeout: timeout, sample) || sample()
        return (isSettled, watch.observed)
    }

    /// Tap `element` once it is settled on screen, failing the test if it never is.
    func tapWhenSettled(
        _ element: XCUIElement, timeout: TimeInterval = BaseUITest.eventBackstop,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        let outcome = awaitSettled(element, timeout: timeout)
        guard outcome.settled else {
            XCTFail(
                "\(element) should be on screen, enabled and still before it is tapped"
                    + " (last seen: \(outcome.lastSeen))",
                file: file, line: line
            )
            return
        }
        element.tap()
    }

    /// Type `text` into `field` — the only way a UI test should type.
    ///
    /// `tap()` returns once the touch is synthesized, not once the field has become first
    /// responder, and `XCUIElement.typeText` gives up after a few seconds with "Neither element
    /// nor any descendant has keyboard focus" if focus has not arrived. Every caller that wrote
    /// `field.tap(); field.typeText(...)` carried that race, and it surfaced field by field:
    /// the Add Ban identifier (merge group 40426201858, shard 3 — tapped while its sheet was
    /// still sliding in) and the note editor behind the Call Ended prompt (run 40777327221,
    /// shard 2 — tapped on a settled sheet while the hosted simulator was saturated, and typed
    /// into 1.6 s later, before the tap had been turned into focus). So this waits for the
    /// field to be settled, taps it once, and waits on keyboard focus itself before a single
    /// keystroke is synthesized. A field that never takes focus fails here, naming the field
    /// and whatever holds focus instead, rather than inside `typeText` with neither.
    func typeText(
        _ text: String, into field: XCUIElement, file: StaticString = #filePath, line: UInt = #line
    ) {
        guard focus(field, file: file, line: line) else { return }
        field.typeText(text)
    }

    /// Tap `field` once it is settled on screen and return once it — or an element inside it, as
    /// with a SwiftUI container carrying the identifier — holds keyboard focus.
    ///
    /// One tap, then a wait on the condition. A settled, hittable field that a delivered tap
    /// does not focus is a defect worth seeing, not one to tap past.
    @discardableResult
    func focus(
        _ field: XCUIElement, timeout: TimeInterval = BaseUITest.eventBackstop,
        file: StaticString = #filePath, line: UInt = #line
    ) -> Bool {
        let settled = awaitSettled(field, timeout: timeout)
        guard settled.settled else {
            XCTFail(
                "\(field) should be on screen, enabled and still before it is given keyboard focus"
                    + " (last seen: \(settled.lastSeen))",
                file: file, line: line
            )
            return false
        }
        field.tap()

        // `hasKeyboardFocus` is not exposed on XCUIElement in Swift; XCTest evaluates it only
        // as a predicate key, which is also how its own typeText checks focus.
        let hasFocus = NSPredicate(format: "hasKeyboardFocus == true")
        let isFocused = {
            hasFocus.evaluate(with: field)
                || field.descendants(matching: .any).matching(hasFocus).firstMatch.exists
        }
        if awaitCondition(timeout: timeout, isFocused) { return true }

        let holder = XCUIApplication().descendants(matching: .any).matching(hasFocus).firstMatch
        let elsewhere = holder.exists
            ? "keyboard focus is on '\(holder.identifier.isEmpty ? holder.label : holder.identifier)' instead"
            : "nothing in the app holds keyboard focus"
        XCTFail(
            "\(field) was tapped but did not take keyboard focus within \(Int(timeout))s; \(elsewhere)",
            file: file, line: line
        )
        return false
    }
}

/// What `awaitSettled` last saw, so a timeout says which condition was never met.
private final class SettleWatch {
    var frame = CGRect.null
    var since = Date()
    var samples = 0
    var observed = "never resolved"
}
