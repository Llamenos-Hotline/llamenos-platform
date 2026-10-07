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

    /// Enable case management with the jail-support template (its
    /// `mass_arrest_event` entity type has `category: "event"`) and create
    /// one event through the real create-event sheet. Mirrors
    /// `CaseManagementUITests.seedOneCase()` — event-detail scenarios depend
    /// on an event existing, so this creates one instead of branching on
    /// whatever the shared class hub happens to hold. Leaves the Events
    /// list open on the event just created.
    private func seedOneEvent(title: String = "UI test event \(UUID().uuidString.prefix(8))") {
        TestAdminAPI.setCaseManagement(enabled: true, hubId: testHubId, baseURL: testHubURL)
        TestAdminAPI.applyTemplate("jail-support", hubId: testHubId, baseURL: testHubURL)
        navigateToEvents()

        let createButton = find("events-create-btn")
        let emptyCreateButton = find("events-empty-create-btn")
        guard createButton.waitForExistence(timeout: 10) || emptyCreateButton.waitForExistence(timeout: 3) else {
            XCTFail("A create-event button should be offered once case management is on")
            return
        }
        (createButton.exists ? createButton : emptyCreateButton).tap()

        let titleField = find("event-title-field")
        XCTAssertTrue(titleField.waitForExistence(timeout: 5), "Event title field should appear in the create sheet")
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

    /// Tap the first event row in the (already-open) events list.
    private func openFirstEventRow() {
        XCTAssertTrue(find("events-list").waitForExistence(timeout: 10), "Event list should render once an event exists")
        let firstRow = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'event-row-'"))
            .firstMatch
        XCTAssertTrue(firstRow.waitForExistence(timeout: 5), "At least one event row should be visible")
        firstRow.tap()
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

    /// Verifies event rows render once an event exists in the system.
    func testEventListShowsEventRows() {
        given("case management is enabled with an event") {
            seedOneEvent()
        }
        when("I navigate to events") {
            navigateToEvents()
        }
        then("I should see at least one event row") {
            XCTAssertTrue(find("events-list").waitForExistence(timeout: 10), "Event list should render once an event exists")
            let eventRows = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'event-row-'"))
            XCTAssertTrue(eventRows.firstMatch.waitForExistence(timeout: 5), "At least one event row should be visible")
        }
    }

    // MARK: - Scenario: Event detail shows info

    /// Verifies tapping an event row opens the detail view with tabs.
    /// `EventDetailTab.allCases` is rendered unconditionally by a `ForEach`
    /// (see `EventDetailView.swift`), so all 4 tabs must exist once a row
    /// has been tapped — this is not conditional on event data.
    func testEventDetailShowsInfo() {
        given("case management is enabled with an event") {
            seedOneEvent()
        }
        when("I navigate to events and tap the event") {
            navigateToEvents()
            openFirstEventRow()
        }
        then("I should see the event detail with all 4 tabs") {
            XCTAssertTrue(
                find("event-details-tab").waitForExistence(timeout: 5),
                "Details tab content should be visible by default in event detail"
            )
            XCTAssertTrue(find("event-tab-details").exists, "Details tab should exist in event detail")
            XCTAssertTrue(find("event-tab-subEvents").exists, "Sub-events tab should exist in event detail")
            XCTAssertTrue(find("event-tab-cases").exists, "Linked cases tab should exist in event detail")
            XCTAssertTrue(find("event-tab-reports").exists, "Linked reports tab should exist in event detail")
        }
    }

    // MARK: - Scenario: Event detail tabs switch content

    /// Verifies switching between event detail tabs renders correct content.
    /// All 4 tabs render unconditionally (see `testEventDetailShowsInfo`), so
    /// each tap-and-assert below is unconditional too.
    func testEventDetailTabSwitching() {
        given("case management is enabled with an event") {
            seedOneEvent()
        }
        when("I open an event detail") {
            navigateToEvents()
            openFirstEventRow()
        }
        then("switching between tabs should render the correct content areas") {
            XCTAssertTrue(
                find("event-details-tab").waitForExistence(timeout: 5),
                "Details tab content should render by default"
            )

            find("event-tab-subEvents").tap()
            XCTAssertTrue(
                find("event-sub-events-tab").waitForExistence(timeout: 3),
                "Sub-events content should render when Sub-Events tab is selected"
            )

            find("event-tab-cases").tap()
            XCTAssertTrue(
                find("event-linked-cases-tab").waitForExistence(timeout: 3),
                "Linked cases content should render when Cases tab is selected"
            )

            find("event-tab-reports").tap()
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

    // MARK: - Scenario: Event search field visible

    /// Verifies the search field is present on the event list screen.
    /// `events-search-field` only renders inside `eventListContent`, which
    /// requires at least one event — see `EventListView.swift`.
    func testEventSearchFieldVisible() {
        given("case management is enabled with an event") {
            seedOneEvent()
        }
        when("I navigate to events") {
            navigateToEvents()
        }
        then("the search field should be visible") {
            XCTAssertTrue(
                find("events-search-field").waitForExistence(timeout: 10),
                "Events search field should be visible once an event exists"
            )
        }
    }

    // MARK: - Scenario: Create event button visible for admin

    /// Verifies the create event button is visible once case management is
    /// enabled with an event-category entity type. `events-create-btn` only
    /// requires `cmsEnabled && !eventEntityTypes.isEmpty` — not an existing
    /// event — so this does not need `seedOneEvent()`'s extra create step.
    func testCreateEventButtonVisible() {
        given("case management is enabled with an event entity type") {
            TestAdminAPI.setCaseManagement(enabled: true, hubId: testHubId, baseURL: testHubURL)
            TestAdminAPI.applyTemplate("jail-support", hubId: testHubId, baseURL: testHubURL)
        }
        when("I navigate to events") {
            navigateToEvents()
        }
        then("the create event button should be visible") {
            XCTAssertTrue(
                find("events-create-btn").waitForExistence(timeout: 10),
                "Create event button should be visible for admins once an event entity type exists"
            )
        }
    }
}
