import XCTest

/// The springboard permission alerts the app raises, answered explicitly.
///
/// Each is asked once per simulator: the app asks for notifications on every launch
/// until answered (`LlamenosApp.requestPushNotificationPermission`, from the root
/// view's `onAppear`), and for the camera when the device-link view opens
/// (`DeviceLinkViewModel`). A fresh CI simulator therefore shows each once per shard.
///
/// Left to XCTest's implicit interruption handler, an alert was answered whenever the
/// test next tapped something, racing a busy springboard. In run 36359693222 the handler
/// tapped Allow on the notification alert, still saw the alert a second later, then
/// found it gone and failed the test with "Failed to get matching snapshot: No matches
/// found for Descendants matching type Alert" (1 of the 16 shard-first launches in runs
/// 36343743065–36359693222; the camera alert went through the same handler 10 times).
/// Here each is answered at the step that raises it, before the test touches the app
/// again, and the test waits until the alert has closed.
extension XCUIApplication {
    enum SystemPrompt: String {
        case notifications = "Would Like to Send You Notifications"
        case camera = "would like to access the Camera"
    }

    /// Launch the app, then answer the notification prompt it raises on a fresh simulator.
    /// Every UI test launches through this, never through `launch()` directly.
    ///
    /// The prompt is requested from the root view's `onAppear`, so its absence says
    /// nothing until that view has rendered. In run 36644659179 a simulator still
    /// migrating data took 104s to idle the app; the 30s wait for the prompt ran out
    /// before the app had drawn anything, the prompt was recorded as answered, and it
    /// then covered the app for the rest of the shard: 58 of its 68 tests failed.
    func launchAnsweringSystemPrompts(file: StaticString = #filePath, line: UInt = #line) {
        launch()
        guard firstScreen.waitForExistence(timeout: 60) else {
            XCTFail("The app should render its first screen after launch", file: file, line: line)
            return
        }
        answerSystemPromptOnce(.notifications, file: file, line: line)
    }

    /// Any control or text in the app's window. Every root screen — login, PIN unlock,
    /// the main tabs, the update and wipe screens — draws at least one.
    private var firstScreen: XCUIElement {
        windows.firstMatch.descendants(matching: .any)
            .matching(NSPredicate(
                format: "elementType IN %@",
                [XCUIElement.ElementType.button.rawValue, XCUIElement.ElementType.staticText.rawValue]
            ))
            .firstMatch
    }

    /// Allow `prompt`, unless this test process already has. Call it right after the
    /// step that raises it.
    func answerSystemPromptOnce(_ prompt: SystemPrompt, file: StaticString = #filePath, line: UInt = #line) {
        guard !Self.answeredPrompts.contains(prompt) else { return }

        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let alert = springboard.alerts
            .matching(NSPredicate(format: "label CONTAINS %@", prompt.rawValue))
            .firstMatch
        guard alert.waitForExistence(timeout: 30) else {
            // Not raised: this simulator answered it before (a local re-run). An app
            // that is no longer running never got as far as asking (it crashed on
            // launch, run 36364790578), so the next launch still has to answer it.
            // Nor does a wait prove anything if springboard was never read: in run
            // 36644659179 opening its automation session took the whole 30s and no
            // query ran. Reading its windows confirms the absence was observed.
            if state == .runningForeground && springboard.windows.firstMatch.exists && !alert.exists {
                Self.answeredPrompts.insert(prompt)
            }
            return
        }
        Self.answeredPrompts.insert(prompt)

        let allow = alert.buttons["Allow"]
        XCTAssertTrue(allow.exists, "The \(prompt) permission alert should offer Allow", file: file, line: line)
        allow.tap()
        XCTAssertTrue(
            alert.waitForNonExistence(timeout: 30),
            "The \(prompt) permission alert should close after Allow",
            file: file, line: line
        )
    }

    private static var answeredPrompts: Set<SystemPrompt> = []
}
