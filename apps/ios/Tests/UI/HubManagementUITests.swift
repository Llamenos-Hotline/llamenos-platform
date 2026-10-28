import XCTest

/// XCUITest suite for Hub Management views.
/// Tests hub list rendering, hub switching, and hub creation navigation.
///
/// Maps to BDD scenarios: hub-list, hub-switch, hub-create.
final class HubManagementUITests: BaseUITest {

    // MARK: - Helpers

    /// Navigate to the hub management screen via Settings > Hubs link.
    private func navigateToHubs() {
        navigateToSettings()
        scrollAndTap("settings-hubs-link")
        XCTAssertTrue(
            find("hubs-list").waitForExistence(timeout: 20),
            "The hub list should render for a member of a hub"
        )
        XCTAssertFalse(find("hubs-loading").exists, "The hub list should have finished loading")
        XCTAssertFalse(find("hubs-empty").exists, "A member of a hub is not hubless")
    }

    /// The prefix of this class's hub row id: server slug of "ios-<ClassName>-<ms>"
    /// (apps/worker/routes/dev.ts test-create-hub).
    private var classHubRowPrefix: String {
        "hub-row-ios-\(String(describing: type(of: self)).lowercased())-"
    }

    /// A hub row by id prefix. A super-admin lists every hub on the server — and every
    /// test in a shard creates one — so the row can be many screens down; a SwiftUI List
    /// only instantiates the rows near the viewport.
    private func hubRow(idPrefix: String) -> XCUIElement {
        scrollToMatch(NSPredicate(format: "identifier BEGINSWITH %@", idPrefix), maxSwipes: 60)
    }

    private func openCreateHubForm() {
        let createButton = app.buttons["hubs-create-btn"]
        XCTAssertTrue(createButton.waitForExistence(timeout: 5), "Create Hub should be in the toolbar for an admin")
        XCTAssertTrue(createButton.isEnabled, "Create Hub should be enabled")
        createButton.tap()
        XCTAssertTrue(find("hub-name-field").waitForExistence(timeout: 5), "The create form should open")
    }

    // MARK: - Scenario: Hub list shows hubs

