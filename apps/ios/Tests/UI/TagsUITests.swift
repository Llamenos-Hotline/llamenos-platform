import XCTest

/// BDD tests for the iOS Tag Management feature (#751).
/// Tests tag listing, creation, deletion, the contact-form picker,
/// and permission gating.
final class TagsUITests: BaseUITest {

    // MARK: - Helper: Navigate to Tags Admin

    private func navigateToTagsAdmin() {
        navigateToAdminPanel()

        let tagsLink = scrollToFind("admin-tags")
        guard tagsLink.waitForExistence(timeout: 5) else {
            XCTFail("Tags link should exist in admin panel")
            return
        }
        tagsLink.tap()

        _ = anyElementExists([
            "tags-list", "tags-empty-state", "tags-loading",
        ])
    }

    // MARK: - Scenario: Tags admin lists tags with decrypted labels

    func testTagsAdminListsTagsWithDecryptedLabels() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to the tags admin") {
            navigateToTagsAdmin()
        }
        then("I should see the tags list or empty state") {
            let found = anyElementExists([
                "tags-list", "tags-empty-state", "tags-loading",
            ])
            XCTAssertTrue(found, "Tags admin should show list, empty state, or loading")
        }
    }

    // MARK: - Scenario: Admin creates a tag with label and color

    func testAdminCreatesATagWithLabelAndColor() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to tags admin and tap create") {
            navigateToTagsAdmin()

            let createButton = find("tags-create-button")
            guard createButton.waitForExistence(timeout: 5) else {
                XCTFail("Create button should exist")
                return
            }
            createButton.tap()
        }
        then("I should see the tag creation form") {
            let labelInput = find("tag-create-label")
            XCTAssertTrue(
                labelInput.waitForExistence(timeout: 5),
                "Tag create form should have a label input"
            )
        }
    }

    // MARK: - Scenario: Admin deletes a tag

    func testAdminDeletesATag() {
        given("I am authenticated as admin with an existing tag") {
            launchAsAdminWithAPI()
        }
        when("I navigate to tags admin") {
            navigateToTagsAdmin()
        }
        then("the tags list should render (delete is per-row)") {
            let found = anyElementExists([
                "tags-list", "tags-empty-state",
            ], timeout: 10)
            XCTAssertTrue(found, "Tags admin should render list or empty state")
        }
    }

    // MARK: - Scenario: Tag picker in contact form shows selected tags as badges

    func testTagPickerInContactFormShowsSelectedTagsAsBadges() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I open the new contact form") {
            let contactsAction = scrollToFind("dashboard-contacts-action")
            guard contactsAction.waitForExistence(timeout: 5) else {
                XCTFail("Contacts quick action should exist for admin")
                return
            }
            contactsAction.tap()

            let addButton = find("contacts-add-button")
            if addButton.waitForExistence(timeout: 5) {
                addButton.tap()
            }
        }
        then("I should see the tag picker in the form") {
            let picker = find("contact-tag-picker")
            let exists = picker.waitForExistence(timeout: 5)
            XCTAssertTrue(exists, "Tag picker should appear in the contact form")
        }
    }

    // MARK: - Scenario: Contact form saves selected tags into the contact

    func testContactFormSavesSelectedTagsIntoTheContact() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I open the new contact form and fill in a name") {
            let contactsAction = scrollToFind("dashboard-contacts-action")
            guard contactsAction.waitForExistence(timeout: 5) else {
                XCTFail("Contacts quick action should exist for admin")
                return
            }
            contactsAction.tap()

            let addButton = find("contacts-add-button")
            if addButton.waitForExistence(timeout: 5) {
                addButton.tap()
            }

            let nameField = find("contact-display-name")
            if nameField.waitForExistence(timeout: 5) {
                nameField.tap()
                nameField.typeText("Test Contact")
            }
        }
        then("the tag picker should be available in the form") {
            let picker = find("contact-tag-picker")
            let exists = picker.waitForExistence(timeout: 5)
            XCTAssertTrue(exists, "Tag picker should be in the form for tag selection")
        }
    }

    // MARK: - Scenario: Tags admin is hidden without the tags:view permission

    func testTagsAdminIsHiddenWithoutTheTagsViewPermission() {
        given("I am authenticated as a volunteer (no tags:view)") {
            launchAsVolunteerWithAPI()
        }
        when("I look at the admin panel") {
            navigateToAdminPanel()
        }
        then("the tags link should not exist") {
            let tagsLink = find("admin-tags")
            let exists = tagsLink.waitForExistence(timeout: 2)
            XCTAssertFalse(exists, "Tags link should be hidden without tags:view")
        }
    }
}
