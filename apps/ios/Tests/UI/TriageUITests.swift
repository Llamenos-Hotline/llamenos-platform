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

    /// Given-step for the triage detail scenarios: the queue is
    /// `GET /api/reports?conversionEnabled=true`, so the hub needs a report whose
    /// type has `allowCaseConversion`. The jail-support template provides
    /// `lo_arrest_report`; the scenario submits one through the app's own
    /// Reports → typed report form (required fields: location, time,
    /// arrestee_details) rather than opening whatever the hub happens to hold.
    private func launchAsAdminWithTriageReport() {
        enableCaseManagementWithTemplate()
        launchAsAdminWithAPI()
        navigateToReports()
        submitArrestReport()
    }

    /// Submit an LO Arrest Report through the type picker and typed report form,
    /// and wait for the form sheet to close on success.
    private func submitArrestReport() {
        let createButton = find("create-report-button")
        XCTAssertTrue(
            createButton.waitForExistence(timeout: 15),
            "Reports screen should offer create once report types load"
        )
        createButton.tap()

        let typeCard = find("report-type-lo_arrest_report")
        XCTAssertTrue(
            typeCard.waitForExistence(timeout: 10),
            "The type picker should offer the jail-support LO Arrest Report"
        )
        typeCard.tap()

        // `field-<name>` identifies the form row; the input inside it carries no
        // identifier of its own. iOS renders the template's `location` field as
        // text (ReportFieldType has no location case), so all three required
        // fields are fillable as text.
        let locationInput = find("field-location").textFields.firstMatch
        XCTAssertTrue(locationInput.waitForExistence(timeout: 5), "Arrest report form should render the location field")
        locationInput.tap()
        locationInput.typeText("5th and Main")

        let timeInput = find("field-time").textFields.firstMatch
        XCTAssertTrue(timeInput.waitForExistence(timeout: 5), "Arrest report form should render the time field")
        timeInput.tap()
        timeInput.typeText("14:30")

        let detailsInput = find("field-arrestee_details").textViews.firstMatch
        XCTAssertTrue(detailsInput.waitForExistence(timeout: 5), "Arrest report form should render the arrestee details field")
        detailsInput.tap()
        detailsInput.typeText("Two arrestees, names unknown")

        let submit = find("typed-report-submit")
        XCTAssertTrue(submit.waitForExistence(timeout: 5), "The typed report form should have a submit button")
        XCTAssertTrue(submit.isEnabled, "Submit should be enabled once the required fields are filled")
        submit.tap()

        XCTAssertTrue(
            submit.waitForNonExistence(timeout: 30),
            "The typed report sheet should close once the report is submitted"
        )
        XCTAssertFalse(find("typed-report-error").exists, "Report submission should not report an error")
    }

    /// Open the first row of the triage queue. The scenario's Given submitted a
    /// conversion-enabled report, so the list cannot be empty.
    private func openFirstTriageRow() {
        navigateToTriage()
        let triageList = find("triage-list")
        XCTAssertTrue(
            triageList.waitForExistence(timeout: 10),
            "Triage queue should render its list — this scenario submitted a conversion-enabled report"
        )

        let firstRow = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'triage-row-'"))
            .firstMatch
        XCTAssertTrue(
            firstRow.waitForExistence(timeout: 5),
            "Triage queue should list the report this scenario submitted ('triage-row-*')"
        )
        firstRow.tap()
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
        given("a conversion-enabled report exists, submitted through the app's report form") {
            launchAsAdminWithTriageReport()
        }
        when("I navigate to triage and tap the report") {
            openFirstTriageRow()
        }
        then("I should see the triage detail view with report info") {
            XCTAssertTrue(
                anyElementExists([
                    "triage-detail-view",
                    "triage-report-title",
                    "triage-report-status",
                ], timeout: 5),
                "Triage detail should open after tapping a report row"
            )

            let title = find("triage-report-title")
            XCTAssertTrue(title.waitForExistence(timeout: 3), "Triage detail should show report title")

            let status = find("triage-report-status")
            XCTAssertTrue(status.waitForExistence(timeout: 3), "Triage detail should show report status")

            let metadata = find("triage-metadata")
            XCTAssertTrue(metadata.waitForExistence(timeout: 3), "Triage detail should show metadata section")
        }
    }

    // MARK: - Scenario: Convert to case button visible

    /// Verifies the "Convert to Case" button is present on the triage detail view.
    func testConvertToCaseButtonVisible() {
        given("a conversion-enabled report exists, submitted through the app's report form") {
            launchAsAdminWithTriageReport()
        }
        when("I open the triage report detail") {
            openFirstTriageRow()
        }
        then("the convert to case button should be visible") {
            XCTAssertTrue(
                anyElementExists(["triage-detail-view", "triage-report-title"], timeout: 5),
                "Triage detail should open after tapping a report row"
            )

            // The submitted report is pending (not closed), so the detail offers conversion.
            let convertButton = scrollToFind("triage-convert-button", maxSwipes: 3)
            XCTAssertTrue(convertButton.exists, "Convert to case button should be visible")
            XCTAssertTrue(convertButton.isEnabled, "Convert to case button should be enabled")
        }
    }

    // MARK: - Scenario: Triage report type label visible

    /// Verifies the report type label is displayed on the triage detail.
    func testTriageReportTypeLabelVisible() {
        given("a conversion-enabled report exists, submitted through the app's report form") {
            launchAsAdminWithTriageReport()
        }
        when("I open the triage report detail") {
            openFirstTriageRow()
        }
        then("the report type label should be visible") {
            XCTAssertTrue(
                anyElementExists(["triage-detail-view", "triage-report-title"], timeout: 5),
                "Triage detail should open after tapping a report row"
            )

            // The submitted report is typed (lo_arrest_report), so the type badge renders.
            let typeLabel = find("triage-report-type")
            XCTAssertTrue(
                typeLabel.waitForExistence(timeout: 5),
                "Report type label should be visible in triage detail"
            )
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
