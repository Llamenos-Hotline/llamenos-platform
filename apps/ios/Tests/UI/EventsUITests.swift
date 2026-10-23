import XCTest

/// XCUITest suite for Events views.
/// Tests event list, event detail tabs, search, and navigation.
///
/// Maps to BDD scenarios: event-list, event-detail, event-tabs.
final class EventsUITests: BaseUITest {

    // MARK: - Helpers

    /// Navigate to the real Events screen: `AdminTabView` presents
    /// `EventListView()` behind the "admin-events" link (see
    /// `apps/ios/Sources/Views/Admin/AdminTabView.swift`). There is no
    /// "dashboard-events-action" card anywhere in the app — the previous
    /// version of this helper tried that first and fell back to the Cases
    /// tab, which is a different screen entirely, so every test here used to
    /// check Cases-tab state instead of Events state (#1245).
    private func navigateToEvents() {
        navigateToAdminPanel()
        let eventsLink = scrollToFind("admin-events", maxSwipes: 5, timeout: 10)
        guard eventsLink.exists else {
            XCTFail("Events link should exist in the admin panel")
            return
        }
        eventsLink.tap()
        _ = anyElementExists([
            "events-list",
            "events-loading",
            "events-cms-disabled",
            "events-empty",
        ], timeout: 10)
    }

    /// Put the class hub in the state the event scenarios need — case management on,
    /// with the jail-support template (its `mass_arrest_event` entity type has
    /// `category: "event"`) — and launch the app as an admin of it. The hub is
    /// configured BEFORE the launch so the first Events load already sees it.
    private func launchWithEventsEnabled() {
        TestAdminAPI.setCaseManagement(enabled: true, hubId: testHubId, baseURL: testHubURL)
        TestAdminAPI.applyTemplate("jail-support", hubId: testHubId, baseURL: testHubURL)
        launchAsAdminWithAPI()
    }

    /// Create an event through the real create-event sheet, from the open Events
    /// screen, and wait for the sheet to close. Event titles are encrypted
    /// client-side, so the app is the only thing that can author one — there is
    /// no API to seed it through.
    private func createEvent(titled title: String) {
        let createButton = find("events-create-btn")
        let emptyCreateButton = find("events-empty-create-btn")
        guard createButton.waitForExistence(timeout: 10) || emptyCreateButton.waitForExistence(timeout: 3) else {
            XCTFail("A create-event button should be offered once case management is on")
            return
        }
        (createButton.exists ? createButton : emptyCreateButton).tap()

        let titleField = find("event-title-field")
        guard titleField.waitForExistence(timeout: 5) else {
            XCTFail("Event title field should appear in the create sheet")
            return
        }
        titleField.tap()
        titleField.typeText(title)

        let submit = find("event-create-submit")
        XCTAssertTrue(submit.isEnabled, "Create should be enabled once a title is entered")
        submit.tap()

        XCTAssertTrue(
            find("event-title-field").waitForNonExistence(timeout: 20),
            "The create sheet should close once the event is created"
        )
    }

    /// The list row for the event with this title. Titles are unique per test, so the
    /// row is identified by what the user sees in it, not by its server-assigned id.
    private func eventRow(titled title: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'event-row-' AND label CONTAINS %@", title))
            .firstMatch
    }

    private func uniqueEventTitle() -> String {
        "UI test event \(UUID().uuidString.prefix(8))"
    }

    // MARK: - Scenario: Event list shows CMS-disabled state on a fresh hub

    /// Verifies the event list screen shows the CMS-disabled state when case
    /// management is off.
    ///
    /// Forces case management off rather than relying on the hub's default —
    /// other test methods on this class's shared hub may have already turned
    /// it on, and XCTest's execution order within a class is not guaranteed.
    func testEventListShowsEvents() {
        given("case management is explicitly disabled on this hub") {
            TestAdminAPI.setCaseManagement(enabled: false, hubId: testHubId, baseURL: testHubURL)
            launchAsAdminWithAPI()
        }
        when("I navigate to events") {
            navigateToEvents()
        }
        then("I should see the CMS-disabled state") {
            XCTAssertTrue(
                find("events-cms-disabled").waitForExistence(timeout: 10),
                "A fresh hub has case management disabled by default, so Events should show the disabled state"
            )
        }
    }

    // MARK: - Scenario: Event list shows event rows

    /// Verifies a created event comes back as a list row carrying its title.
    func testEventListShowsEventRows() {
        let title = uniqueEventTitle()
        given("case management is enabled and the app is launched as admin") {
            launchWithEventsEnabled()
        }
        when("I navigate to events and create an event") {
            navigateToEvents()
            createEvent(titled: title)
        }
        then("the list should show a row for that event") {
            XCTAssertTrue(find("events-list").waitForExistence(timeout: 10), "Event list should render once an event exists")
            XCTAssertTrue(
                eventRow(titled: title).waitForExistence(timeout: 10),
                "The created event should appear in the list under its own title"
            )
        }
    }

    // MARK: - Scenario: Event detail shows info

