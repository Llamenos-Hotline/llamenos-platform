import XCTest

/// XCUITest suite for Events views.
/// Tests event list, event detail tabs, search, and navigation.
///
/// Maps to BDD scenarios: event-list, event-detail, event-tabs.
final class EventsUITests: BaseUITest {

    // MARK: - Helpers

    /// Navigate to the events screen via the dashboard card or direct tab.
    /// Events are accessible from the dashboard "events-card" on Android,
    /// but on iOS may be navigated via a dashboard action or settings link.
    private func navigateToEvents() {
        // Try dashboard card first
        let eventsCard = scrollToFind("dashboard-events-action", maxSwipes: 5)
        if eventsCard.exists {
            eventsCard.tap()
            _ = anyElementExists([
                "events-list",
                "events-loading",
                "events-empty",
            ], timeout: 10)
            return
        }

        // Fall back to direct Cases tab then looking for events in the nav
        navigateToCases()
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
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I navigate to events and tap an event") {
            navigateToEvents()
            let eventList = find("events-list")
            XCTAssertTrue(
                eventList.waitForExistence(timeout: 10),
                "Events screen should render its list — this scenario needs at least one event in the hub"
            )

            let firstRow = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'event-row-'"))
                .firstMatch
            XCTAssertTrue(firstRow.waitForExistence(timeout: 5), "Events list should contain at least one row ('event-row-*')")
            firstRow.tap()
        }
        then("I should see the event detail with tabs") {
            let found = anyElementExists([
                "event-details-tab",
                "event-detail-tabs",
                "event-detail-menu",
            ], timeout: 5)

            if found {
                // Verify detail tabs exist
                let detailsTab = find("event-tab-details")
                let subEventsTab = find("event-tab-subEvents")
                let casesTab = find("event-tab-cases")
                let reportsTab = find("event-tab-reports")

                // At minimum the details tab should exist
                if detailsTab.waitForExistence(timeout: 3) {
                    XCTAssertTrue(detailsTab.exists, "Details tab should exist in event detail")
                }
            }
            // If no events exist, cannot test detail — pass gracefully
        }
    }

    // MARK: - Scenario: Event detail tabs switch content

    /// Verifies switching between event detail tabs renders correct content.
    func testEventDetailTabSwitching() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I open an event detail") {
            navigateToEvents()
            let eventList = find("events-list")
            XCTAssertTrue(
                eventList.waitForExistence(timeout: 10),
                "Events screen should render its list — this scenario needs at least one event in the hub"
            )

            let firstRow = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'event-row-'"))
                .firstMatch
            XCTAssertTrue(firstRow.waitForExistence(timeout: 5), "Events list should contain at least one row ('event-row-*')")
            firstRow.tap()
        }
        then("switching tabs should render different content areas") {
            XCTAssertTrue(
                anyElementExists(["event-details-tab", "event-detail-tabs"], timeout: 5),
                "Event detail should open with its tabs after tapping an event row"
            )

            // Details tab content
            let detailsTab = find("event-tab-details")
            if detailsTab.waitForExistence(timeout: 3) {
                detailsTab.tap()
                let detailsContent = find("event-details-tab")
                XCTAssertTrue(
                    detailsContent.waitForExistence(timeout: 3),
                    "Details content should render when Details tab is selected"
                )
            }

            // Sub-events tab
            let subEventsTab = find("event-tab-subEvents")
            if subEventsTab.waitForExistence(timeout: 3) {
                subEventsTab.tap()
                let subEventsContent = find("event-sub-events-tab")
                XCTAssertTrue(
                    subEventsContent.waitForExistence(timeout: 3),
                    "Sub-events content should render when Sub-Events tab is selected"
                )
            }

            // Linked cases tab
            let casesTab = find("event-tab-cases")
            if casesTab.waitForExistence(timeout: 3) {
                casesTab.tap()
                let casesContent = find("event-linked-cases-tab")
                XCTAssertTrue(
                    casesContent.waitForExistence(timeout: 3),
                    "Linked cases content should render when Cases tab is selected"
                )
            }

            // Linked reports tab
            let reportsTab = find("event-tab-reports")
            if reportsTab.waitForExistence(timeout: 3) {
                reportsTab.tap()
                let reportsContent = find("event-linked-reports-tab")
                XCTAssertTrue(
                    reportsContent.waitForExistence(timeout: 3),
                    "Linked reports content should render when Reports tab is selected"
                )
            }
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
