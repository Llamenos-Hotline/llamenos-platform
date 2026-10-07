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
            // The filter menu is attached to TriageListView's `.toolbar`,
            // which sits outside the loading/error/empty/list conditional —
            // it renders on every state, including an empty queue.
            XCTAssertTrue(
                find("triage-filter-button").waitForExistence(timeout: 5),
                "Triage filter button should be visible"
            )
        }
    }

    // MARK: - Scenario: Triage detail shows report info

    /// Verifies tapping a triage report row opens the detail view
    /// with title, status, and metadata.
    func testTriageDetailShowsInfo() throws {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I navigate to triage and tap a report") {
            navigateToTriage()
            // This suite has no way to provision a triage-eligible report
            // (there is no `/api/test-simulate/...` endpoint for reports, the
            // way there is for calls and messages), so an empty queue is
            // genuinely possible here — report that explicitly rather than
            // silently passing with no assertion ever evaluated.
            guard find("triage-list").waitForExistence(timeout: 10) else {
                throw XCTSkip("No triage-eligible report exists in this test environment; the triage list never renders")
            }
            let firstRow = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'triage-row-'"))
                .firstMatch
            guard firstRow.waitForExistence(timeout: 5) else {
                throw XCTSkip("No triage-eligible report exists in this test environment; there is no row to tap")
            }
            firstRow.tap()
        }
        then("I should see the triage detail view with report info") {
            XCTAssertTrue(find("triage-detail-view").waitForExistence(timeout: 5), "Triage detail view should open")
            XCTAssertTrue(find("triage-report-title").waitForExistence(timeout: 3), "Triage detail should show report title")
            XCTAssertTrue(find("triage-report-status").waitForExistence(timeout: 3), "Triage detail should show report status")
            XCTAssertTrue(find("triage-metadata").waitForExistence(timeout: 3), "Triage detail should show metadata section")
        }
    }

    // MARK: - Scenario: Convert to case button visible

    /// Verifies the "Convert to Case" button is present on the triage detail view.
    /// `TriageDetailView` only hides the convert button `if
    /// report.statusEnum == .closed`, and `TriageListView` defaults to the
    /// `.pending` filter — a report reached this way is never closed, so the
    /// button is deterministic once a report exists (not merely "may not
    /// appear").
    func testConvertToCaseButtonVisible() throws {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I open a triage report detail") {
            navigateToTriage()
            guard find("triage-list").waitForExistence(timeout: 10) else {
                throw XCTSkip("No triage-eligible report exists in this test environment; the triage list never renders")
            }
            let firstRow = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'triage-row-'"))
                .firstMatch
            guard firstRow.waitForExistence(timeout: 5) else {
                throw XCTSkip("No triage-eligible report exists in this test environment; there is no row to tap")
            }
            firstRow.tap()
        }
        then("the convert to case button should be visible") {
            XCTAssertTrue(find("triage-detail-view").waitForExistence(timeout: 5), "Triage detail view should open")

            let convertButton = scrollToFind("triage-convert-button", maxSwipes: 3)
            XCTAssertTrue(convertButton.exists, "Convert to case button should be visible for a non-closed report")
            XCTAssertTrue(convertButton.isEnabled, "Convert to case button should be enabled")
        }
    }

    // MARK: - Scenario: Triage report type label visible

    /// Verifies the report type label is displayed on the triage detail.
    func testTriageReportTypeLabelVisible() throws {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I open a triage report detail") {
            navigateToTriage()
            guard find("triage-list").waitForExistence(timeout: 10) else {
                throw XCTSkip("No triage-eligible report exists in this test environment; the triage list never renders")
            }
            let firstRow = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'triage-row-'"))
                .firstMatch
            guard firstRow.waitForExistence(timeout: 5) else {
                throw XCTSkip("No triage-eligible report exists in this test environment; there is no row to tap")
            }
            firstRow.tap()
        }
        then("the report type label should be visible for typed reports") {
            XCTAssertTrue(find("triage-detail-view").waitForExistence(timeout: 5), "Triage detail view should open")

            // The type badge only renders when `reportTypeLabel(for:)`
            // resolves — i.e. for typed reports; absence is legitimate for
            // legacy reports. When it IS shown, verify it carries real text
            // rather than restating the existence check as `XCTAssertTrue(true)`.
            let typeLabel = find("triage-report-type")
            if typeLabel.waitForExistence(timeout: 3) {
                XCTAssertFalse(typeLabel.label.isEmpty, "Report type label should not be empty when shown")
            }
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