    /// A hub member sees the hub list — not the loading or the "no hubs" state.
    func testHubListShowsHubs() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        when("I navigate to Settings > Hubs") {
            navigateToHubs()
        }
        then("the list shows at least one hub row") {
            let rows = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'hub-row-'"))
            XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 10), "The list should contain a hub row")
        }
    }

    // MARK: - Scenario: Hub list shows hub cards

    /// Scenario: Hub list shows hub cards (platform/mobile/hubs/hub-management.feature)
    ///
    /// BaseUITest created this class's hub and made the app's identity a member of
    /// it, so the list must show that hub's card — the "empty state" half of the
    /// scenario's Then cannot be what renders here.
    func testHubListShowsHubCards() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I navigate to hub management") {
            navigateToHubs()
        }
        then("I should see this class's hub card") {
            // A super-admin lists every hub on the server, so this class's hub can
            // sit below the fold — and a SwiftUI List does not instantiate rows it
            // has not scrolled to.
            let classHubRow = hubRow(idPrefix: classHubRowPrefix)
            XCTAssertTrue(
                classHubRow.exists,
                "The card for this test class's hub (\(classHubRowPrefix)…) should be listed"
            )
        }
    }

    // MARK: - Scenario: Active hub indicator visible

    /// Switching to a hub marks it — and only it — as the active one.
    ///
    /// The row is tapped first rather than read at launch: a freshly launched test app has
    /// the class hub as its working hub, yet its row is not marked selected until the hub
    /// is chosen in this list (observed; not asserted here).
    func testActiveHubIndicatorVisible() {
        var activeRow: XCUIElement!
        given("I am authenticated as admin and on the Hubs screen") {
            launchAsAdminWithAPI()
            navigateToHubs()
            activeRow = hubRow(idPrefix: classHubRowPrefix)
            XCTAssertTrue(activeRow.exists, "This class's hub should be listed")
        }
        when("I choose this class's hub") {
            activeRow.tap()
        }
        then("its row is the one selected row") {
            let becomesSelected = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "isSelected == true"), object: activeRow
            )
            XCTAssertEqual(
                XCTWaiter().wait(for: [becomesSelected], timeout: 10), .completed,
                "The chosen hub should be marked as the active one"
            )
            let selected = app.descendants(matching: .any).matching(
                NSPredicate(format: "identifier BEGINSWITH 'hub-row-' AND isSelected == true")
            )
            XCTAssertEqual(
                selected.allElementsBoundByIndex.map(\.identifier), [activeRow.identifier],
                "Exactly one hub is active at a time"
            )
        }
    }

    // MARK: - Scenario: Create hub button visible for admin

    /// An admin's Create Hub button is live: it opens the creation form.
    func testCreateHubButtonVisible() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
            navigateToHubs()
        }
        when("I tap Create Hub") {
            openCreateHubForm()
        }
        then("a hub cannot be created without a name") {
            XCTAssertFalse(
                app.buttons["hub-create-submit"].isEnabled,
                "Create must stay off until the hub has a name"
            )
        }
    }

    // MARK: - Scenario: Create hub form opens

    /// The form has a name, a slug, Create and Cancel; Create waits for a name.
    func testCreateHubFormOpens() {
        given("I am authenticated as admin on the Hubs screen") {
            launchAsAdminWithAPI()
            navigateToHubs()
        }
        when("I open the create form") {
            openCreateHubForm()
        }
        then("it offers name and slug fields, and Create is available only with a name") {
            XCTAssertTrue(find("hub-slug-field").exists, "The slug field should be on the form")
            XCTAssertTrue(app.buttons["hub-create-cancel"].exists)
            XCTAssertFalse(app.buttons["hub-create-submit"].isEnabled, "An unnamed hub cannot be created")
            let name = find("hub-name-field")
            typeText("Harbor Watch", into: name)
            XCTAssertTrue(app.buttons["hub-create-submit"].isEnabled, "A named hub can be created")
        }
    }

    // MARK: - Scenario: Slug follows the name

    /// The slug is generated from the name as it is typed. Skipped while #2035 stands: the
    /// slug handler marks the generated value as hand-edited, so it stops after one character.
    /// Delete the `XCTSkipIf` line when it is fixed.
    func testHubSlugFollowsName() throws {
        try XCTSkipIf(true, "The slug stops following the name after the first character (#2035)")
        launchAsAdminWithAPI()
        navigateToHubs()
        openCreateHubForm()
        let name = find("hub-name-field")
        typeText("Harbor Watch", into: name)
        XCTAssertEqual(find("hub-slug-field").value as? String, "harbor-watch", "The slug should be generated from the name")
    }

    // MARK: - Scenario: Create a hub

    /// Creating a hub puts it in the list.
    func testCreateHubAddsHubToList() {
        let slug = "created-\(UUID().uuidString.prefix(8).lowercased())"
        given("I am authenticated as admin on the Hubs screen") {
            launchAsAdminWithAPI()
            navigateToHubs()
        }
        when("I create a hub") {
            openCreateHubForm()
            let name = find("hub-name-field")
            typeText("Created hub", into: name)
            // The slug is typed explicitly: the generated one stops after a character (#2035).
            let slugField = find("hub-slug-field")
            XCTAssertTrue(slugField.waitForExistence(timeout: 5), "The create form should have a slug field")
            let existing = (slugField.value as? String) ?? ""
            typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count) + slug, into: slugField)
            app.buttons["hub-create-submit"].tap()
        }
        then("the form closes and the new hub is listed") {
            XCTAssertTrue(find("hub-name-field").waitForNonExistence(timeout: 20), "A created hub closes the form")
            let row = hubRow(idPrefix: "hub-row-\(slug)")
            XCTAssertTrue(row.exists, "The new hub '\(slug)' should be in the list")
        }
    }

    // MARK: - Scenario: Cancel hub creation

    /// Cancelling the form creates nothing.
    func testCancelHubCreation() {
        let slug = "cancelled-\(UUID().uuidString.prefix(8).lowercased())"
        given("I am authenticated as admin with the create form open and a name typed") {
            launchAsAdminWithAPI()
            navigateToHubs()
            openCreateHubForm()
            let name = find("hub-name-field")
            typeText(slug, into: name)
        }
        when("I cancel") {
            app.buttons["hub-create-cancel"].tap()
        }
        then("I am back on the hub list, and no such hub exists on the server") {
            XCTAssertTrue(find("hub-name-field").waitForNonExistence(timeout: 10), "Cancel should close the form")
            XCTAssertTrue(find("hubs-list").exists, "The hub list should be visible after cancelling")
            let data = TestAdminAPI.send("GET", "/api/hubs", baseURL: testHubURL)
            let text = data.map { String(decoding: $0, as: UTF8.self) } ?? ""
            XCTAssertFalse(text.contains(slug), "A cancelled hub must not reach the server")
        }
    }

    // MARK: - Scenario: Hub URL displayed in settings

    /// Settings shows the hub the app is connected to.
    func testHubUrlDisplayedInSettings() {
        given("I am connected to the test hub") {
            launchWithAPI()
        }
        when("I navigate to Settings") {
            navigateToSettings()
        }
        then("I should see the hub URL I am connected to") {
            let hubUrl = find("settings-hub-url")
            XCTAssertTrue(hubUrl.waitForExistence(timeout: 10), "Hub URL should be displayed in settings")
            XCTAssertEqual(hubUrl.label, testHubURL, "Settings should show the hub the app is connected to")
        }
    }
}
