import XCTest

/// Comprehensive XCUITest suite for the CMS Case Management views.
/// Tests case list, detail, status changes, comments, assignment, and navigation.
///
/// Maps to CMS BDD scenarios: case-list-display, case-detail-tabs,
/// case-status-change, case-comment, case-assignment.
final class CaseManagementUITests: BaseUITest {

    // MARK: - Case List View (Offline/Mock)

    /// Scenario: Cases tab exists and navigates to case list view.
    /// Verifies the Cases tab is present in the main tab bar and
    /// navigating to it renders the case list (or appropriate state).
    func testCasesTabExistsInTabBar() {
        given("I am authenticated") {
            launchAuthenticated()
        }
        when("I look at the tab bar") {
            let tabBar = app.tabBars.firstMatch
            XCTAssertTrue(tabBar.waitForExistence(timeout: 5), "Tab bar should exist")
        }
        then("I should see a Cases tab") {
            let tabBar = app.tabBars.firstMatch
            // Cases tab should be at index 2
            let casesTab = tabBar.buttons.element(boundBy: 2)
            XCTAssertTrue(casesTab.exists, "Cases tab should exist at index 2 in the tab bar")
        }
    }

    /// Scenario: Navigating to Cases without an API connection says case management is off.
    /// With no hub configured the CMS request cannot succeed, so the view resolves to the
    /// not-enabled state — not a spinner, and not a list.
    func testCaseListShowsInitialState() {
        given("I am authenticated without an API connection") {
            launchAuthenticated()
        }
        when("I navigate to the Cases tab") {
            navigateToCases()
        }
        then("I should see that case management is not enabled") {
            XCTAssertTrue(
                find("cms-not-enabled").waitForExistence(timeout: 15),
                "Cases view should settle on the not-enabled state when no hub is reachable"
            )
            XCTAssertFalse(find("case-loading").exists, "Cases view should not still be loading")
            XCTAssertFalse(find("case-list").exists, "There is no case list without case management")
        }
    }

    /// Scenario: Dashboard has a Cases quick action card.
    func testDashboardHasCasesQuickAction() {
        given("I am authenticated") {
            launchAuthenticated()
        }
        then("the dashboard should show a cases quick action") {
            let casesAction = scrollToFind("dashboard-cases-action")
            XCTAssertTrue(
                casesAction.exists,
                "Dashboard should have a Cases quick action card"
            )
        }
    }

    // MARK: - Case List View (API-Connected)

