import XCTest

/// BDD tests for the Admin Custom Fields feature (Epic 244).
/// Tests the custom fields tab, field creation, editing, and deletion.
final class AdminCustomFieldsUITests: BaseUITest {

    // MARK: - Helper: Navigate to Custom Fields Tab

    /// Navigate to the admin panel and tap the Custom Fields navigation link.
    private func navigateToCustomFields() {
        navigateToAdminPanel()

        let customFieldsLink = find("admin-custom-fields")
        guard customFieldsLink.waitForExistence(timeout: 5) else {
            XCTFail("Custom Fields link should exist in admin panel")
            return
        }
        customFieldsLink.tap()

        _ = anyElementExists([
            "custom-fields-list", "custom-fields-empty-state", "custom-fields-loading",
        ])
    }

    // MARK: - Scenario: Custom fields tab shows content or empty state

    func testCustomFieldsTabShowsContent() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to the custom fields tab") {
            navigateToCustomFields()
        }
        then("I should see the fields list or empty state") {
            let found = anyElementExists([
                "custom-fields-list", "custom-fields-empty-state", "custom-fields-loading",
            ])
            XCTAssertTrue(found, "Custom fields view should show list, empty state, or loading")
        }
    }

    // MARK: - Scenario: Add field button exists

    func testAddFieldButtonExists() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to the custom fields tab") {
            navigateToCustomFields()
        }
        then("I should see the add field button") {
            let addButton = anyElementExists(["add-field-button", "add-first-field"], timeout: 5)
            XCTAssertTrue(addButton, "Add field button should exist in toolbar or empty state")
        }
    }

    // MARK: - Scenario: Create field sheet opens

    func testCreateFieldSheetOpens() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to custom fields and tap add") {
            navigateToCustomFields()

            // Try toolbar button first, then empty state button
            let addButton = find("add-field-button")
            if addButton.waitForExistence(timeout: 3) {
                addButton.tap()
            } else {
                let addFirst = find("add-first-field")
                if addFirst.waitForExistence(timeout: 3) {
                    addFirst.tap()
                }
            }
        }
        then("I should see the field editor form") {
            let labelInput = find("field-label-input")
            XCTAssertTrue(
                labelInput.waitForExistence(timeout: 5),
                "Field label input should appear in editor sheet"
            )

            let typePicker = find("field-type-picker")
            XCTAssertTrue(typePicker.exists, "Field type picker should exist")

            let contextPicker = find("field-context-picker")
            XCTAssertTrue(contextPicker.exists, "Field context picker should exist")

            let requiredToggle = find("field-required-toggle")
            XCTAssertTrue(requiredToggle.exists, "Required toggle should exist")

            let saveButton = find("field-save-button")
            XCTAssertTrue(saveButton.exists, "Save button should exist")
        }
    }

    // MARK: - Scenario: Cancel field creation

    func testCancelFieldCreation() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I open the create field sheet and cancel") {
            navigateToCustomFields()

            let addButton = find("add-field-button")
            if addButton.waitForExistence(timeout: 3) {
                addButton.tap()
            } else {
                let addFirst = find("add-first-field")
                if addFirst.waitForExistence(timeout: 3) {
                    addFirst.tap()
                }
            }

            let labelInput = find("field-label-input")
            _ = labelInput.waitForExistence(timeout: 5)

            let cancelButton = find("cancel-field-edit")
            cancelButton.tap()
        }
        then("I should be back on the custom fields screen") {
            let found = anyElementExists([
                "custom-fields-list", "custom-fields-empty-state", "add-field-button",
            ])
            XCTAssertTrue(found, "Should return to custom fields after cancel")
        }
    }

    // MARK: - Scenario: Save button and label input exist in editor

    func testEditorFormElementsExist() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I open the create field sheet") {
            navigateToCustomFields()

            let addButton = find("add-field-button")
            if addButton.waitForExistence(timeout: 3) {
                addButton.tap()
            } else {
                let addFirst = find("add-first-field")
                if addFirst.waitForExistence(timeout: 3) {
                    addFirst.tap()
                }
            }
        }
        then("the form should have all required elements") {
            let labelInput = find("field-label-input")
            XCTAssertTrue(labelInput.waitForExistence(timeout: 5), "Label input should exist")

            let saveButton = find("field-save-button")
            XCTAssertTrue(saveButton.exists, "Save button should exist")

            let cancelButton = find("cancel-field-edit")
            XCTAssertTrue(cancelButton.exists, "Cancel button should exist")

            let requiredToggle = find("field-required-toggle")
            XCTAssertTrue(requiredToggle.exists, "Required toggle should exist")
        }
    }

    // MARK: - Scenario: Empty state shows create button

    func testEmptyStateShowsCreateButton() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to custom fields") {
            navigateToCustomFields()
        }
        then("the empty state should have a create button if no fields exist") {
            let emptyState = find("custom-fields-empty-state")
            if emptyState.waitForExistence(timeout: 5) {
                let createFirst = find("add-first-field")
                XCTAssertTrue(createFirst.exists, "Empty state should have a create button")
            }
            // If fields exist, that's fine too
        }
    }
}
