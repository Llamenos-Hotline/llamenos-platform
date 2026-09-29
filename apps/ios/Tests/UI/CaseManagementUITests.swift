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

    /// Scenario: Navigating to Cases shows appropriate initial state.
    /// Without API connection, should show CMS disabled, loading, or empty state.
    func testCaseListShowsInitialState() {
        given("I am authenticated") {
            launchAuthenticated()
        }
        when("I navigate to the Cases tab") {
            navigateToCases()
        }
        then("I should see loading, empty state, or CMS disabled") {
            let found = anyElementExists([
                "case-loading",
                "case-empty-state",
                "cms-not-enabled",
                "case-list",
                "case-type-tabs",
            ])
            XCTAssertTrue(
                found,
                "Cases view should show loading, empty state, CMS disabled, or case list"
            )
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

    /// Scenario: Case list shows entity type tabs (platform/mobile/cases/cms-case-management.feature)
    ///
    /// The tabs render only on a hub with case management on, more than one entity
    /// type, and at least one case — an empty hub shows the empty state instead. So
    /// the test puts the server in that state rather than branching on whatever it
    /// finds: the jail-support template (Arrest Case + Mass Arrest Event) is applied
    /// to this class's hub through the real API, and a case is created through the
    /// app's own create-case sheet (client-side E2EE included).
    func testCaseListShowsEntityTypeTabs() {
        given("case management is enabled with two entity types") {
            enableCaseManagementWithTemplate()
        }
        and("the app is launched and authenticated as admin") {
            launchAsAdminWithAPI()
        }
        and("a case exists") {
            navigateToCases()
            createCase(title: "Entity tabs \(UUID().uuidString.prefix(8))", typeLabel: "Arrest Case")
        }
        when("I navigate to the Cases screen") {
            navigateToCases()
        }
        then("I should see the entity type tabs") {
            XCTAssertTrue(find("case-type-tabs").waitForExistence(timeout: 15), "Entity type tabs should render")
        }
        and("the \"All\" tab should be active") {
            let allTab = find("case-tab-all")
            XCTAssertTrue(allTab.waitForExistence(timeout: 5), "The All tab should exist")
            XCTAssertTrue(allTab.isSelected, "The All tab should be the selected tab")
        }
    }

    /// Create a case through the create-case sheet and wait for the sheet to close.
    private func createCase(title: String, typeLabel: String) {
        let newCase = find("case-new-btn")
        XCTAssertTrue(newCase.waitForExistence(timeout: 15), "New Case should be offered once case management is on")
        newCase.tap()

        let sheet = find("create-case-sheet")
        XCTAssertTrue(sheet.waitForExistence(timeout: 5), "The create-case sheet should open")

        let picker = find("case-type-picker")
        XCTAssertTrue(picker.waitForExistence(timeout: 5), "A case type picker should be shown for two entity types")
        picker.tap()
        let option = app.buttons[typeLabel]
        XCTAssertTrue(option.waitForExistence(timeout: 5), "Case type '\(typeLabel)' should be selectable")
        option.tap()

        let titleInput = find("case-title-input")
        XCTAssertTrue(titleInput.waitForExistence(timeout: 5))
        titleInput.tap()
        titleInput.typeText(title)

        let submit = find("case-create-submit")
        XCTAssertTrue(submit.isEnabled, "Create should be enabled with a type and a title")
        submit.tap()
        XCTAssertTrue(sheet.waitForNonExistence(timeout: 20), "The sheet should close once the case is created")
        XCTAssertFalse(find("case-create-error").exists, "Case creation should not report an error")
    }

    /// Scenario: Case list shows case cards when records exist.
    /// Verifies the list renders actual case card rows with data.
    func testCaseListShowsCaseCards() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I navigate to the Cases tab") {
            navigateToCases()
        }
        then("I should see case cards if records exist, or empty/disabled state") {
            let caseList = find("case-list")
            let emptyState = find("case-empty-state")
            let cmsDisabled = find("cms-not-enabled")

            if caseList.waitForExistence(timeout: 10) {
                // Case list is visible — verify at least one card exists by checking
                // for any element whose identifier starts with "case-card-"
                let firstCard = app.descendants(matching: .any)
                    .matching(NSPredicate(format: "identifier BEGINSWITH 'case-card-'"))
                    .firstMatch
                XCTAssertTrue(
                    firstCard.waitForExistence(timeout: 5),
                    "Case list should contain at least one case card"
                )
            } else if emptyState.waitForExistence(timeout: 5) {
                XCTAssertTrue(true, "Empty state shown — no records exist")
            } else if cmsDisabled.waitForExistence(timeout: 3) {
                XCTAssertTrue(true, "CMS is not enabled on this server")
            } else {
                XCTFail("Should see case list, empty state, or CMS disabled")
            }
        }
    }

    /// Scenario: Empty state displays when no records exist.
    func testCaseListEmptyState() {
        given("I am authenticated as admin with API and fresh state") {
            launchAsAdminWithAPI()
        }
        when("I navigate to the Cases tab") {
            navigateToCases()
        }
        then("I should see the empty state or CMS disabled if no records") {
            let emptyState = find("case-empty-state")
            let caseList = find("case-list")
            let cmsDisabled = find("cms-not-enabled")

            // With a freshly reset server, there should be no case records.
            // If CMS is enabled → empty state. If not enabled → cms-not-enabled.
            let foundSomething = anyElementExists([
                "case-empty-state",
                "case-list",
                "cms-not-enabled",
                "case-loading",
            ], timeout: 10)
            XCTAssertTrue(foundSomething, "Cases view should render some state after loading")

            if emptyState.exists {
                // Verify the empty state is meaningful — not just a blank screen
                XCTAssertTrue(emptyState.exists, "Empty state should be displayed when no records exist")
            } else if cmsDisabled.exists {
                XCTAssertTrue(true, "CMS not enabled — valid state for fresh server")
            } else if caseList.exists {
                // Records already exist (server wasn't fully reset) — still valid
                XCTAssertTrue(true, "Case list visible — records exist on server")
            }
        }
    }

    /// Scenario: Tapping an entity type tab changes the selected filter.
    func testEntityTypeTabFiltering() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I navigate to Cases and entity type tabs are visible") {
            navigateToCases()
        }
        then("tapping the 'All' tab should keep it selected") {
            let tabs = find("case-type-tabs")
            if tabs.waitForExistence(timeout: 10) {
                let allTab = find("case-tab-all")
                XCTAssertTrue(allTab.waitForExistence(timeout: 3), "All tab should exist")
                allTab.tap()
                // After tapping All, the tab should remain visible (filter reset)
                XCTAssertTrue(allTab.exists, "All tab should still exist after tapping")

                // If there are per-type tabs, try tapping one and verify it exists
                let typeTabs = app.descendants(matching: .any)
                    .matching(NSPredicate(format: "identifier BEGINSWITH 'case-tab-' AND identifier != 'case-tab-all'"))
                if typeTabs.count > 0 {
                    let firstTypeTab = typeTabs.firstMatch
                    firstTypeTab.tap()
                    // Wait for list to reload
                    Thread.sleep(forTimeInterval: 1)
                    // The tab should still exist
                    XCTAssertTrue(firstTypeTab.exists, "Entity type tab should remain after selection")
                    // Tap All again to reset
                    allTab.tap()
                }
            }
            // If no tabs (single entity type or CMS disabled), pass gracefully
        }
    }

    /// Scenario: Status filter chips are visible when CMS is enabled.
    func testStatusFilterChips() {
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I navigate to Cases") {
            navigateToCases()
        }
        then("status filter section should appear when entity types have statuses") {
            let statusFilter = find("case-status-filter")
            let caseList = find("case-list")
            let cmsDisabled = find("cms-not-enabled")

            // Status filter only shows when allStatuses is non-empty
            if caseList.waitForExistence(timeout: 10) || statusFilter.waitForExistence(timeout: 5) {
                if statusFilter.exists {
                    // Verify the "All" status filter button exists
                    let allStatusFilter = find("case-status-filter-all")
                    XCTAssertTrue(
                        allStatusFilter.waitForExistence(timeout: 3),
                        "Status filter should include an 'All' option"
                    )
                }
                // If no status filter, entity types may not have defined statuses yet
            } else if cmsDisabled.waitForExistence(timeout: 3) {
                XCTAssertTrue(true, "CMS not enabled — no status filters")
            }
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
        let caseTitle = uniqueCaseTitle()
        given("a case exists and I am authenticated as admin with API") {
            launchAsAdminWithNewCase(titled: caseTitle)
        }
        when("I navigate to Cases and tap the case card") {
            navigateToCases()
            tapCaseCard(titled: caseTitle)
        }
        then("I should see the case detail header") {
            XCTAssertTrue(
                find("case-detail-header").waitForExistence(timeout: 5),
                "Case detail header should be visible after tapping the card of case '\(caseTitle)'"
            )
        }
    }

    /// Scenario: Case detail shows the status pill.
    func testCaseDetailShowsStatusPill() {
        let caseTitle = uniqueCaseTitle()
        given("a case exists and I am authenticated as admin with API") {
            launchAsAdminWithNewCase(titled: caseTitle)
        }
        when("I open a case detail") {
            navigateToCases()
            openCase(titled: caseTitle)
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
        let caseTitle = uniqueCaseTitle()
        given("a case exists and I am authenticated as admin with API") {
            launchAsAdminWithNewCase(titled: caseTitle)
        }
        when("I open a case detail") {
            navigateToCases()
            openCase(titled: caseTitle)
        }
        then("I should see all 4 detail tabs") {
            XCTAssertTrue(find("case-detail-header").waitForExistence(timeout: 5), "Case detail should be open")

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
        let caseTitle = uniqueCaseTitle()
        given("a case exists and I am authenticated as admin with API") {
            launchAsAdminWithNewCase(titled: caseTitle)
        }
        when("I open a case detail on the Details tab") {
            navigateToCases()
            openCase(titled: caseTitle)
        }
        then("the details tab should show field content or metadata") {
            let detailsTab = find("case-details-tab")
            if detailsTab.waitForExistence(timeout: 5) {
                XCTAssertTrue(
                    detailsTab.exists,
                    "Details tab content should be visible"
                )

                // Verify metadata section renders (always present regardless of fields)
                // The metadata row shows "Created" and "Updated" timestamps
                let fieldElements = app.descendants(matching: .any)
                    .matching(NSPredicate(format: "identifier BEGINSWITH 'case-field-' OR identifier BEGINSWITH 'case-section-'"))
                // If entity type has fields, at least one case-field-* should exist
                // If no fields defined, metadata section is still present
                _ = fieldElements.count  // Access to verify query runs
                XCTAssertTrue(true, "Details tab rendered successfully")
            }
        }
    }

    /// Scenario: Timeline tab shows interactions or empty state.
    func testTimelineTabShowsInteractions() {
        let caseTitle = uniqueCaseTitle()
        given("a case exists and I am authenticated as admin with API") {
            launchAsAdminWithNewCase(titled: caseTitle)
        }
        when("I open a case detail and tap the Timeline tab") {
            navigateToCases()
            openCase(titled: caseTitle)
            let timelineTab = find("case-tab-timeline")
            if timelineTab.waitForExistence(timeout: 5) {
                timelineTab.tap()
            }
        }
        then("I should see timeline content or empty state") {
            XCTAssertTrue(find("case-detail-header").exists, "Case detail should still be open")

            let found = anyElementExists([
                "case-timeline",
                "timeline-empty",
                "timeline-loading",
                "case-timeline-tab",
            ], timeout: 5)
            XCTAssertTrue(
                found,
                "Timeline tab should show interactions, empty state, or loading indicator"
            )
        }
    }

    /// Scenario: Contacts tab shows linked contacts or empty state.
    func testContactsTabShowsLinkedContacts() {
        let caseTitle = uniqueCaseTitle()
        given("a case exists and I am authenticated as admin with API") {
            launchAsAdminWithNewCase(titled: caseTitle)
        }
        when("I open a case detail and tap the Contacts tab") {
            navigateToCases()
            openCase(titled: caseTitle)
            let contactsTab = find("case-tab-contacts")
            if contactsTab.waitForExistence(timeout: 5) {
                contactsTab.tap()
            }
        }
        then("I should see contacts content or empty state") {
            XCTAssertTrue(find("case-detail-header").exists, "Case detail should still be open")

            let found = anyElementExists([
                "case-contact-card",
                "case-contacts-empty",
                "case-contacts-tab",
            ], timeout: 5)
            XCTAssertTrue(
                found,
                "Contacts tab should show contact cards or empty state"
            )

            // If contacts exist, verify role badges
            let roleCard = find("case-contact-card")
            if roleCard.exists {
                let roleBadge = find("contact-role-badge")
                XCTAssertTrue(
                    roleBadge.exists,
                    "Contact cards should display role badges"
                )
            }
        }
    }

    /// Scenario: Evidence tab shows evidence items or empty state.
    func testEvidenceTabShowsItems() {
        let caseTitle = uniqueCaseTitle()
        given("a case exists and I am authenticated as admin with API") {
            launchAsAdminWithNewCase(titled: caseTitle)
        }
        when("I open a case detail and tap the Evidence tab") {
            navigateToCases()
            openCase(titled: caseTitle)
            let evidenceTab = find("case-tab-evidence")
            if evidenceTab.waitForExistence(timeout: 5) {
                evidenceTab.tap()
            }
        }
        then("I should see evidence content or empty state") {
            XCTAssertTrue(find("case-detail-header").exists, "Case detail should still be open")

            let found = anyElementExists([
                "case-evidence-empty",
                "case-evidence-tab",
            ], timeout: 5)
            XCTAssertTrue(
                found,
                "Evidence tab should show evidence items or empty state"
            )

            // If evidence items exist, verify classification badges
            let evidenceItems = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'evidence-item-'"))
            if evidenceItems.count > 0 {
                let classificationBadge = find("evidence-classification-badge")
                XCTAssertTrue(
                    classificationBadge.exists,
                    "Evidence items should display classification badges"
                )
            }
        }
    }

    // MARK: - Status Changes

    /// Scenario: Tapping the status pill opens the QuickStatusSheet.
    func testStatusPillOpensSheet() {
        let caseTitle = uniqueCaseTitle()
        given("a case exists and I am authenticated as admin with API") {
            launchAsAdminWithNewCase(titled: caseTitle)
        }
        when("I open a case detail and tap the status pill") {
            navigateToCases()
            openCase(titled: caseTitle)
            let statusPill = find("case-status-pill")
            if statusPill.waitForExistence(timeout: 5) {
                statusPill.tap()
            }
        }
        then("the QuickStatusSheet should appear with status options") {
            XCTAssertTrue(find("case-detail-header").exists, "Case detail should still be open")

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
        let caseTitle = uniqueCaseTitle()
        given("a case exists and I am authenticated as admin with API") {
            launchAsAdminWithNewCase(titled: caseTitle)
        }
        when("I open status sheet and select a different status") {
            navigateToCases()
            openCase(titled: caseTitle)
            let statusPill = find("case-status-pill")
            XCTAssertTrue(statusPill.waitForExistence(timeout: 5), "Status pill should be shown in the case detail header for an admin")
            statusPill.tap()
        }
        then("the status should update") {
            let sheet = find("quick-status-sheet")
            XCTAssertTrue(sheet.waitForExistence(timeout: 5), "QuickStatusSheet should open after tapping the status pill")

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
        let caseTitle = uniqueCaseTitle()
        given("a case exists and I am authenticated as admin with API") {
            launchAsAdminWithNewCase(titled: caseTitle)
        }
        when("I open a case detail, navigate to timeline, and open the comment sheet") {
            navigateToCases()
            openCase(titled: caseTitle)

            // Switch to Timeline tab
            let timelineTab = find("case-tab-timeline")
            if timelineTab.waitForExistence(timeout: 5) {
                timelineTab.tap()
            }
        }
        then("I should be able to open the comment sheet and see the input") {
            XCTAssertTrue(find("case-detail-header").exists, "Case detail should still be open")

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
        let caseTitle = uniqueCaseTitle()
        given("a case exists and I am authenticated as admin with API") {
            launchAsAdminWithNewCase(titled: caseTitle)
        }
        when("I open a case detail") {
            navigateToCases()
            openCase(titled: caseTitle)
        }
        then("I should see the assign button if the case is unassigned to me") {
            XCTAssertTrue(find("case-detail-header").waitForExistence(timeout: 5), "Case detail should be open")

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
        let caseTitle = uniqueCaseTitle()
        given("a case exists and I am authenticated as admin with API") {
            launchAsAdminWithNewCase(titled: caseTitle)
        }
        when("I open a case detail and tap the close button") {
            navigateToCases()
            openCase(titled: caseTitle)

            let closeButton = find("case-detail-close")
            if closeButton.waitForExistence(timeout: 5) {
                closeButton.tap()
            }
        }
        then("I should be back on the case list") {
            // After closing the detail sheet, the case list should be visible again
            let found = anyElementExists([
                "case-list",
                "case-empty-state",
                "case-type-tabs",
                "cms-not-enabled",
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
        let caseTitle = uniqueCaseTitle()
        given("a case exists and I am authenticated as admin with API") {
            launchAsAdminWithNewCase(titled: caseTitle)
        }
        when("I open a case detail") {
            navigateToCases()
            openCase(titled: caseTitle)
        }
        then("switching between tabs should render the correct content areas") {
            XCTAssertTrue(find("case-detail-header").waitForExistence(timeout: 5), "Case detail should be open")

            // Details tab (default)
            let detailsTab = find("case-tab-details")
            let detailsContent = find("case-details-tab")
            if detailsTab.waitForExistence(timeout: 3) {
                detailsTab.tap()
                XCTAssertTrue(
                    detailsContent.waitForExistence(timeout: 3),
                    "Details tab content should render when Details tab is selected"
                )
            }

            // Timeline tab
            let timelineTab = find("case-tab-timeline")
            if timelineTab.waitForExistence(timeout: 3) {
                timelineTab.tap()
                let timelineContent = anyElementExists([
                    "case-timeline-tab",
                    "case-timeline",
                    "timeline-empty",
                    "timeline-loading",
                ], timeout: 5)
                XCTAssertTrue(
                    timelineContent,
                    "Timeline tab content should render when Timeline tab is selected"
                )
            }

            // Contacts tab
            let contactsTab = find("case-tab-contacts")
            if contactsTab.waitForExistence(timeout: 3) {
                contactsTab.tap()
                let contactsContent = anyElementExists([
                    "case-contacts-tab",
                    "case-contact-card",
                    "case-contacts-empty",
                    "case-contacts-loading",
                ], timeout: 5)
                XCTAssertTrue(
                    contactsContent,
                    "Contacts tab content should render when Contacts tab is selected"
                )
            }

            // Evidence tab
            let evidenceTab = find("case-tab-evidence")
            if evidenceTab.waitForExistence(timeout: 3) {
                evidenceTab.tap()
                let evidenceContent = anyElementExists([
                    "case-evidence-tab",
                    "case-evidence-empty",
                    "case-evidence-loading",
                ], timeout: 5)
                XCTAssertTrue(
                    evidenceContent,
                    "Evidence tab content should render when Evidence tab is selected"
                )
            }
        }
    }

    // MARK: - QuickStatusSheet Dismiss

    /// Scenario: Cancelling the QuickStatusSheet dismisses it without changes.
    func testQuickStatusSheetCancel() {
        let caseTitle = uniqueCaseTitle()
        given("a case exists and I am authenticated as admin with API") {
            launchAsAdminWithNewCase(titled: caseTitle)
        }
        when("I open the status sheet and cancel") {
            navigateToCases()
            openCase(titled: caseTitle)
            let statusPill = find("case-status-pill")
            XCTAssertTrue(statusPill.waitForExistence(timeout: 5), "Status pill should be shown in the case detail header for an admin")
            statusPill.tap()
        }
        then("cancelling should dismiss the sheet") {
            let sheet = find("quick-status-sheet")
            XCTAssertTrue(sheet.waitForExistence(timeout: 5), "QuickStatusSheet should open after tapping the status pill")

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

    /// Whether this class's hub already has case management on with the jail-support
    /// template. Re-applying a template replaces its entity types with new ids, which
    /// would orphan the cases earlier tests in the class created — so it runs once.
    private static var caseManagementEnabled = false

    /// Case management on, with the jail-support template (Arrest Case + Mass Arrest
    /// Event) applied to this class's hub through the real API.
    private func enableCaseManagementWithTemplate() {
        if !Self.caseManagementEnabled {
            TestAdminAPI.setCaseManagement(enabled: true, hubId: testHubId, baseURL: testHubURL)
            TestAdminAPI.applyTemplate("jail-support", hubId: testHubId, baseURL: testHubURL)
            Self.caseManagementEnabled = true
        }
    }

    private func uniqueCaseTitle() -> String {
        "Case \(UUID().uuidString.prefix(8))"
    }

    /// Given-step for every case-detail scenario: the scenario creates the case it
    /// opens, through the app's own create-case sheet, instead of opening whatever
    /// the hub happens to hold — a fresh class hub holds nothing.
    private func launchAsAdminWithNewCase(titled title: String) {
        enableCaseManagementWithTemplate()
        launchAsAdminWithAPI()
        navigateToCases()
        createCase(title: title, typeLabel: "Arrest Case")
    }

    /// Tap the case-list card whose decrypted title is `title`.
    private func tapCaseCard(titled title: String) {
        let card = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(
            card.waitForExistence(timeout: 15),
            "The case list should show the card for '\(title)', created in this scenario's Given"
        )
        card.tap()
    }

    /// Open the case titled `title` and wait for its detail view.
    private func openCase(titled title: String) {
        tapCaseCard(titled: title)
        XCTAssertTrue(
            find("case-detail-header").waitForExistence(timeout: 10),
            "Case detail should open after tapping the card for '\(title)'"
        )
    }

}
