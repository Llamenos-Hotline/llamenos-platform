import XCTest

/// The app asks for notification permission on every launch until it is answered
/// (`LlamenosApp.requestPushNotificationPermission`, from the root view's `onAppear`),
/// so a fresh CI simulator shows the springboard alert once per shard, at the first
/// launch, some seconds after the app goes idle.
///
/// Left to XCTest's implicit interruption handler, the alert was answered whenever the
/// test first tapped something, racing a busy springboard. In run 36359693222 the handler
/// tapped Allow, still saw the alert a second later, then found it gone and failed the
/// test with "Failed to get matching snapshot: No matches found for Descendants matching
/// type Alert" (1 of the 16 shard-first launches in runs 36343743065–36359693222). Here
/// it is answered explicitly, before the test touches the app, and the test waits until
/// the alert has closed.
extension XCUIApplication {
    /// Launch the app, then answer the system prompt it raises on a fresh simulator.
    /// Every UI test launches through this, never through `launch()` directly.
    func launchAnsweringSystemPrompts(file: StaticString = #filePath, line: UInt = #line) {
        launch()
        Self.answerNotificationPermissionOnce(file: file, line: line)
    }

    /// Once per test process: after the first launch the question has been answered and
    /// the simulator keeps the answer for every later launch in the shard.
    private static var notificationPermissionAnswered = false

    private static func answerNotificationPermissionOnce(file: StaticString, line: UInt) {
        guard !notificationPermissionAnswered else { return }
        notificationPermissionAnswered = true

        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let alert = springboard.alerts
            .matching(NSPredicate(format: "label CONTAINS %@", "Would Like to Send You Notifications"))
            .firstMatch
        // A simulator that already answered (a local re-run) never shows it.
        guard alert.waitForExistence(timeout: 30) else { return }

        let allow = alert.buttons["Allow"]
        XCTAssertTrue(allow.exists, "The notification permission alert should offer Allow", file: file, line: line)
        allow.tap()
        XCTAssertTrue(
            alert.waitForNonExistence(timeout: 30),
            "The notification permission alert should close after Allow",
            file: file, line: line
        )
    }
}
