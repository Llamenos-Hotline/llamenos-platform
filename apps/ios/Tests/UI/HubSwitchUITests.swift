import XCTest

/// XCUITest suite for hub switch end-to-end flow.
/// Verifies that switching the active hub updates the data scope and
/// that the active hub indicator correctly reflects the selection.
///
/// Maps to BDD scenario: hub-switch end-to-end.
final class HubSwitchUITests: BaseUITest {

    // MARK: - Helpers

    /// Navigate to the hub management screen via Settings > Hubs link.
    private func navigateToHubs() {
        navigateToSettings()
        scrollAndTap("settings-hubs-link")

        _ = anyElementExists([
            "hubs-list",
            "hubs-loading",
            "hubs-empty",
        ], timeout: 10)
    }

    /// Create a second hub via the UI form. Returns the slug used.
    /// Requires the hub management screen to already be visible.
    @discardableResult
    private func createSecondHubViaForm(slug: String) -> String {
        let createButton = find("hubs-create-btn")
        guard createButton.waitForExistence(timeout: 5) else {
            XCTFail("Create Hub button must be visible to create a second hub")
            return slug
        }
        createButton.tap()

        let nameField = find("hub-name-field")
        guard nameField.waitForExistence(timeout: 5) else {
            XCTFail("Hub name field must appear in the create hub form")
            return slug
        }
        nameField.tap()
        nameField.typeText("Test Hub \(slug)")
        dismissKeyboard()

        // Slug field auto-populates but we can also set it explicitly
        let slugField = find("hub-slug-field")
        if slugField.waitForExistence(timeout: 3) {
            slugField.tap()
            slugField.clearAndTypeText("test-\(slug)")
            dismissKeyboard()
        }

        let submitButton = find("hub-create-submit")
        guard submitButton.waitForExistence(timeout: 5) else {
            XCTFail("Hub create submit button must exist")
            return slug
        }
        submitButton.tap()

        // Wait for sheet to dismiss and list to reload
        _ = find("hubs-list").waitForExistence(timeout: 10)
        return slug
    }

    // MARK: - Scenario: Hub switch updates data scope

    /// End-to-end test: create two hubs, switch between them, verify
    /// the active hub indicator updates and the notes screen loads.
    func testHubSwitchUpdatesDataScope() throws {
        given("the app is launched as admin with live API") {
            launchAsAdminWithAPI()
        }

        when("I navigate to hub management") {
            navigateToHubs()
        }

        then("the hub list is visible") {
            let hubList = find("hubs-list")
            XCTAssertTrue(
                hubList.waitForExistence(timeout: 10),
                "Hub list must be visible after navigating to Settings > Hubs"
            )
        }

        // The form sets the slug to test-<n>; if it only auto-fills from the name it is
        // test-hub-<n>. Either way the row is the one this test created: a super-admin
        // lists every hub on the server, including other test classes' hubs, so "the
        // second row" is whichever hub happens to sort there — in runs 36352561511,
        // 36359693222 and 36364790578 it was AdminSidebarUITests' hub.
        var createdRow = NSPredicate(value: false)
        when("I create a second hub via the creation form") {
            let uniqueSlug = "\(Int(Date().timeIntervalSince1970) % 100000)"
            createSecondHubViaForm(slug: uniqueSlug)
            createdRow = NSPredicate(
                format: "identifier BEGINSWITH 'hub-row-test-' AND identifier ENDSWITH %@", "-\(uniqueSlug)"
            )
        }

        then("at least two hub rows are visible") {
            let hubRows = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'hub-row-'"))
            let firstRow = hubRows.firstMatch
            XCTAssertTrue(
                firstRow.waitForExistence(timeout: 10),
                "Hub rows must appear in the list after creating a second hub"
            )
            XCTAssertGreaterThanOrEqual(
                hubRows.count, 2,
                "At least two hub rows must be visible after hub creation"
            )
        }

        when("I tap the new hub's row to switch") {
            let row = app.descendants(matching: .any).matching(createdRow).firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 10), "The hub this test created must be listed")
            row.tap()
        }

        then("the active hub indicator moves to that row") {
            let row = app.descendants(matching: .any).matching(createdRow).firstMatch
            let selected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isSelected == true"), object: row)
            let switched = XCTWaiter().wait(for: [selected], timeout: 10) == .completed
            let alert = app.alerts.firstMatch
            let shown = alert.exists
                ? " The app showed \"\(alert.label)\": "
                    + alert.staticTexts.allElementsBoundByIndex.map(\.label).joined(separator: " ")
                : ""
            XCTAssertTrue(switched, "The tapped hub must become the active hub.\(shown)")
        }

        and("the notes screen loads without an error state after the hub switch") {
            navigateToNotes()

            // Either the notes list or empty state must appear — no error screen
            let loaded = anyElementExists([
                "notes-list",
                "notes-empty-state",
            ], timeout: 10)
            XCTAssertTrue(
                loaded,
                "Notes screen must load (list or empty state) after switching hub — no error state"
            )
        }
    }
}

// MARK: - XCUIElement Extension

private extension XCUIElement {
    /// Clear existing text and type new text into a text field.
    func clearAndTypeText(_ text: String) {
        guard let currentValue = value as? String, !currentValue.isEmpty else {
            typeText(text)
            return
        }
        // Select all and delete
        tap()
        let selectAll = XCUIApplication().menuItems["Select All"]
        if selectAll.waitForExistence(timeout: 1) {
            selectAll.tap()
            typeText(text)
        } else {
            // Fallback: triple-tap to select all, then type
            let coordinate = coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            coordinate.tap()
            coordinate.tap()
            coordinate.tap()
            typeText(text)
        }
    }
}
