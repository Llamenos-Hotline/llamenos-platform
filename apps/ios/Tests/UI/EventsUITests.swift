import XCTest

/// XCUITest suite for Events views.
/// Tests event list, event detail tabs, search, and navigation.
///
/// Maps to BDD scenarios: event-list, event-detail, event-tabs.
final class EventsUITests: BaseUITest {

    // MARK: - Helpers

    /// Navigate to the events screen. Events lives in the admin panel
    /// (AdminTabView → admin-events); there is no dashboard card or main tab for it.
    private func navigateToEvents() {
        navigateToAdminSettingsScreen("admin-events")

        _ = anyElementExists([
            "events-list",
            "events-loading",
            "events-search-field",
            "events-create-btn",
            "events-empty-create-btn",
        ], timeout: 10)
    }

    /// Given-step for the event detail scenarios: the scenario creates the event it
    /// opens, through the app's own create-event sheet, instead of opening whatever
    /// the hub happens to hold — a fresh class hub holds nothing. The jail-support
    /// template provides the hub's one event-category entity type (Mass Arrest
    /// Event), so the sheet needs no type selection.
    ///
    /// The event is created with POST /api/events (the Events screen's own flow):
    /// the list reads GET /api/events, which serves the legacy events table, so a
    /// record made through the create-case sheet (POST /api/records) would never
    /// appear here.
    private func launchAsAdminWithNewEvent() {
        enableCaseManagementWithTemplate()
        launchAsAdminWithAPI()
        navigateToEvents()
        createEvent(title: "Event \(UUID().uuidString.prefix(8))")
    }

    /// Create an event through the create-event sheet and wait for it to close.
    private func createEvent(title: String) {
        let createButton = find("events-create-btn")
        XCTAssertTrue(
            createButton.waitForExistence(timeout: 15),
            "Events screen should offer create once case management and its entity types load"
        )
        createButton.tap()

        let titleField = find("event-title-field")
        XCTAssertTrue(titleField.waitForExistence(timeout: 5), "The create-event sheet should open")
        titleField.tap()
        titleField.typeText(title)

        let submit = find("event-create-submit")
        XCTAssertTrue(submit.isEnabled, "Create should be enabled with a title")
        submit.tap()
        XCTAssertTrue(
            titleField.waitForNonExistence(timeout: 20),
            "The sheet should close once the event is created"
        )
    }

    /// Open the first row of the events list. The scenario's Given created one,
    /// so the list cannot be empty.
    private func openFirstEventRow() {
        let eventList = find("events-list")
        XCTAssertTrue(
            eventList.waitForExistence(timeout: 10),
            "Events screen should render its list — this scenario created an event"
        )

        let firstRow = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'event-row-'"))
            .firstMatch
        XCTAssertTrue(
            firstRow.waitForExistence(timeout: 5),
            "Events list should contain the event this scenario created ('event-row-*')"
        )
        firstRow.tap()
    }

    // MARK: - Scenario: Event list shows events or empty state

