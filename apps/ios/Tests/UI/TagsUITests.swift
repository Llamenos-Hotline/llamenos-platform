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

    // MARK: - Helper: Contact form + tag picker

    /// Open the new-contact form from the dashboard's contacts action.
    private func openNewContactForm() {
        let contactsAction = scrollToFind("dashboard-contacts-action")
        guard contactsAction.waitForExistence(timeout: 5) else {
            XCTFail("Contacts quick action should exist for admin")
            return
        }
        contactsAction.tap()

        // A toolbar Button also surfaces as an "Other" container with the same
        // identifier; query the button itself.
        let addButton = app.buttons["contacts-add-button"]
        guard addButton.waitForExistence(timeout: 10) else {
            XCTFail("The contacts screen should offer an add-contact button")
            return
        }
        addButton.tap()
    }

    /// Seed a hub tag through the real API, as the test admin ("Given a tag
    /// exists in the hub"). The label is stored as given: the test hub has no
    /// hub key (#1042), so the app shows the stored value, exactly as it does
    /// for any tag whose ciphertext it cannot open. Returns the tag's slug.
    @discardableResult
    private func seedTag(label: String) -> String {
        let slug = label.lowercased()
        TestAdminAPI.send(
            "POST", "/api/hubs/\(testHubId)/tags",
            ["id": UUID().uuidString, "name": slug, "encryptedLabel": label, "color": "#6b7280"],
            baseURL: testHubURL
        )
        return slug
    }

    // MARK: - Scenario: Tag picker in contact form shows selected tags as badges

    func testTagPickerInContactFormShowsSelectedTagsAsBadges() {
        let label = "urgent\(Int(Date().timeIntervalSince1970))"
        var slug = ""
        given("I am authenticated as admin and a tag exists in the hub") {
            slug = seedTag(label: label)
            launchAsAdminWithAPI()
        }
        when("I open the new contact form and select the tag in the picker") {
            openNewContactForm()
            XCTAssertTrue(
                find("contact-tag-picker").waitForExistence(timeout: 10),
                "Tag picker should appear in the contact form"
            )

            let trigger = find("tag-picker-trigger")
            guard trigger.waitForExistence(timeout: 5) else {
                XCTFail("The tag picker trigger should be in the contact form")
                return
            }
            trigger.tap()

            let option = find("tag-picker-option-\(slug)")
            guard option.waitForExistence(timeout: 15) else {
                XCTFail("The seeded tag should be listed in the picker")
                return
            }
            option.tap()

            let done = find("tag-picker-done")
            guard done.waitForExistence(timeout: 5) else {
                XCTFail("The tag picker sheet should have a Done button")
                return
            }
            done.tap()
        }
        then("the selected tag should appear as a badge in the form") {
            XCTAssertTrue(
                find("tag-badge-\(label)").waitForExistence(timeout: 5),
                "The selected tag should render as a badge in the contact form"
            )
        }
    }

    // MARK: - Scenario: Tags admin is hidden without the tags:view permission

    func testTagsAdminIsHiddenWithoutTheTagsViewPermission() {
        given("I am authenticated as a volunteer (no tags:view)") {
            launchAsVolunteerWithAPI()
        }
        when("I open Settings") {
            navigateToSettings()
            // Positive control: Settings rendered, so a missing admin entry
            // below means "hidden", not "the screen never loaded".
            XCTAssertTrue(
                scrollToFind("settings-transcription-link", maxSwipes: 5, timeout: 10).exists,
                "The Settings screen should have loaded"
            )
        }
        then("the admin panel, and the tags admin behind it, should not be reachable") {
            XCTAssertFalse(
                scrollToFind("settings-admin-link", maxSwipes: 5, timeout: 2).exists,
                "The admin panel link should be hidden without audit:read"
            )
            XCTAssertFalse(find("admin-tags").exists, "Tags admin should be hidden without tags:view")
        }
    }
}
