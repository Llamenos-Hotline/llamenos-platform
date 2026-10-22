import XCTest

/// BDD tests for the Admin Custom Fields feature (Epic 244).
/// Tests the custom fields tab, field creation, editing, and deletion.
///
/// Custom fields are a server-wide setting (not per hub), so the class empties them before
/// each test through the same route the app saves with. Every scenario then starts from the
/// empty state, instead of branching on whatever an earlier test left behind.
final class AdminCustomFieldsUITests: BaseUITest {

    override func setUp() {
        super.setUp()
        TestAdminAPI.send("PUT", "/api/settings/custom-fields", ["fields": [[String: Any]]()], baseURL: testHubURL)
        XCTAssertTrue(serverFieldLabels().isEmpty, "Custom fields should start empty")
    }

    // MARK: - Helpers

    /// The labels of the custom fields the server holds, read as an admin.
    private func serverFieldLabels(file: StaticString = #filePath, line: UInt = #line) -> [String] {
        guard let data = TestAdminAPI.send(
            "GET", "/api/settings/custom-fields?role=admin", baseURL: testHubURL, file: file, line: line
        ), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let fields = json["fields"] as? [[String: Any]] else {
            XCTFail("GET /api/settings/custom-fields did not return { fields: [...] }", file: file, line: line)
            return []
        }
        return fields.compactMap { $0["label"] as? String }
    }

    /// Navigate to the admin panel and tap the Custom Fields navigation link.
    private func navigateToCustomFields() {
        navigateToAdminPanel()

        let customFieldsLink = find("admin-custom-fields")
        XCTAssertTrue(customFieldsLink.waitForExistence(timeout: 5), "Custom Fields link should exist in admin panel")
        customFieldsLink.tap()
    }

    /// Open the field editor from the toolbar button, which is there whether or not any
    /// field exists.
    private func openFieldEditor() {
        let addButton = find("add-field-button")
        XCTAssertTrue(addButton.waitForExistence(timeout: 10), "The toolbar should offer to add a field")
        addButton.tap()
        XCTAssertTrue(find("field-label-input").waitForExistence(timeout: 5), "The field editor should open")
    }

    // MARK: - Scenario: Custom fields tab shows content or empty state

    func testCustomFieldsTabShowsContent() {
        given("I am authenticated as admin and the server holds no custom fields") {
            launchAsAdminWithAPI()
        }
        when("I navigate to the custom fields tab") {
            navigateToCustomFields()
        }
        then("I see the empty state, not a list or a spinner") {
            XCTAssertTrue(
                find("custom-fields-empty-state").waitForExistence(timeout: 15),
                "A server with no custom fields should show the empty state"
            )
            XCTAssertFalse(find("custom-fields-list").exists)
            XCTAssertFalse(find("custom-fields-loading").exists)
        }
    }

    // MARK: - Scenario: Add field button opens the editor

    func testAddFieldButtonExists() {
        given("I am on the custom fields tab") {
            launchAsAdminWithAPI()
            navigateToCustomFields()
        }
        when("I tap the add button") {
            openFieldEditor()
        }
        then("the editor will not save a field without a label") {
            XCTAssertFalse(
                app.buttons["field-save-button"].isEnabled,
                "Save must stay off until the field has a label"
            )
        }
    }

    // MARK: - Scenario: Create field sheet opens

    func testCreateFieldSheetOpens() {
        given("I am on the custom fields tab") {
            launchAsAdminWithAPI()
            navigateToCustomFields()
        }
        when("I open the editor") {
            openFieldEditor()
        }
        then("a new field defaults to optional Text, shown in Notes") {
            XCTAssertEqual(find("field-required-toggle").value as? String, "0", "A new field is optional")
            XCTAssertTrue(
                find("field-type-picker").label.contains("Text") || find("field-type-picker").value as? String == "Text",
                "A new field defaults to the Text type"
            )
            XCTAssertTrue(
                find("field-context-picker").label.contains("Notes") || find("field-context-picker").value as? String == "Notes",
                "A new field defaults to the Notes context"
            )
        }
    }

    // MARK: - Scenario: Cancel field creation

    func testCancelFieldCreation() {
        let label = "Cancelled \(UUID().uuidString.prefix(8))"
        given("I am on the custom fields tab with the editor open and a label typed") {
            launchAsAdminWithAPI()
            navigateToCustomFields()
            openFieldEditor()
            let input = find("field-label-input")
            input.tap()
            input.typeText(label)
        }
        when("I cancel") {
            app.buttons["cancel-field-edit"].tap()
        }
        then("the editor is gone and nothing was saved") {
            XCTAssertTrue(find("field-label-input").waitForNonExistence(timeout: 10), "Cancel should close the editor")
            XCTAssertTrue(find("custom-fields-empty-state").waitForExistence(timeout: 10), "Cancelling must not add a field")
            XCTAssertFalse(serverFieldLabels().contains(label), "A cancelled field must not reach the server")
        }
    }

    // MARK: - Scenario: Saving a field

    func testEditorFormElementsExist() {
        let label = "Saved \(UUID().uuidString.prefix(8))"
        given("I am on the custom fields tab with the editor open") {
            launchAsAdminWithAPI()
            navigateToCustomFields()
            openFieldEditor()
        }
        when("I give the field a label and save it") {
            let input = find("field-label-input")
            input.tap()
            input.typeText(label)
            let save = app.buttons["field-save-button"]
            XCTAssertTrue(save.isEnabled, "Save should be available once the field has a label")
            save.tap()
        }
        then("the field is listed and the server holds it") {
            XCTAssertTrue(find("field-label-input").waitForNonExistence(timeout: 10), "Saving should close the editor")
            XCTAssertTrue(find("custom-fields-list").waitForExistence(timeout: 10), "A server with a field shows the list")
            XCTAssertTrue(
                app.staticTexts[label].waitForExistence(timeout: 10),
                "The saved field should be in the list"
            )
            XCTAssertEqual(serverFieldLabels(), [label], "The server should hold exactly the field that was saved")
        }
    }

    // MARK: - Scenario: Empty state shows create button

    func testEmptyStateShowsCreateButton() {
        given("I am on the custom fields tab of a server with no fields") {
            launchAsAdminWithAPI()
            navigateToCustomFields()
        }
        when("I tap the empty state's button") {
            let addFirst = find("add-first-field")
            XCTAssertTrue(addFirst.waitForExistence(timeout: 15), "The empty state should offer to add the first field")
            addFirst.tap()
        }
        then("the field editor opens") {
            XCTAssertTrue(find("field-label-input").waitForExistence(timeout: 5), "Add First Field should open the editor")
        }
    }
}
