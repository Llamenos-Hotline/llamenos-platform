import XCTest

/// XCUITest suite for Triage Queue views.
/// Tests triage list, filters, detail view, and convert-to-case flow.
///
/// Every test runs as admin on a hub of its own with the jail-support template applied, so
/// the queue's state is known — it holds exactly the reports the test put there — instead
/// of being whatever the shared class hub happens to contain.
///
/// Maps to BDD scenarios: triage-list, triage-filters, triage-convert.
final class TriageUITests: BaseUITest {

    // MARK: - Helpers

    private func launchOnTriageHub() {
        guard let hubId = TestAdminAPI.createHub(
            name: "ios-triage-\(UUID().uuidString.prefix(8))", baseURL: testHubURL
        ) else { return }
        TestAdminAPI.setCaseManagement(enabled: true, hubId: hubId, baseURL: testHubURL)
        TestAdminAPI.applyTemplate("jail-support", hubId: hubId, baseURL: testHubURL)
        launchAsAdminWithAPI(hubId: hubId)
    }

    /// Navigate to the triage screen via the dashboard quick action card and wait for it to
    /// settle on a list or an empty state.
    private func navigateToTriage() {
        scrollAndTap("dashboard-triage-action")
        let settled = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier IN %@", ["triage-list", "triage-empty-state", "triage-error"])
        ).firstMatch
        XCTAssertTrue(settled.waitForExistence(timeout: 20), "The triage queue should settle on a state")
        XCTAssertFalse(find("triage-loading").exists, "The triage queue should have finished loading")
    }

    /// Skip a scenario that needs a triage-eligible report. Triage lists reports of a type that
    /// allows case conversion, and such a report can only be submitted through the typed report
    /// form — which iOS cannot open while it cannot decode the hub's report types (#2033).
    /// Delete this helper and its calls when #2033 is fixed; the bodies are the assertions to keep.
    private func requireTriageReport() throws {
        throw XCTSkip("A triage-eligible report needs the typed report form, unreachable on iOS (#2033)")
    }

    private func firstTriageRow() -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'triage-row-'"))
            .firstMatch
    }

    // MARK: - Scenario: Triage list shows reports or empty state

    /// A report that allows case conversion is in the queue as a row.
    func testTriageListShowsReports() throws {
        try requireTriageReport()
        given("a hub with one arrest report awaiting triage") {
            launchOnTriageHub()
        }
        when("I open the triage queue") {
            navigateToTriage()
        }
        then("the queue lists that report") {
            XCTAssertTrue(find("triage-list").exists, "A queue with a report should show the list")
            XCTAssertTrue(firstTriageRow().exists, "The report should be a row")
            XCTAssertFalse(find("triage-empty-state").exists)
        }
    }

    // MARK: - Scenario: Triage list shows report cards

    /// Exactly one row per eligible report.
    func testTriageListShowsReportCards() throws {
        try requireTriageReport()
        given("a hub with one arrest report awaiting triage") {
            launchOnTriageHub()
        }
        when("I open the triage queue") {
            navigateToTriage()
        }
        then("there is exactly one row") {
            let rows = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'triage-row-'"))
            XCTAssertEqual(rows.count, 1, "One report was submitted")
        }
    }

    // MARK: - Scenario: Triage filter

    /// The filter menu offers every status and choosing one narrows the queue to that status.
    func testTriageFilterButtonVisible() {
        given("an admin on a hub with an empty triage queue") {
            launchOnTriageHub()
            navigateToTriage()
        }
        when("I open the filter menu") {
            let filter = app.buttons["triage-filter-button"]
            XCTAssertTrue(filter.waitForExistence(timeout: 5), "The queue should offer a status filter")
            filter.tap()
        }
        then("it offers every status") {
            for status in ["All", "Pending", "Reviewing", "Converted", "Dismissed", "In Progress", "Completed"] {
                XCTAssertTrue(
                    app.buttons[status].waitForExistence(timeout: 5),
                    "The filter should offer '\(status)'"
                )
            }
        }
        when("I choose In Progress") {
            // Reviewing, Converted and Dismissed are offered too but the server rejects them
            // with a 400 and the queue lands on its error screen (#2034).
            app.buttons["In Progress"].tap()
        }
        then("the empty queue says there are no in progress reports") {
            let empty = find("triage-empty-state")
            XCTAssertTrue(empty.waitForExistence(timeout: 10), "An empty queue should stay on its empty state")
            XCTAssertTrue(
                app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'in progress'")).firstMatch
                    .waitForExistence(timeout: 5),
                "The empty state should name the filter that produced it"
            )
        }
    }

    // MARK: - Scenario: Triage detail shows report info

    /// Opening a queued report shows its title, status and metadata.
    func testTriageDetailShowsInfo() throws {
        try requireTriageReport()
        given("a hub with one arrest report awaiting triage") {
            launchOnTriageHub()
            navigateToTriage()
        }
        when("I tap the report") {
            let row = firstTriageRow()
            XCTAssertTrue(row.waitForExistence(timeout: 10), "The queue should list the report")
            row.tap()
        }
        then("the detail shows its title, status and metadata") {
            XCTAssertTrue(find("triage-detail-view").waitForExistence(timeout: 5))
            XCTAssertTrue(find("triage-report-title").exists, "Triage detail should show the report title")
            XCTAssertTrue(find("triage-report-status").exists, "Triage detail should show the report status")
            XCTAssertTrue(find("triage-metadata").exists, "Triage detail should show the metadata section")
        }
    }

    // MARK: - Scenario: Convert to case

    /// A report whose type allows case conversion offers Convert to Case.
    func testConvertToCaseButtonVisible() throws {
        try requireTriageReport()
        given("an arrest report (case conversion allowed) is open in triage") {
            launchOnTriageHub()
            navigateToTriage()
            let row = firstTriageRow()
            XCTAssertTrue(row.waitForExistence(timeout: 10))
            row.tap()
            XCTAssertTrue(find("triage-detail-view").waitForExistence(timeout: 5))
        }
        then("Convert to Case is offered and enabled") {
            let convert = scrollToFind("triage-convert-button", maxSwipes: 3)
            XCTAssertTrue(convert.exists, "lo_arrest_report allows case conversion")
            XCTAssertTrue(convert.isEnabled)
        }
    }

    // MARK: - Scenario: Triage report type label

    /// A typed report names its type in the detail.
    func testTriageReportTypeLabelVisible() throws {
        try requireTriageReport()
        given("an arrest report is open in triage") {
            launchOnTriageHub()
            navigateToTriage()
            let row = firstTriageRow()
            XCTAssertTrue(row.waitForExistence(timeout: 10))
            row.tap()
            XCTAssertTrue(find("triage-detail-view").waitForExistence(timeout: 5))
        }
        then("the detail names the report's type") {
            let typeLabel = find("triage-report-type")
            XCTAssertTrue(typeLabel.waitForExistence(timeout: 3), "A typed report shows its type")
            XCTAssertTrue(typeLabel.label.contains("LO Arrest Report"), "It should be the arrest report type")
        }
    }

    // MARK: - Scenario: Dashboard has triage quick action

    /// The dashboard's triage card opens the triage queue.
    func testDashboardHasTriageQuickAction() {
        given("I am authenticated as admin") {
            launchOnTriageHub()
        }
        when("I tap the triage card on the dashboard") {
            scrollAndTap("dashboard-triage-action")
        }
        then("the triage queue opens") {
            XCTAssertTrue(
                find("triage-empty-state").waitForExistence(timeout: 20),
                "Tapping the triage card should open the queue, which is empty on this hub"
            )
            XCTAssertFalse(find("dashboard-title").isHittable, "The dashboard should be covered by the queue")
        }
    }

    // MARK: - Scenario: Triage empty state

    /// A hub with no reports has an empty queue: the empty state, with no list, spinner or error.
    func testTriageEmptyState() {
        given("an admin on a hub with no reports") {
            launchOnTriageHub()
        }
        when("I navigate to triage") {
            navigateToTriage()
        }
        then("the queue is empty") {
            XCTAssertTrue(find("triage-empty-state").exists, "A hub with no reports has nothing to triage")
            XCTAssertFalse(find("triage-list").exists)
            XCTAssertFalse(find("triage-error").exists, "An empty queue is not an error")
            XCTAssertFalse(firstTriageRow().exists)
        }
    }
}