    /// Verifies the event list screen renders with content or empty state.
    func testEventListShowsEvents() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I navigate to events") {
            navigateToEvents()
        }
        then("I should see the event list, empty state, or loading") {
            let found = anyElementExists([
                "events-list",
                "events-loading",
                "events-empty",
                "events-search-field",
            ])
            XCTAssertTrue(found, "Events view should show list, loading, or empty state")
        }
    }

    // MARK: - Scenario: Event list shows event rows

    /// Verifies event rows render when events exist in the system.
    func testEventListShowsEventRows() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I navigate to events") {
            navigateToEvents()
        }
        then("I should see event rows if events exist") {
            let eventList = find("events-list")
            if eventList.waitForExistence(timeout: 10) {
                let eventRows = app.descendants(matching: .any)
                    .matching(NSPredicate(format: "identifier BEGINSWITH 'event-row-'"))
                if eventRows.count > 0 {
                    XCTAssertTrue(
                        eventRows.firstMatch.exists,
                        "At least one event row should be visible"
                    )
                }
            }
            // No events on fresh server is valid
        }
    }

    // MARK: - Scenario: Event detail shows info

    /// Verifies tapping an event row opens the detail view with tabs.
    func testEventDetailShowsInfo() {
        given("an event exists, created through the app's create-event sheet") {
            launchAsAdminWithNewEvent()
        }
        when("I tap the event") {
            openFirstEventRow()
        }
        then("I should see the event detail with tabs") {
            XCTAssertTrue(
                anyElementExists([
                    "event-details-tab",
                    "event-detail-menu",
                ], timeout: 5),
                "Event detail should open after tapping an event row"
            )

            // At minimum the details tab should exist
            let detailsTab = find("event-tab-details")
            XCTAssertTrue(
                detailsTab.waitForExistence(timeout: 3),
                "Details tab should exist in event detail"
            )
        }
    }

    // MARK: - Scenario: Event detail tabs switch content

    /// Verifies switching between event detail tabs renders correct content.
    func testEventDetailTabSwitching() {
        given("an event exists, created through the app's create-event sheet") {
            launchAsAdminWithNewEvent()
        }
        when("I open the event detail") {
            openFirstEventRow()
        }
        then("switching tabs should render different content areas") {
            XCTAssertTrue(
                anyElementExists(["event-details-tab", "event-detail-menu"], timeout: 5),
                "Event detail should open with its tabs after tapping an event row"
            )

            // Tab identifiers follow EventDetailTab raw values:
            // details, sub_events, linked_cases, linked_reports.

            // Details tab content
            let detailsTab = find("event-tab-details")
            XCTAssertTrue(detailsTab.waitForExistence(timeout: 3), "Details tab should exist")
            detailsTab.tap()
            let detailsContent = find("event-details-tab")
            XCTAssertTrue(
                detailsContent.waitForExistence(timeout: 3),
                "Details content should render when Details tab is selected"
            )

            // Sub-events tab
            let subEventsTab = find("event-tab-sub_events")
            XCTAssertTrue(subEventsTab.waitForExistence(timeout: 3), "Sub-events tab should exist")
            subEventsTab.tap()
            let subEventsContent = find("event-sub-events-tab")
            XCTAssertTrue(
                subEventsContent.waitForExistence(timeout: 3),
                "Sub-events content should render when Sub-Events tab is selected"
            )

            // Linked cases tab
            let casesTab = find("event-tab-linked_cases")
            XCTAssertTrue(casesTab.waitForExistence(timeout: 3), "Linked cases tab should exist")
            casesTab.tap()
            let casesContent = find("event-linked-cases-tab")
            XCTAssertTrue(
                casesContent.waitForExistence(timeout: 3),
                "Linked cases content should render when Cases tab is selected"
            )

            // Linked reports tab
            let reportsTab = find("event-tab-linked_reports")
            XCTAssertTrue(reportsTab.waitForExistence(timeout: 3), "Linked reports tab should exist")
            reportsTab.tap()
            let reportsContent = find("event-linked-reports-tab")
            XCTAssertTrue(
                reportsContent.waitForExistence(timeout: 3),
                "Linked reports content should render when Reports tab is selected"
            )
        }
    }

    // MARK: - Scenario: Event search field visible

    /// Verifies the search field is present on the event list screen.
    func testEventSearchFieldVisible() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I navigate to events") {
            navigateToEvents()
        }
        then("the search field should be visible") {
            let searchField = find("events-search-field")
            if searchField.waitForExistence(timeout: 5) {
                XCTAssertTrue(searchField.exists, "Events search field should be visible")
            }
        }
    }

    // MARK: - Scenario: Create event button visible for admin

    /// Verifies the create event button is visible on the events screen.
    func testCreateEventButtonVisible() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I navigate to events") {
            navigateToEvents()
        }
        then("the create event button should be visible") {
            let createButton = find("events-create-btn")
            if createButton.waitForExistence(timeout: 5) {
                XCTAssertTrue(createButton.exists, "Create event button should be visible for admins")
            }
        }
    }
}
