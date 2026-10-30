import XCTest

/// BDD tests for the Reports feature (Epic 241).
/// Tests the reports list, creation flow, detail view, and admin actions.
final class ReportFlowUITests: BaseUITest {

    // MARK: - Helper: Navigate to Reports

    /// Navigate to the reports screen via the Dashboard quick action card.
    /// The quick actions section is below identity, shift, and activity sections in the List,
    /// so we must scroll down to find it.
    private func navigateToReports() {
        scrollAndTap("dashboard-reports-action")

        // Wait for reports content to appear
        _ = anyElementExists([
            "reports-list", "reports-empty-state", "reports-loading", "reports-error",
        ])
    }

    /// Launch as admin on a hub of its own with the jail-support template applied, which
    /// defines two mobile-optimized report types (`lo_arrest_report`, `lo_misconduct_report`).
    private func launchOnHubWithReportTypes() {
        guard let hubId = TestAdminAPI.createHub(
            name: "ios-reports-\(UUID().uuidString.prefix(8))", baseURL: testHubURL
        ) else { return }
        TestAdminAPI.setCaseManagement(enabled: true, hubId: hubId, baseURL: testHubURL)
        TestAdminAPI.applyTemplate("jail-support", hubId: hubId, baseURL: testHubURL)
        launchAsAdminWithAPI(hubId: hubId)
    }

    /// Skip a scenario that needs typed reports while the app cannot load the hub's report
    /// types. `GET /settings/cms/report-types` omits `allowFileAttachments`, which the iOS
    /// model requires, so the decode throws and every hub falls back to the legacy form
    /// (#2033). The skip reports these as not run, where they used to pass by finding no
    /// typed form. Delete this helper and its calls when #2033 is fixed; the bodies are
    /// the assertions to keep.
    private func requireTypedReports() throws {
        throw XCTSkip("iOS cannot decode the hub's CMS report types, so the typed form is unreachable (#2033)")
    }

    /// The states the Reports screen settles on once it has decided what to show.
    private static let settledStates = ["reports-list", "reports-empty-state", "reports-error"]

