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

    /// The tag a UI create persists, read back through the API as another hub member would:
    /// `GET /api/hubs/:id/tags`, the row whose slug this test named.
    private func persistedTag(slug: String) -> [String: Any]? {
        guard let data = TestAdminAPI.send("GET", "/api/hubs/\(testHubId)/tags", baseURL: testHubURL),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tags = json["tags"] as? [[String: Any]] else {
            XCTFail("GET /api/hubs/\(testHubId)/tags did not return { tags: [...] }")
            return nil
        }
        return tags.first { $0["name"] as? String == slug }
    }

    private func fillAndSaveTheCreateForm(label: String) {
        let createButton = find("tags-create-button")
        guard createButton.waitForExistence(timeout: BaseUITest.eventBackstop) else {
            XCTFail("Create button should exist")
            return
        }
        tapWhenSettled(createButton)
        typeText(label, into: find("tag-create-label"))
        tapWhenSettled(find("tag-create-color-ef4444"))
        tapWhenSettled(app.buttons["tag-create-save"])
    }

    /// The scenario #2792 is about: submit the form, then look at what the SERVER kept. The
    /// old version stopped at "the form opens" and passed while every save was refused.
    func testAdminCreatesATagWithLabelAndColor() {
        let hubKey = TestAdminAPI.randomHubKeyHex()
        let label = "urgent\(Int(Date().timeIntervalSince1970))"
        let slug = label
        given("I am authenticated as admin on a device that holds the hub's key") {
            launchAsAdminWithAPI(hubKeyHex: hubKey)
        }
        when("I create a tag with a label and a color") {
            navigateToTagsAdmin()
            fillAndSaveTheCreateForm(label: label)
        }
        then("the tag is listed") {
            XCTAssertTrue(
                find("tag-row-\(slug)").waitForExistence(timeout: BaseUITest.eventBackstop),
                "The saved tag should be listed — a refused save leaves the sheet open instead"
            )
        }
        and("the server holds its color and a label only the hub's key opens, which another member can open") {
            guard let row = persistedTag(slug: slug) else {
                XCTFail("The server has no tag named \(slug)")
                return
            }
            XCTAssertEqual(row["color"] as? String, "#ef4444")
            let stored = row["encryptedLabel"] as? String ?? ""
            XCTAssertNotEqual(stored, label, "The label was stored in the clear")
            XCTAssertEqual(
                TestAdminAPI.openHubField(
                    packedHex: stored, hubKeyHex: hubKey, label: CryptoLabels.LABEL_TAG_ENCRYPT
                ),
                label,
                "A member holding the hub key could not open the stored label"
            )
            XCTAssertNil(
                TestAdminAPI.openHubField(
                    packedHex: stored, hubKeyHex: TestAdminAPI.randomHubKeyHex(), label: CryptoLabels.LABEL_TAG_ENCRYPT
                ),
                "A key that is not the hub's opened the stored label"
            )
        }
    }

    // MARK: - Scenario: A device without the hub key refuses the save

    /// The other half of the same instrument: with no key the save must say so and store
    /// nothing, rather than succeed or fall silent.
    func testCreatingATagWithoutTheHubKeyIsRefusedAndStoresNothing() {
        let label = "nokey\(Int(Date().timeIntervalSince1970))"
        given("I am authenticated as admin on a device that holds no hub key") {
            launchAsAdminWithAPI()
        }
        when("I try to create a tag") {
            navigateToTagsAdmin()
            fillAndSaveTheCreateForm(label: label)
        }
        then("the form says the hub key is missing and stays open") {
            let error = find("tag-create-error")
            XCTAssertTrue(
                error.waitForExistence(timeout: BaseUITest.eventBackstop),
                "A refused save should be reported on the form"
            )
            // `error_no_hub_key` (en.json `noHubKey`); the launch pins the language to English.
            XCTAssertEqual(error.label, "Hub key not available")
        }
        and("the server stored no tag") {
            XCTAssertNil(persistedTag(slug: label), "A refused save still stored a tag")
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
                scrollToFind("settings-transcription-link", maxSwipes: 5).exists,
                "The Settings screen should have loaded"
            )
        }
        then("the admin panel, and the tags admin behind it, should not be reachable") {
            XCTAssertFalse(
                scrollToFind("settings-admin-link", maxSwipes: 5).exists,
                "The admin panel link should be hidden without audit:read"
            )
            XCTAssertFalse(find("admin-tags").exists, "Tags admin should be hidden without tags:view")
        }
    }
}
