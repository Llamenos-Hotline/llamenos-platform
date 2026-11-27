import XCTest

/// BDD tests for the Contacts & Timeline feature (Epic 243).
/// Tests admin-only visibility and navigation to the contacts screen.
/// Note: Detailed view tests require a live API (Epic 240) — mock mode causes
/// XCUITest idle detection issues with SwiftUI async tasks.
final class ContactsUITests: BaseUITest {

    // MARK: - Scenario: Contacts quick action visible for admin

    func testContactsQuickActionVisibleForAdmin() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        then("the dashboard should show a contacts quick action") {
            let contactsAction = scrollToFind("dashboard-contacts-action")
            XCTAssertTrue(
                contactsAction.exists,
                "Dashboard should have a contacts quick action card for admin"
            )
        }
    }

    // MARK: - Scenario: Contacts quick action hidden for volunteer

    func testContactsQuickActionHiddenForVolunteer() {
        given("I am authenticated as a volunteer") {
            launchAuthenticated()
        }
        then("the dashboard should not show a contacts quick action") {
            let contactsAction = find("dashboard-contacts-action")
            XCTAssertFalse(
                contactsAction.waitForExistence(timeout: 3),
                "Dashboard should not have contacts quick action for volunteer"
            )
        }
    }

    // MARK: - Scenario: Contacts navigation link is tappable

    func testContactsActionIsTappable() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        then("the contacts action should exist and be accessible") {
            let contactsAction = scrollToFind("dashboard-contacts-action")
            XCTAssertTrue(contactsAction.exists, "Contacts action should exist")
            XCTAssertTrue(contactsAction.isEnabled, "Contacts action should be enabled")
        }
    }

    // MARK: - Scenario: Creating a contact stores it sealed, for every reader

    /// Every contact in the class hub, as the directory lists them to an admin.
    private func persistedContacts() -> [[String: Any]] {
        guard let data = TestAdminAPI.send("GET", "/api/hubs/\(testHubId)/directory", baseURL: testHubURL),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let contacts = json["contacts"] as? [[String: Any]] else {
            XCTFail("GET /api/hubs/\(testHubId)/directory did not return { contacts: [...] }")
            return []
        }
        return contacts
    }

    private func pubkeys(of envelopes: Any?) -> Set<String> {
        Set((envelopes as? [[String: Any]] ?? []).compactMap { $0["pubkey"] as? String })
    }

    /// #2792: the form used to refuse every save (it read a hub key nothing ever set), and no
    /// test ever saved a contact. This one saves, then reads the row the SERVER kept.
    ///
    /// What it asserts about the stored row is what the server can see, which is all a test
    /// outside the app's crypto can: nothing derived from the contact's data, a sealed summary
    /// and PII, and an envelope for the hub's admin reader — the second member who must be able
    /// to open it. That the envelope really opens is `ContactFormViewModelTests`, which unlocks
    /// as that second reader.
    func testAdminCreatesAContactThatIsStoredSealedForTheHubAdminReader() {
        let stamp = Int(Date().timeIntervalSince1970)
        let name = "Maria Gonzalez \(stamp)"
        let phone = "5551\(String(stamp).suffix(6))"
        let email = "maria\(stamp)@example.org"
        var before: Set<String> = []
        given("I am authenticated as admin and the hub holds no contact of this test's") {
            launchAsAdminWithAPI()
            before = Set(persistedContacts().compactMap { $0["id"] as? String })
        }
        when("I fill in the new contact form and save it") {
            openNewContactForm()
            typeText(name, into: find("contact-display-name"))
            typeText(phone, into: find("contact-phone"))
            typeText(email, into: find("contact-email"))
            tapWhenSettled(app.buttons["contact-save"])
        }
        then("the form closes, which only a stored contact does") {
            XCTAssertTrue(
                awaitCondition(timeout: BaseUITest.eventBackstop) { !self.find("contact-display-name").exists },
                "The form should close once the contact is saved — a refused save keeps it open"
            )
        }
        and("the server holds one new contact, sealed, with an envelope for the hub's admin reader") {
            let created = persistedContacts().filter { !before.contains($0["id"] as? String ?? "") }
            XCTAssertEqual(created.count, 1, "Expected exactly one new contact, got \(created.count)")
            guard let row = created.first,
                  let rowData = try? JSONSerialization.data(withJSONObject: row) else { return }

            let stored = String(decoding: rowData, as: UTF8.self).lowercased()
            for secret in [name, phone, email, "gonzalez"] {
                XCTAssertFalse(stored.contains(secret.lowercased()), "The stored contact carries \"\(secret)\"")
            }
            XCTAssertFalse((row["encryptedSummary"] as? String ?? "").isEmpty, "The summary was not stored")
            XCTAssertFalse((row["encryptedPII"] as? String ?? "").isEmpty, "The PII was not stored")
            XCTAssertTrue(
                pubkeys(of: row["summaryEnvelopes"]).contains(TestAdminAPI.x25519Hex),
                "The hub's admin reader has no envelope for the summary"
            )
            XCTAssertTrue(
                pubkeys(of: row["piiEnvelopes"]).contains(TestAdminAPI.x25519Hex),
                "The hub's admin reader has no envelope for the PII"
            )
            XCTAssertEqual(row["identifierHashes"] as? [String] ?? [], [], "A search index derived from the contact was stored")
            XCTAssertNil(row["nameHash"] as? String, "A name index was stored")
        }
    }
}
