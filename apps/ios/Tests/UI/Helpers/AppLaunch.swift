import XCTest

/// How every UI test launches the app, and the rule that no system alert may appear.
///
/// UI-test builds ask for notifications with `.provisional`
/// (`LlamenosApp.pushAuthorizationOptions`), which the system grants without a prompt,
/// and nothing else the suite drives requests a permission. So a UI test never has a
/// springboard alert to answer: the app never presents one.
///
/// Answering one was not deterministic. In run 40560664328 the notifications alert had
/// been on screen for 4s when the helper tapped Allow dead centre; springboard animated
/// the press and did not act on it, the alert stayed up for 30s, and the merge group was
/// ejected (#2291). Before that, XCTest's implicit interruption handler raced a busy
/// springboard (run 36359693222). No wait makes a swallowed tap land, so the alert is not
/// raised at all.
extension XCUIApplication {
    /// Launch the app and wait until it has drawn its first screen. Every UI test
    /// launches through this, never through `launch()` directly.
    ///
    /// A cold launch on a busy runner has taken 104s to idle the app (run 36644659179,
    /// a simulator still migrating data), so a test's own short waits must not start
    /// before anything has rendered.
    func launchToFirstScreen(file: StaticString = #filePath, line: UInt = #line) {
        launch()
        XCTAssertTrue(
            firstScreen.waitForExistence(timeout: 60),
            "The app should render its first screen after launch",
            file: file, line: line
        )
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
}

extension XCTestCase {
    /// Fail the test, by name, if a system alert ever blocks it.
    ///
    /// Without this, XCTest's implicit handler would tap the alert's default button and
    /// carry on — so an app change that starts requesting a permission would bring back
    /// the nondeterministic tap of #2291 silently, as scattered failures in whichever test
    /// met the alert. Returning `false` after the failure leaves the alert to the default
    /// handler only so the rest of the shard is not covered by it; the test has already
    /// failed with the alert's title in the message.
    ///
    /// A springboard permission alert is not owned by the app: it stays on screen after
    /// the app is terminated and even after it is uninstalled (observed on iOS 26.5). A
    /// local simulator that once showed the prompt to an older build and never had it
    /// answered keeps showing it to every later build. CI creates a fresh simulator per
    /// shard; locally, reboot the simulator to clear it.
    func failOnSystemAlert() {
        addUIInterruptionMonitor(withDescription: "No system alert in UI tests") { alert in
            XCTFail(
                "A system alert appeared: \"\(alert.label)\". UI tests must never raise one — "
                    + "grant the permission without a prompt in UI_TESTING builds (see "
                    + "LlamenosApp.pushAuthorizationOptions) instead of answering it. If no "
                    + "current code requests it, the alert is left over from an earlier build: "
                    + "springboard keeps it across uninstall, so reboot the simulator."
            )
            return false
        }
    }
}