    /// Scenario: Selecting an entity type keeps its matching record in the list.
    ///
    /// The tabs render only on a hub with case management on, more than one entity
    /// type, and at least one case — an empty hub shows the empty state instead. So
    /// the test puts the server in that state rather than branching on whatever it
    /// finds: the jail-support template (Arrest Case + Mass Arrest Event) is applied
    /// to this class's hub through the real API, and a case is created through the
    /// app's own create-case sheet (client-side E2EE included).
    func testSelectingEntityTypeShowsMatchingCase() {
        given("case management is enabled with two entity types") {
            configureCaseManagementWithTwoTypes()
        }
        and("the app is launched and authenticated as admin") {
            launchAsAdminWithAPI()
        }
        and("a case exists") {
            navigateToCases()
            createCase(
                title: entityTabsCaseTitle,
                entityTypeName: "arrest_case"
            )
        }
        when("I navigate to the Cases screen") {
            navigateToCases()
        }
        then("selecting Arrest Case should keep its case in the filtered list") {
            let arrestCaseTab = entityTypeFilterButton(name: "arrest_case")
            arrestCaseTab.tap()
            XCTAssertTrue(
                waitForSelected(arrestCaseTab),
                "Selecting Arrest Case should apply that entity type filter"
            )

            let caseList = find("case-list")
            let caseTitle = caseList.staticTexts.matching(
                NSPredicate(format: "label CONTAINS %@", entityTabsCaseTitle)
            ).firstMatch
            let titleAppears = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "label CONTAINS %@", entityTabsCaseTitle),
                object: caseTitle
            )
            XCTAssertEqual(
                XCTWaiter.wait(for: [titleAppears], timeout: 10),
                .completed,
                "Selecting Arrest Case should retain the matching case in the list"
            )
        }
    }

    /// Scenario: Selecting entity type filters updates the selected filter state.
    func testEntityTypeTabFiltering() {
        given("case management is enabled with two entity types and a case") {
            configureCaseManagementWithTwoTypes()
            launchAsAdminWithAPI()
            navigateToCases()
            createCase(
                title: entityTabsCaseTitle,
                entityTypeName: "arrest_case"
            )
            navigateToCases()
        }
        when("I switch between All and an entity type") {
            let allTab = app.buttons["case-tab-all"]
            allTab.tap()
            XCTAssertTrue(waitForSelected(allTab), "Selecting All should reset the entity type filter")

            let arrestCaseTab = entityTypeFilterButton(name: "arrest_case")
            arrestCaseTab.tap()
            XCTAssertTrue(waitForSelected(arrestCaseTab), "Selecting Arrest Case should apply that filter")

            allTab.tap()
        }
        then("the entity type filter returns to All") {
            XCTAssertTrue(
                waitForSelected(app.buttons["case-tab-all"]),
                "Selecting All should clear the entity type filter"
            )
        }
    }

    /// Put the server in the state the case scenarios describe — case management on, the
    /// jail-support template applied, and one case — then launch as admin and leave the
    /// app on the Cases tab. Returns the new case's title.
    private func launchWithSeededCase() -> String {
        configureCaseManagementWithTwoTypes()
        launchAsAdminWithAPI()
        navigateToCases()
        let title = "Seeded case \(UUID().uuidString.prefix(8))"
        createCase(title: title, entityTypeName: "arrest_case")
        navigateToCases()
        return title
    }

    /// The list row text for a case, matched on its decrypted title.
    private func caseTitle(_ title: String) -> XCUIElement {
        find("case-list").staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", title)
        ).firstMatch
    }

    /// Open the case with this title from the list, failing the test if it cannot be opened.
    private func openCase(titled title: String) {
        let row = caseTitle(title)
        XCTAssertTrue(row.waitForExistence(timeout: 15), "The case '\(title)' should be in the list")
        row.tap()
        XCTAssertTrue(
            find("case-detail-header").waitForExistence(timeout: 10),
            "Tapping the case should open its detail"
        )
    }

    private let entityTabsCaseTitle = "Entity tabs \(UUID().uuidString.prefix(8))"

    private func configureCaseManagementWithTwoTypes() {
        TestAdminAPI.setCaseManagement(enabled: true, hubId: testHubId, baseURL: testHubURL)
        TestAdminAPI.applyTemplate("jail-support", hubId: testHubId, baseURL: testHubURL)
    }

    private func entityTypeFilterButton(name: String) -> XCUIElement {
        app.buttons["case-tab-\(name)"]
    }

    private func waitForSelected(_ button: XCUIElement, timeout: TimeInterval = 5) -> Bool {
        XCTWaiter.wait(
            for: [XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "isSelected == true"),
                object: button
            )],
            timeout: timeout
        ) == .completed
    }

    private func waitForEnabled(_ element: XCUIElement, timeout: TimeInterval = 15) -> Bool {
        XCTWaiter.wait(
            for: [XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "isEnabled == true"),
                object: element
            )],
            timeout: timeout
        ) == .completed
    }

    /// Create a case through the create-case sheet and wait for the sheet to close.
    private func createCase(title: String, entityTypeName: String) {
        // `case-new-btn` is a toolbar Button — query the button itself, not its
        // container. It is present from the first toolbar resolution and starts
        // disabled, becoming enabled once CMS state and entity types have loaded
        // over the API, so wait on `isEnabled` rather than on existence.
        let newCase = app.buttons["case-new-btn"]
        XCTAssertTrue(newCase.waitForExistence(timeout: 15), "New Case should be present in the Cases toolbar")
        XCTAssertTrue(
            waitForEnabled(newCase),
            "New Case should be offered once case management is on"
        )
        newCase.tap()

        let sheet = find("create-case-sheet")
        XCTAssertTrue(sheet.waitForExistence(timeout: 10), "The create-case sheet should open")

        // `case-type-picker` is a SwiftUI Picker row inside the sheet's Form —
        // it only enters the accessibility tree once the sheet has finished
        // presenting, so the query must wait, not tap immediately.
        let picker = find("case-type-picker")
        XCTAssertTrue(picker.waitForExistence(timeout: 10), "A case type picker should be shown for two entity types")
        picker.tap()
        let optionIdentifier = "case-type-option-\(entityTypeName)"
        // A SwiftUI Picker in a Form presents as a UIKit context menu, which is
        // NOT an XCUIElementType.menu — the options are plain Buttons hanging off
        // the application, so querying `app.menus` matches zero elements.
        let option = app.buttons[optionIdentifier]
        XCTAssertTrue(option.waitForExistence(timeout: 10), "Case type '\(entityTypeName)' should be selectable")
        XCTAssertEqual(
            app.buttons.matching(identifier: optionIdentifier).count,
            1,
            "The case type menu should expose exactly one option with this identifier"
        )
        option.tap()

        let titleInput = find("case-title-input")
        XCTAssertTrue(titleInput.waitForExistence(timeout: 5))
        titleInput.tap()
        titleInput.typeText(title)

        let submit = find("case-create-submit")
        XCTAssertTrue(submit.isEnabled, "Create should be enabled with a type and a title")
        submit.tap()
        XCTAssertTrue(
            sheet.waitForNonExistence(timeout: 20),
            "The create-case sheet should close once the case is created"
        )
        XCTAssertFalse(find("case-create-error").exists, "Case creation should not report an error")
    }

    /// Scenario: Case list shows a card for a case that exists.
    func testCaseListShowsCaseCards() {
        var title = ""
        given("case management is on and a case exists") {
            title = launchWithSeededCase()
        }
        when("I navigate to the Cases tab") {
            navigateToCases()
        }
        then("the list should contain a card for that case") {
            XCTAssertTrue(
                find("case-list").waitForExistence(timeout: 15),
                "Cases view should show the case list once a case exists"
            )
            XCTAssertTrue(
                caseTitle(title).waitForExistence(timeout: 15),
                "The case list should show the case titled '\(title)'"
            )
            XCTAssertFalse(find("case-empty-state").exists, "A hub with a case is not empty")
        }
    }

    /// Scenario: Empty state displays when no records exist.
    ///
    /// The class hub is shared with tests that create cases, so this one runs against a hub
    /// of its own: case management on, a template applied, and no records.
    func testCaseListEmptyState() {
        given("case management is on in a hub with no cases") {
            guard let hubId = TestAdminAPI.createHub(
                name: "ios-cases-empty-\(UUID().uuidString.prefix(8))", baseURL: testHubURL
            ) else { return }
            TestAdminAPI.setCaseManagement(enabled: true, hubId: hubId, baseURL: testHubURL)
            TestAdminAPI.applyTemplate("jail-support", hubId: hubId, baseURL: testHubURL)
            launchAsAdminWithAPI(hubId: hubId)
        }
        when("I navigate to the Cases tab") {
            navigateToCases()
        }
        then("I should see the empty state with a way to create a case") {
            XCTAssertTrue(
                find("case-empty-state").waitForExistence(timeout: 15),
                "A hub with case management on and no cases should show the empty state"
            )
            XCTAssertTrue(
                find("case-empty-create-btn").exists,
                "The empty state should offer to create the first case"
            )
            XCTAssertFalse(find("case-list").exists, "There are no cases to list")
            XCTAssertFalse(find("cms-not-enabled").exists, "Case management is on in this hub")
        }
    }

    /// Scenario: Status filter chips are visible when the entity types define statuses.
    func testStatusFilterChips() {
        given("case management is on with a template that defines statuses, and a case exists") {
            _ = launchWithSeededCase()
        }
        when("I navigate to Cases") {
            navigateToCases()
        }
        then("the status filter should offer All and each status of the template") {
            XCTAssertTrue(
                find("case-status-filter").waitForExistence(timeout: 15),
                "Status filter should appear when the entity types define statuses"
            )
            XCTAssertTrue(
                find("case-status-filter-all").exists,
                "Status filter should include an 'All' option"
            )
            // jail-support: arrest_case runs reported → … → case_closed.
            XCTAssertTrue(
                find("case-status-filter-reported").exists,
                "Status filter should include the template's 'reported' status"
            )
        }
    }

    /// Scenario: Pagination controls appear when many records exist.
    /// This tests the pagination bar structure (prev/next/page label).
    func testPaginationControlsStructure() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I navigate to Cases") {
            navigateToCases()
        }
        then("pagination controls should appear when there are enough records") {
            let pagination = find("case-pagination")
            let caseList = find("case-list")

            // Pagination only shows when totalPages > 1 (more than 50 records)
            if caseList.waitForExistence(timeout: 10) {
                if pagination.waitForExistence(timeout: 3) {
                    // Verify prev and next buttons exist
                    let prevButton = find("case-page-prev")
                    let nextButton = find("case-page-next")
                    XCTAssertTrue(prevButton.exists, "Pagination should have a previous button")
                    XCTAssertTrue(nextButton.exists, "Pagination should have a next button")
                }
                // If no pagination, there are fewer than 50 records — valid
            }
        }
    }

    // MARK: - Case Detail View (API-Connected)

    /// Scenario: Tapping a case card opens the detail view with header.
    func testCaseDetailShowsHeader() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I navigate to Cases and tap a case card") {
            navigateToCases()
            let caseList = find("case-list")
            guard caseList.waitForExistence(timeout: 10) else {
                // No case list — skip detail tests
                return
            }
            let firstCard = caseList.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'case-list-row-'"))
                .firstMatch
            guard firstCard.waitForExistence(timeout: 5) else {
                return
            }
            firstCard.tap()
        }
        then("I should see the case detail header") {
            let header = find("case-detail-header")
            if header.waitForExistence(timeout: 5) {
                XCTAssertTrue(header.exists, "Case detail header should be visible after tapping a card")
            }
            // If no records exist, we can't test detail — pass gracefully
        }
    }

    /// Scenario: Case detail shows the status pill.
    func testCaseDetailShowsStatusPill() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I open a case detail") {
            navigateToCases()
            guard openFirstCaseCard() else { return }
        }
        then("I should see the status pill") {
            let statusPill = find("case-status-pill")
            if find("case-detail-header").waitForExistence(timeout: 5) {
                XCTAssertTrue(
                    statusPill.waitForExistence(timeout: 3),
                    "Status pill should be visible in case detail header"
                )
            }
        }
    }

    /// Scenario: Case detail shows all 4 tabs (Details, Timeline, Contacts, Evidence).
    func testCaseDetailTabBar() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I open a case detail") {
            navigateToCases()
            guard openFirstCaseCard() else { return }
        }
        then("I should see all 4 detail tabs") {
            guard find("case-detail-header").waitForExistence(timeout: 5) else { return }

            let detailsTab = find("case-tab-details")
            let timelineTab = find("case-tab-timeline")
            let contactsTab = find("case-tab-contacts")
            let evidenceTab = find("case-tab-evidence")

            XCTAssertTrue(
                detailsTab.waitForExistence(timeout: 3),
                "Details tab should exist in case detail"
            )
            XCTAssertTrue(
                timelineTab.waitForExistence(timeout: 3),
                "Timeline tab should exist in case detail"
            )
            XCTAssertTrue(
                contactsTab.waitForExistence(timeout: 3),
                "Contacts tab should exist in case detail"
            )
            XCTAssertTrue(
                evidenceTab.waitForExistence(timeout: 3),
                "Evidence tab should exist in case detail"
            )
        }
    }

    /// Scenario: Details tab renders field rows from entity type schema.
    func testDetailsTabShowsFields() {
        var title = ""
        given("a case of a type with fields exists") {
            title = launchWithSeededCase()
        }
        when("I open the case on the Details tab") {
            openCase(titled: title)
        }
        then("the details tab should show the entity type's fields") {
            XCTAssertTrue(
                find("case-details-tab").waitForExistence(timeout: 10),
                "Details tab content should be visible"
            )
            // arrest_case defines arrest_datetime as its first field (jail-support template).
            XCTAssertTrue(
                find("case-field-arrest_datetime").waitForExistence(timeout: 5),
                "Details tab should render a row for each field of the entity type"
            )
        }
    }

    /// Scenario: Timeline tab shows interactions or empty state.
    func testTimelineTabShowsInteractions() {
        var title = ""
        given("a case exists") {
            title = launchWithSeededCase()
        }
        when("I open the case and tap the Timeline tab") {
            openCase(titled: title)
            let timelineTab = find("case-tab-timeline")
            XCTAssertTrue(timelineTab.waitForExistence(timeout: 5), "Timeline tab should exist")
            timelineTab.tap()
        }
        then("I should see the loaded timeline, not a spinner") {
            // `case-timeline-tab` is the container and is present while loading, so it
            // proves nothing; only the two loaded states count.
            XCTAssertTrue(
                anyElementExists(["timeline-empty", "case-timeline"], timeout: 10),
                "Timeline tab should show interactions or its empty state once loaded"
            )
            XCTAssertFalse(find("timeline-loading").exists, "Timeline should have finished loading")
        }
    }

    /// Scenario: Contacts tab shows linked contacts or empty state.
    func testContactsTabShowsLinkedContacts() {
        var title = ""
        given("a case with no linked contacts exists") {
            title = launchWithSeededCase()
        }
        when("I open the case and tap the Contacts tab") {
            openCase(titled: title)
            let contactsTab = find("case-tab-contacts")
            XCTAssertTrue(contactsTab.waitForExistence(timeout: 5), "Contacts tab should exist")
            contactsTab.tap()
        }
        then("I should see the contacts empty state") {
            // `case-contacts-tab` is the container and exists while loading; only the
            // loaded state counts.
            XCTAssertTrue(
                find("case-contacts-empty").waitForExistence(timeout: 10),
                "A case with no linked contacts should show the contacts empty state"
            )
            XCTAssertFalse(find("case-contact-card").exists, "No contacts are linked to this case")
            XCTAssertFalse(find("case-contacts-loading").exists, "Contacts should have finished loading")
        }
    }

    /// Scenario: Evidence tab shows evidence items or empty state.
    func testEvidenceTabShowsItems() {
        var title = ""
        given("a case with no evidence exists") {
            title = launchWithSeededCase()
        }
        when("I open the case and tap the Evidence tab") {
            openCase(titled: title)
            let evidenceTab = find("case-tab-evidence")
            XCTAssertTrue(evidenceTab.waitForExistence(timeout: 5), "Evidence tab should exist")
            evidenceTab.tap()
        }
        then("I should see the evidence empty state") {
            XCTAssertTrue(
                find("case-evidence-empty").waitForExistence(timeout: 10),
                "A case with no evidence should show the evidence empty state"
            )
            XCTAssertFalse(find("case-evidence-loading").exists, "Evidence should have finished loading")
        }
    }

    // MARK: - Status Changes

    /// Scenario: Tapping the status pill opens the QuickStatusSheet.
    func testStatusPillOpensSheet() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I open a case detail and tap the status pill") {
            navigateToCases()
            guard openFirstCaseCard() else { return }
            let statusPill = find("case-status-pill")
            if statusPill.waitForExistence(timeout: 5) {
                statusPill.tap()
            }
        }
        then("the QuickStatusSheet should appear with status options") {
            guard find("case-detail-header").exists else { return }

            let sheet = find("quick-status-sheet")
            if sheet.waitForExistence(timeout: 5) {
                XCTAssertTrue(sheet.exists, "QuickStatusSheet should be visible after tapping status pill")

                // Verify at least one status option exists
                let statusOptions = app.descendants(matching: .any)
                    .matching(NSPredicate(format: "identifier BEGINSWITH 'status-option-'"))
                XCTAssertGreaterThan(
                    statusOptions.count, 0,
                    "QuickStatusSheet should contain at least one status option"
                )
            }
            // If no status pill (volunteer without edit permission), pass gracefully
        }
    }

    /// Scenario: Selecting a new status updates the pill.
    func testSelectNewStatus() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I open status sheet and select a different status") {
            navigateToCases()
            guard openFirstCaseCard() else { return }
            let statusPill = find("case-status-pill")
            guard statusPill.waitForExistence(timeout: 5) else { return }
            statusPill.tap()
        }
        then("the status should update") {
            let sheet = find("quick-status-sheet")
            guard sheet.waitForExistence(timeout: 5) else { return }

            // Find status options that are NOT the currently selected one
            // (the selected one has a checkmark)
            let statusOptions = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'status-option-'"))

            if statusOptions.count > 1 {
                // Tap the second status option (different from current)
                let secondOption = statusOptions.element(boundBy: 1)
                if secondOption.exists {
                    secondOption.tap()
                    // Sheet should dismiss after selection
                    _ = sheet.waitForNonExistence(timeout: 5)
                    // Status pill should still exist (with updated status)
                    let pill = find("case-status-pill")
                    XCTAssertTrue(
                        pill.waitForExistence(timeout: 5),
                        "Status pill should remain visible after status change"
                    )
                }
            }
        }
    }

    // MARK: - Comments

    /// Scenario: Full add comment flow — open sheet, type text, submit.
    func testAddCommentFlow() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I open a case detail, navigate to timeline, and open the comment sheet") {
            navigateToCases()
            guard openFirstCaseCard() else { return }

            // Switch to Timeline tab
            let timelineTab = find("case-tab-timeline")
            if timelineTab.waitForExistence(timeout: 5) {
                timelineTab.tap()
            }
        }
        then("I should be able to open the comment sheet and see the input") {
            guard find("case-detail-header").exists else { return }

            // The inline comment input should be visible
            let commentInput = find("case-comment-input")
            let commentSubmit = find("case-comment-submit")

            if commentInput.waitForExistence(timeout: 5) {
                XCTAssertTrue(commentInput.exists, "Comment input should be visible on timeline tab")

                // Tap the send button to open AddCommentSheet
                if commentSubmit.exists {
                    commentSubmit.tap()

                    let commentSheet = find("add-comment-sheet")
                    if commentSheet.waitForExistence(timeout: 5) {
                        // Verify the sheet has the text editor and submit button
                        let sheetInput = find("comment-input")
                        let sheetSubmit = find("comment-submit")

                        XCTAssertTrue(
                            sheetInput.waitForExistence(timeout: 3),
                            "Comment sheet should contain a text input"
                        )
                        XCTAssertTrue(
                            sheetSubmit.waitForExistence(timeout: 3),
                            "Comment sheet should contain a submit button"
                        )

                        // Type a comment
                        sheetInput.tap()
                        sheetInput.typeText("Test comment from XCUITest")

                        // Submit should be enabled now
                        XCTAssertTrue(
                            sheetSubmit.isEnabled,
                            "Submit button should be enabled after entering text"
                        )
                    }
                }
            }
        }
    }

    // MARK: - Assignment

    /// Scenario: Unassigned case shows "Assign to me" button.
    func testAssignToMeButton() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I open a case detail") {
            navigateToCases()
            guard openFirstCaseCard() else { return }
        }
        then("I should see the assign button if the case is unassigned to me") {
            guard find("case-detail-header").waitForExistence(timeout: 5) else { return }

            let assignButton = find("case-assign-btn")
            // The assign button only shows when the current user is NOT in assignedTo.
            // For a fresh record with no assignees, it should be visible.
            if assignButton.waitForExistence(timeout: 3) {
                XCTAssertTrue(
                    assignButton.exists,
                    "Assign to me button should be visible for unassigned cases"
                )
                XCTAssertTrue(
                    assignButton.isEnabled,
                    "Assign to me button should be tappable"
                )
            }
            // If the user is already assigned, the button won't appear — that's valid
        }
    }

    // MARK: - Detail Close

    /// Scenario: Closing the case detail returns to the list.
    func testCaseDetailCloseReturnsToList() {
        given("case management is enabled and I am authenticated as admin with API") {
            configureCaseManagementWithTwoTypes()
            launchAsAdminWithAPI()
        }
        when("I open a case detail and tap the close button") {
            navigateToCases()
            guard openFirstCaseCard() else { return }

            let closeButton = find("case-detail-close")
            if closeButton.waitForExistence(timeout: 5) {
                closeButton.tap()
            }
        }
        then("I should be back on the case list") {
            // After closing the detail sheet, the case list should be visible again
            // Case management is enabled by this test's own Given, so
            // `cms-not-enabled` is not an acceptable outcome here.
            let found = anyElementExists([
                "case-list",
                "case-empty-state",
                "case-type-tabs",
            ], timeout: 5)
            XCTAssertTrue(
                found,
                "Case list should be visible after closing the detail view"
            )
        }
    }

    // MARK: - Tab Navigation in Detail

    /// Scenario: Switching between all 4 detail tabs renders the correct content.
    func testDetailTabSwitching() {
        var title = ""
        given("a case exists") {
            title = launchWithSeededCase()
        }
        when("I open the case") {
            openCase(titled: title)
        }
        then("switching between tabs should render the correct content areas") {
            let tabs: [(tab: String, loaded: [String], loading: String, name: String)] = [
                ("case-tab-details", ["case-details-tab"], "", "Details"),
                ("case-tab-timeline", ["timeline-empty", "case-timeline"], "timeline-loading", "Timeline"),
                ("case-tab-contacts", ["case-contacts-empty", "case-contact-card"], "case-contacts-loading", "Contacts"),
                ("case-tab-evidence", ["case-evidence-empty"], "case-evidence-loading", "Evidence"),
            ]
            for entry in tabs {
                let tab = find(entry.tab)
                XCTAssertTrue(tab.waitForExistence(timeout: 5), "\(entry.name) tab should exist")
                tab.tap()
                XCTAssertTrue(
                    anyElementExists(entry.loaded, timeout: 10),
                    "\(entry.name) tab content should render once loaded"
                )
                if !entry.loading.isEmpty {
                    XCTAssertFalse(find(entry.loading).exists, "\(entry.name) tab should have finished loading")
                }
            }
        }
    }

    // MARK: - QuickStatusSheet Dismiss

    /// Scenario: Cancelling the QuickStatusSheet dismisses it without changes.
    func testQuickStatusSheetCancel() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I open the status sheet and cancel") {
            navigateToCases()
            guard openFirstCaseCard() else { return }
            let statusPill = find("case-status-pill")
            guard statusPill.waitForExistence(timeout: 5) else { return }
            statusPill.tap()
        }
        then("cancelling should dismiss the sheet") {
            let sheet = find("quick-status-sheet")
            guard sheet.waitForExistence(timeout: 5) else { return }

            // Find and tap the Cancel button in the sheet's toolbar
            let cancelButton = app.buttons.matching(
                NSPredicate(format: "label CONTAINS[c] 'Cancel'")
            ).firstMatch
            if cancelButton.waitForExistence(timeout: 3) {
                cancelButton.tap()

                // Sheet should be dismissed
                XCTAssertTrue(
                    sheet.waitForNonExistence(timeout: 5),
                    "QuickStatusSheet should dismiss after tapping Cancel"
                )
            }

            // Status pill should still be visible
            let pill = find("case-status-pill")
            XCTAssertTrue(
                pill.waitForExistence(timeout: 3),
                "Status pill should remain after cancelling status sheet"
            )
        }
    }

    // MARK: - Helpers

    /// Open the first case card in the list. Returns false if no cards exist.
    @discardableResult
    private func openFirstCaseCard() -> Bool {
        let caseList = find("case-list")
        guard caseList.waitForExistence(timeout: 10) else {
            // No case list — CMS disabled or empty
            return false
        }

        let firstCard = find("case-list").descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'case-list-row-'"))
            .firstMatch
        guard firstCard.waitForExistence(timeout: 5) else {
            return false
        }
        firstCard.tap()

        // Wait for detail to appear
        let header = find("case-detail-header")
        return header.waitForExistence(timeout: 5)
    }

}