    private func settledReportsState(timeout: TimeInterval = 20) -> String? {
        let settled = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier IN %@", Self.settledStates)
        ).firstMatch
        guard settled.waitForExistence(timeout: timeout) else { return nil }
        return Self.settledStates.first { find($0).exists }
    }

    // MARK: - Scenario: Reports list shows content or empty state

    /// With no hub configured there are no reports to load, so the screen settles on a
    /// definite state — not a spinner — and offers no list.
    func testReportsListShowsContent() {
        given("I am authenticated without a hub connection") {
            launchAuthenticated()
        }
        when("I navigate to reports") {
            navigateToReports()
        }
        then("the screen settles on one definite state with nothing loading") {
            let state = settledReportsState()
            XCTAssertNotNil(state, "Reports should leave its loading state")
            XCTAssertNotEqual(state, "reports-list", "There are no reports to list without a hub")
            XCTAssertFalse(find("reports-loading").exists, "Reports should have finished loading")
        }
    }

    // MARK: - Scenario: Create report button exists

    func testCreateReportButtonExists() {
        given("I am authenticated") {
            launchAuthenticated()
        }
        when("I navigate to reports") {
            navigateToReports()
        }
        then("I should see the create report button") {
            let createButton = find("create-report-button")
            XCTAssertTrue(
                createButton.waitForExistence(timeout: 5),
                "Create report button should exist in toolbar"
            )
        }
    }

    // MARK: - Scenario: Create report flow opens sheet

    func testCreateReportFlowOpensSheet() {
        given("I am authenticated") {
            launchAuthenticated()
        }
        when("I navigate to reports and tap create") {
            navigateToReports()
            let createButton = find("create-report-button")
            XCTAssertTrue(createButton.waitForExistence(timeout: 5))
            createButton.tap()
        }
        then("I should see the report creation form") {
            let titleInput = find("report-title-input")
            XCTAssertTrue(
                titleInput.waitForExistence(timeout: 5),
                "Report title input should appear in create sheet"
            )

            let bodyInput = find("report-body-input")
            XCTAssertTrue(bodyInput.waitForExistence(timeout: 3), "Report body input should exist")

            let submitButton = find("report-submit-button")
            XCTAssertTrue(submitButton.exists, "Submit button should exist")

            let cancelButton = find("cancel-report-create")
            XCTAssertTrue(cancelButton.exists, "Cancel button should exist")
        }
    }

    // MARK: - Scenario: Cancel report creation

    func testCancelReportCreation() {
        given("I am authenticated") {
            launchAuthenticated()
        }
        when("I open the create report sheet and cancel") {
            navigateToReports()
            let createButton = find("create-report-button")
            XCTAssertTrue(createButton.waitForExistence(timeout: 5))
            createButton.tap()

            let titleInput = find("report-title-input")
            XCTAssertTrue(titleInput.waitForExistence(timeout: 5))

            let cancelButton = find("cancel-report-create")
            cancelButton.tap()
        }
        then("I should be back on the reports screen") {
            let createButton = find("create-report-button")
            XCTAssertTrue(
                createButton.waitForExistence(timeout: 5),
                "Create button should be visible after cancelling"
            )
        }
    }

    // MARK: - Scenario: Filter button exists

    func testFilterButtonExists() {
        given("I am authenticated") {
            launchAuthenticated()
        }
        when("I navigate to reports") {
            navigateToReports()
        }
        then("I should see the filter button") {
            let filterButton = find("reports-filter-button")
            XCTAssertTrue(
                filterButton.waitForExistence(timeout: 5),
                "Reports filter button should exist in toolbar"
            )
        }
    }

    // MARK: - Scenario: Dashboard has reports quick action

    func testDashboardHasReportsQuickAction() {
        given("I am authenticated") {
            launchAuthenticated()
        }
        then("the dashboard should show a reports quick action") {
            let reportsAction = scrollToFind("dashboard-reports-action")
            XCTAssertTrue(
                reportsAction.exists,
                "Dashboard should have a reports quick action card"
            )
        }
    }

    // MARK: - Scenario: Empty state shows create button

    func testEmptyStateShowsCreateButton() {
        given("I am authenticated") {
            launchAuthenticated()
        }
        when("I navigate to reports") {
            navigateToReports()
        }
        then("the empty state offers to create the first report") {
            XCTAssertEqual(
                settledReportsState(), "reports-empty-state",
                "With no hub there are no reports, so Reports settles on its empty state"
            )
            XCTAssertTrue(find("create-first-report").exists, "Empty state should have a create button")
            XCTAssertFalse(find("reports-list").exists, "There is nothing to list")
        }
    }

    // MARK: - Scenario: Report type picker shows types (API-connected)

    /// With report types configured on the hub, create opens the type picker with a card for
    /// each mobile-optimized type — not the legacy free-text form.
    func testReportTypePickerShowsTypes() throws {
        try requireTypedReports()
        given("I am authenticated as admin on a hub with report types") {
            launchOnHubWithReportTypes()
        }
        when("I navigate to reports and tap create") {
            navigateToReports()
            let createButton = find("create-report-button")
            XCTAssertTrue(createButton.waitForExistence(timeout: 10))
            createButton.tap()
        }
        then("I see the type picker with a card for each type, and not the legacy form") {
            XCTAssertTrue(
                find("cancel-report-type-picker").waitForExistence(timeout: 10),
                "A hub with report types should open the type picker"
            )
            XCTAssertTrue(find("report-type-lo_arrest_report").exists, "The arrest report type should be offered")
            XCTAssertTrue(find("report-type-lo_misconduct_report").exists, "The misconduct report type should be offered")
            XCTAssertFalse(find("report-title-input").exists, "The legacy form is for hubs without report types")
        }
    }

    // MARK: - Scenario: Typed report form renders fields

    /// Choosing a type opens a form with that type's fields; Submit stays off until the
    /// required ones are filled and goes live when they are.
    func testTypedReportFormRendersFields() throws {
        try requireTypedReports()
        given("I am authenticated as admin on a hub with report types") {
            launchOnHubWithReportTypes()
        }
        when("I choose the arrest report type") {
            openTypedForm(type: "lo_arrest_report")
        }
        then("the form shows the type's fields, and Submit needs the required ones") {
            for field in ["location", "time", "agency", "count", "arrestee_details", "notes"] {
                XCTAssertTrue(
                    scrollToFind("field-\(field)", maxSwipes: 6).exists,
                    "lo_arrest_report defines a '\(field)' field"
                )
            }
            let submit = app.buttons["typed-report-submit"]
            XCTAssertTrue(submit.exists, "Typed report form should have a submit button")
            XCTAssertFalse(submit.isEnabled, "Submit must stay off while required fields are empty")
        }
    }

    // MARK: - Scenario: Submit a typed report

    /// A filled-in report is accepted by the server and listed.
    func testSubmittedReportAppearsInList() throws {
        try requireTypedReports()
        given("I am authenticated as admin on a hub with report types, and open an arrest report") {
            launchOnHubWithReportTypes()
            openTypedForm(type: "lo_arrest_report")
        }
        when("I fill the required fields and submit") {
            fillTextField("field-location", with: "5th and Main")
            fillTextField("field-time", with: "9:40 pm")
            fillTextArea("field-arrestee_details", with: "Two people, red jacket and blue backpack")
            let submit = app.buttons["typed-report-submit"]
            XCTAssertTrue(submit.isEnabled, "Submit should be live once the required fields are filled")
            submit.tap()
        }
        then("the form closes and the report is in the list") {
            XCTAssertTrue(
                find("typed-report-submit").waitForNonExistence(timeout: 30),
                "The form should close once the report is saved"
            )
            XCTAssertFalse(find("typed-report-error").exists, "Saving should not report an error")
            let row = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'report-row-'")).firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 15), "The submitted report should be listed")
            XCTAssertFalse(find("reports-empty-state").exists)
        }
    }

    // MARK: - Scenario: Cancel typed report form

    /// Cancelling the typed form leaves the reports screen as it was: no report added.
    func testCancelTypedReportForm() throws {
        try requireTypedReports()
        given("I am authenticated as admin on a hub with report types, and open an arrest report") {
            launchOnHubWithReportTypes()
            openTypedForm(type: "lo_arrest_report")
        }
        when("I type into the form and cancel") {
            fillTextField("field-time", with: "9:40 pm")
            app.buttons["cancel-typed-report"].tap()
        }
        then("I am back on the empty reports screen") {
            XCTAssertTrue(
                find("typed-report-submit").waitForNonExistence(timeout: 10),
                "Cancel should close the typed form"
            )
            XCTAssertTrue(find("create-report-button").waitForExistence(timeout: 5))
            XCTAssertEqual(settledReportsState(), "reports-empty-state", "Cancelling must not create a report")
        }
    }

    // MARK: - Scenario: Audio input button visible on textarea fields

    /// Only textarea fields that opt in (`supportAudioInput`) get a dictation button:
    /// lo_arrest_report's arrestee_details does, its notes field does not.
    func testAudioInputButtonVisibleOnTextareaFields() throws {
        try requireTypedReports()
        given("I am authenticated as admin on a hub with report types, and open an arrest report") {
            launchOnHubWithReportTypes()
            openTypedForm(type: "lo_arrest_report")
        }
        then("exactly one dictation button is offered") {
            _ = scrollToFind("field-notes", maxSwipes: 6)
            let buttons = app.descendants(matching: .any).matching(identifier: "audio-input-button")
            XCTAssertTrue(buttons.firstMatch.waitForExistence(timeout: 5), "arrestee_details supports audio input")
            XCTAssertEqual(
                buttons.count, 1,
                "Only the field with supportAudioInput should offer dictation, not every textarea"
            )
        }
    }

    // MARK: - Helpers

    private func openTypedForm(type: String) {
        navigateToReports()
        let createButton = find("create-report-button")
        XCTAssertTrue(createButton.waitForExistence(timeout: 10), "Create report button should exist")
        createButton.tap()
        let card = find("report-type-\(type)")
        XCTAssertTrue(card.waitForExistence(timeout: 10), "The type picker should offer \(type)")
        card.tap()
        XCTAssertTrue(
            find("typed-report-submit").waitForExistence(timeout: 10),
            "Choosing \(type) should open its form"
        )
    }

    private func fillTextField(_ identifier: String, with text: String) {
        let container = scrollToVisible(identifier)
        let input = container.textFields.firstMatch.exists ? container.textFields.firstMatch : container
        XCTAssertTrue(input.exists, "\(identifier) should be on the form")
        typeText(text, into: input)
    }

    private func fillTextArea(_ identifier: String, with text: String) {
        let container = scrollToVisible(identifier)
        let input = container.textViews.firstMatch.exists ? container.textViews.firstMatch : container
        XCTAssertTrue(input.exists, "\(identifier) should be on the form")
        typeText(text, into: input)
    }
}
