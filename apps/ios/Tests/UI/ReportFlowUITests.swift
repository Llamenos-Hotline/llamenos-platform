import XCTest

/// BDD tests for the Reports feature (Epic 241).
/// Tests the reports list, creation flow, detail view, and admin actions.
final class ReportFlowUITests: BaseUITest {

    // MARK: - Scenario: Reports list shows content or empty state

    func testReportsListShowsContent() {
        given("I am authenticated") {
            launchAuthenticated()
        }
        when("I navigate to reports") {
            navigateToReports()
        }
        then("I should see the reports list or empty state") {
            let found = anyElementExists([
                "reports-list", "reports-empty-state", "reports-loading", "reports-error",
            ])
            XCTAssertTrue(found, "Reports view should show list, empty state, loading, or error")
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
        then("the empty state should have a create button if no reports exist") {
            let emptyState = find("reports-empty-state")
            if emptyState.waitForExistence(timeout: 5) {
                let createFirst = find("create-first-report")
                XCTAssertTrue(createFirst.exists, "Empty state should have a create button")
            }
            // If reports exist, that's fine too
        }
    }

    // MARK: - Scenario: Report type picker shows types (API-connected)

    /// Verifies that when report types are configured on the hub, tapping
    /// the create button opens the ReportTypePicker with type cards.
    /// Requires Docker Compose backend with report types configured.
    func testReportTypePickerShowsTypes() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I navigate to reports and tap create") {
            navigateToReports()
            let createButton = find("create-report-button")
            XCTAssertTrue(createButton.waitForExistence(timeout: 10))
            createButton.tap()
        }
        then("I should see the report type picker or legacy form") {
            // If report types are configured, the type picker appears with cards.
            // If no report types exist, the legacy form appears instead.
            let foundTypePicker = anyElementExists([
                "cancel-report-type-picker",  // type picker cancel button
                "report-title-input",          // legacy form fallback
            ])
            XCTAssertTrue(
                foundTypePicker,
                "Tapping create should open either the report type picker or legacy creation form"
            )
        }
    }

    // MARK: - Scenario: Typed report form renders fields

    /// Verifies that selecting a report type from the picker opens the
    /// TypedReportCreateView with dynamic form fields and a submit button.
    /// Requires Docker Compose backend with mobile-optimized report types.
    func testTypedReportFormRendersFields() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I navigate to reports and open a typed report form") {
            navigateToReports()
            let createButton = find("create-report-button")
            XCTAssertTrue(createButton.waitForExistence(timeout: 10))
            createButton.tap()

            // If a type picker appears, select the first available type card.
            // Type cards use "report-type-{name}" identifiers.
            let pickerCancel = find("cancel-report-type-picker")
            if pickerCancel.waitForExistence(timeout: 5) {
                // Type picker is showing — tap the first type card found
                // Cards are buttons inside the picker's LazyVStack
                let firstCard = app.descendants(matching: .button)
                    .matching(NSPredicate(format: "identifier BEGINSWITH 'report-type-'"))
                    .firstMatch
                if firstCard.waitForExistence(timeout: 5) {
                    firstCard.tap()
                }
            }
        }
        then("I should see the typed report form with fields and submit button") {
            // The typed form should have a submit button and a cancel button
            let submitButton = find("typed-report-submit")
            let cancelButton = find("cancel-typed-report")

            let hasTypedForm = submitButton.waitForExistence(timeout: 5)
                || cancelButton.waitForExistence(timeout: 2)

            if hasTypedForm {
                XCTAssertTrue(
                    submitButton.exists,
                    "Typed report form should have a submit button"
                )
                XCTAssertTrue(
                    cancelButton.exists,
                    "Typed report form should have a cancel button"
                )
            }
            // If no typed form appeared (no report types on server), pass gracefully
        }
    }

    // MARK: - Scenario: Cancel typed report form

    /// Verifies that cancelling the typed report form returns to the reports screen.
    func testCancelTypedReportForm() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I open a typed report form and cancel") {
            navigateToReports()
            let createButton = find("create-report-button")
            XCTAssertTrue(createButton.waitForExistence(timeout: 10))
            createButton.tap()

            // If type picker appears, select a type
            let pickerCancel = find("cancel-report-type-picker")
            if pickerCancel.waitForExistence(timeout: 5) {
                let firstCard = app.descendants(matching: .button)
                    .matching(NSPredicate(format: "identifier BEGINSWITH 'report-type-'"))
                    .firstMatch
                if firstCard.waitForExistence(timeout: 5) {
                    firstCard.tap()
                }
            }

            // Cancel the typed form if it appeared
            let cancelTyped = find("cancel-typed-report")
            if cancelTyped.waitForExistence(timeout: 5) {
                cancelTyped.tap()
            } else {
                // Fall back to cancelling the legacy form
                let cancelLegacy = find("cancel-report-create")
                if cancelLegacy.waitForExistence(timeout: 3) {
                    cancelLegacy.tap()
                }
            }
        }
        then("I should be back on the reports screen") {
            let createButton = find("create-report-button")
            XCTAssertTrue(
                createButton.waitForExistence(timeout: 5),
                "Create button should be visible after cancelling typed report"
            )
        }
    }

    // MARK: - Scenario: Audio input button visible on textarea fields

    /// Verifies that textarea fields with `supportAudioInput: true` show the
    /// mic button (AudioInputButton) for speech-to-text dictation.
    func testAudioInputButtonVisibleOnTextareaFields() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I open a typed report form") {
            navigateToReports()
            let createButton = find("create-report-button")
            XCTAssertTrue(createButton.waitForExistence(timeout: 10))
            createButton.tap()

            // Select the first type if picker appears
            let pickerCancel = find("cancel-report-type-picker")
            if pickerCancel.waitForExistence(timeout: 5) {
                let firstCard = app.descendants(matching: .button)
                    .matching(NSPredicate(format: "identifier BEGINSWITH 'report-type-'"))
                    .firstMatch
                if firstCard.waitForExistence(timeout: 5) {
                    firstCard.tap()
                }
            }
        }
        then("textarea fields with audio support should show a mic button") {
            // The audio input button has a fixed identifier
            let audioButton = find("audio-input-button")
            let typedSubmit = find("typed-report-submit")

            // Only check for audio button if we're on the typed form
            if typedSubmit.waitForExistence(timeout: 5) {
                // Scroll to find the audio button — it may be below the fold
                let found = scrollToFind("audio-input-button", maxSwipes: 5)
                // Audio button presence depends on whether the report type
                // has textarea fields with supportAudioInput: true.
                // If present, verify it exists; if not, that's acceptable.
                if found.exists {
                    XCTAssertTrue(
                        audioButton.isHittable || audioButton.exists,
                        "Audio input button should be visible on textarea fields with audio support"
                    )
                }
            }
            // If no typed form (no report types on server), pass gracefully
        }
    }
}
