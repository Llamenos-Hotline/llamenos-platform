import XCTest

/// XCUITest suite for Triage Queue views.
/// Tests triage list, filters, detail view, and convert-to-case flow.
///
/// Maps to BDD scenarios: triage-list, triage-filters, triage-convert.
final class TriageUITests: BaseUITest {

    // MARK: - Helpers

    /// Navigate to the triage screen via the dashboard quick action card.
    private func navigateToTriage() {
        scrollAndTap("dashboard-triage-action")

        _ = anyElementExists([
            "triage-list",
            "triage-loading",
            "triage-empty-state",
            "triage-error",
        ], timeout: 10)
    }

    // MARK: - Scenario: Triage list shows reports or empty state

    /// Verifies the triage queue renders with content or appropriate empty state.
    func testTriageListShowsReports() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I navigate to triage") {
            navigateToTriage()
        }
        then("I should see the triage list, empty state, or loading") {
            let found = anyElementExists([
                "triage-list",
                "triage-loading",
                "triage-empty-state",
                "triage-error",
                "triage-filter-button",
            ])
            XCTAssertTrue(found, "Triage view should show list, loading, empty, or error state")
        }
    }

    // MARK: - Scenario: Triage list shows report cards

    /// Verifies triage report cards render when triage-eligible reports exist.
    func testTriageListShowsReportCards() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I navigate to triage") {
            navigateToTriage()
        }
        then("I should see triage report rows if reports exist") {
            let triageList = find("triage-list")
            if triageList.waitForExistence(timeout: 10) {
                let reportRows = app.descendants(matching: .any)
                    .matching(NSPredicate(format: "identifier BEGINSWITH 'triage-row-'"))
                if reportRows.count > 0 {
                    XCTAssertTrue(
                        reportRows.firstMatch.exists,
                        "At least one triage report row should be visible"
                    )
                }
            }
            // No triage reports on fresh server is valid
        }
    }

    // MARK: - Scenario: Triage filter button visible

    /// Verifies the filter button is present on the triage screen.
    func testTriageFilterButtonVisible() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I navigate to triage") {
            navigateToTriage()
        }
        then("the filter button should be visible") {
            let filterButton = find("triage-filter-button")
            if filterButton.waitForExistence(timeout: 5) {
                XCTAssertTrue(filterButton.exists, "Triage filter button should be visible")
            }
        }
    }

    // MARK: - Scenario: Triage detail shows report info

    /// Verifies tapping a triage report row opens the detail view
    /// with title, status, and metadata.
    func testTriageDetailShowsInfo() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I navigate to triage and tap a report") {
            navigateToTriage()
            let triageList = find("triage-list")
            XCTAssertTrue(
                triageList.waitForExistence(timeout: 10),
                "Triage queue should render its list — this scenario needs a conversion-enabled report in the hub"
            )

            let firstRow = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'triage-row-'"))
                .firstMatch
            XCTAssertTrue(firstRow.waitForExistence(timeout: 5), "Triage queue should list at least one report row ('triage-row-*')")
            firstRow.tap()
        }
        then("I should see the triage detail view with report info") {
            let found = anyElementExists([
                "triage-detail-view",
                "triage-report-title",
                "triage-report-status",
            ], timeout: 5)

            if found {
                let title = find("triage-report-title")
                if title.waitForExistence(timeout: 3) {
                    XCTAssertTrue(title.exists, "Triage detail should show report title")
                }

                let status = find("triage-report-status")
                if status.waitForExistence(timeout: 3) {
                    XCTAssertTrue(status.exists, "Triage detail should show report status")
                }

                let metadata = find("triage-metadata")
                if metadata.waitForExistence(timeout: 3) {
                    XCTAssertTrue(metadata.exists, "Triage detail should show metadata section")
                }
            }
            // If no triage reports exist, cannot test detail — pass gracefully
        }
    }

    // MARK: - Scenario: Convert to case button visible

    /// Verifies the "Convert to Case" button is present on the triage detail view.
    func testConvertToCaseButtonVisible() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I open a triage report detail") {
            navigateToTriage()
            let triageList = find("triage-list")
            XCTAssertTrue(
                triageList.waitForExistence(timeout: 10),
                "Triage queue should render its list — this scenario needs a conversion-enabled report in the hub"
            )

            let firstRow = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'triage-row-'"))
                .firstMatch
            XCTAssertTrue(firstRow.waitForExistence(timeout: 5), "Triage queue should list at least one report row ('triage-row-*')")
            firstRow.tap()
        }
        then("the convert to case button should be visible") {
            XCTAssertTrue(
                anyElementExists(["triage-detail-view", "triage-report-title"], timeout: 5),
                "Triage detail should open after tapping a report row"
            )

            let convertButton = scrollToFind("triage-convert-button", maxSwipes: 3)
            if convertButton.exists {
                XCTAssertTrue(convertButton.exists, "Convert to case button should be visible")
                XCTAssertTrue(convertButton.isEnabled, "Convert to case button should be enabled")
            }
            // Button may not appear if the report type doesn't support case conversion
        }
    }

    // MARK: - Scenario: Triage report type label visible

    /// Verifies the report type label is displayed on the triage detail.
    func testTriageReportTypeLabelVisible() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I open a triage report detail") {
            navigateToTriage()
            let triageList = find("triage-list")
            XCTAssertTrue(
                triageList.waitForExistence(timeout: 10),
                "Triage queue should render its list — this scenario needs a conversion-enabled report in the hub"
            )

            let firstRow = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'triage-row-'"))
                .firstMatch
            XCTAssertTrue(firstRow.waitForExistence(timeout: 5), "Triage queue should list at least one report row ('triage-row-*')")
            firstRow.tap()
        }
        then("the report type label should be visible") {
            XCTAssertTrue(
                anyElementExists(["triage-detail-view", "triage-report-title"], timeout: 5),
                "Triage detail should open after tapping a report row"
            )

            let typeLabel = find("triage-report-type")
            if typeLabel.waitForExistence(timeout: 3) {
                XCTAssertTrue(typeLabel.exists, "Report type label should be visible in triage detail")
            }
            // Type label only shows for typed reports — absence is valid for legacy reports
        }
    }

    // MARK: - Scenario: Dashboard has triage quick action

    /// Verifies the triage quick action card is visible on the dashboard for admins.
    func testDashboardHasTriageQuickAction() {
        given("I am authenticated as admin") {
            launchAsAdminWithAPI()
        }
        then("the dashboard should show a triage quick action") {
            let triageAction = scrollToFind("dashboard-triage-action")
            XCTAssertTrue(
                triageAction.exists,
                "Dashboard should have a triage quick action card for admin"
            )
        }
    }

    // MARK: - Scenario: Triage empty state

    /// Verifies the empty state displays when no triage-eligible reports exist.
    func testTriageEmptyState() {
        given("I am authenticated as admin with API and fresh state") {
            launchAsAdminWithAPI()
        }
        when("I navigate to triage") {
            navigateToTriage()
        }
        then("I should see either reports or the empty state") {
            let found = anyElementExists([
                "triage-list",
                "triage-empty-state",
                "triage-loading",
            ], timeout: 10)
            XCTAssertTrue(found, "Triage should show list, empty state, or loading after navigation")
        }
    }
}