    /// Verifies tapping an event row opens the detail view with tabs.
    /// `EventDetailTab.allCases` is rendered unconditionally by a `ForEach`
    /// (see `EventDetailView.swift`), so all 4 tabs must exist once a row
    /// has been tapped — this is not conditional on event data.
    func testEventDetailShowsInfo() {
        let title = uniqueEventTitle()
        given("case management is enabled and the app is launched as admin") {
            launchWithEventsEnabled()
        }
        when("I create an event and tap its row") {
            navigateToEvents()
            createEvent(titled: title)
            let row = eventRow(titled: title)
            XCTAssertTrue(row.waitForExistence(timeout: 10), "The created event should appear in the list")
            row.tap()
        }
        then("I should see the event detail with all 4 tabs") {
            XCTAssertTrue(
                find("event-details-tab").waitForExistence(timeout: 5),
                "Details tab content should be visible by default in event detail"
            )
            XCTAssertTrue(find("event-tab-details").exists, "Details tab should exist in event detail")
            XCTAssertTrue(find("event-tab-sub_events").exists, "Sub-events tab should exist in event detail")
            XCTAssertTrue(find("event-tab-linked_cases").exists, "Linked cases tab should exist in event detail")
            XCTAssertTrue(find("event-tab-linked_reports").exists, "Linked reports tab should exist in event detail")
        }
    }

    // MARK: - Scenario: Event detail tabs switch content

    /// Verifies switching between event detail tabs renders correct content.
    /// All 4 tabs render unconditionally (see `testEventDetailShowsInfo`), so
    /// each tap-and-assert below is unconditional too.
    func testEventDetailTabSwitching() {
        let title = uniqueEventTitle()
        given("case management is enabled and the app is launched as admin") {
            launchWithEventsEnabled()
        }
        when("I create an event and open its detail") {
            navigateToEvents()
            createEvent(titled: title)
            let row = eventRow(titled: title)
            XCTAssertTrue(row.waitForExistence(timeout: 10), "The created event should appear in the list")
            row.tap()
        }
        then("switching between tabs should render the correct content areas") {
            XCTAssertTrue(
                find("event-details-tab").waitForExistence(timeout: 5),
                "Details tab content should render by default"
            )

            find("event-tab-sub_events").tap()
            XCTAssertTrue(
                find("event-sub-events-tab").waitForExistence(timeout: 3),
                "Sub-events content should render when Sub-Events tab is selected"
            )

            find("event-tab-linked_cases").tap()
            XCTAssertTrue(
                find("event-linked-cases-tab").waitForExistence(timeout: 3),
                "Linked cases content should render when Cases tab is selected"
            )

            find("event-tab-linked_reports").tap()
            XCTAssertTrue(
                find("event-linked-reports-tab").waitForExistence(timeout: 3),
                "Linked reports content should render when Reports tab is selected"
            )

            find("event-tab-details").tap()
            XCTAssertTrue(
                find("event-details-tab").waitForExistence(timeout: 3),
                "Details content should render when Details tab is reselected"
            )
        }
    }

    // MARK: - Scenario: Event search filters the list

    /// Verifies the search field filters the list by event title: with two events
    /// in the list, a query naming one of them keeps that row and drops the other.
    /// `events-search-field` only renders inside `eventListContent`, which
    /// requires at least one event — see `EventListView.swift`.
    func testEventSearchFiltersByTitle() {
        let token = UUID().uuidString.prefix(8).lowercased()
        let matchingTitle = "Searchable \(token)"
        let otherTitle = uniqueEventTitle()
        given("case management is enabled and the app is launched as admin") {
            launchWithEventsEnabled()
        }
        when("I create two events and search for one of them by title") {
            navigateToEvents()
            createEvent(titled: matchingTitle)
            createEvent(titled: otherTitle)
            XCTAssertTrue(eventRow(titled: matchingTitle).waitForExistence(timeout: 10), "The first event should appear in the list")
            XCTAssertTrue(eventRow(titled: otherTitle).waitForExistence(timeout: 10), "The second event should appear in the list")

            let searchField = find("events-search-field")
            XCTAssertTrue(searchField.waitForExistence(timeout: 10), "Events search field should be visible once an event exists")
            searchField.tap()
            searchField.typeText(String(token))
        }
        then("only the matching event should remain in the list") {
            XCTAssertTrue(
                eventRow(titled: otherTitle).waitForNonExistence(timeout: 5),
                "An event whose title does not match the query should be filtered out"
            )
            XCTAssertTrue(
                eventRow(titled: matchingTitle).exists,
                "The event whose title matches the query should stay in the list"
            )
        }
    }

    // MARK: - Scenario: Create event button opens the create sheet

    /// Verifies the create event button works for an admin once case management
    /// is enabled with an event-category entity type. `events-create-btn` only
    /// requires `cmsEnabled && !eventEntityTypes.isEmpty` — not an existing
    /// event — so no event needs creating first.
    func testCreateEventButtonOpensCreateSheet() {
        given("case management is enabled with an event entity type and the app is launched as admin") {
            launchWithEventsEnabled()
        }
        when("I navigate to events and tap the create event button") {
            navigateToEvents()
            let createButton = find("events-create-btn")
            XCTAssertTrue(
                createButton.waitForExistence(timeout: 10),
                "Create event button should be offered for admins once an event entity type exists"
            )
            XCTAssertTrue(createButton.isEnabled, "Create event button should be enabled once an event entity type exists")
            createButton.tap()
        }
        then("the create-event sheet should open") {
            XCTAssertTrue(
                find("event-title-field").waitForExistence(timeout: 5),
                "Tapping the create event button should present the create sheet"
            )
        }
    }
}
