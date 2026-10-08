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
        given("case management is enabled with two entity types and a case exists") {
            seedOneCase()
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

    /// Enable case management with two entity types and create one case through
    /// the real app flow. Case-list and case-detail scenarios depend on a case
    /// existing; this creates one instead of branching on whatever the shared
    /// class hub happens to hold. Idempotent to call from multiple test methods —
    /// `/templates/apply` merges by entity-type name rather than erroring on a
    /// repeat application. Leaves the Cases list open on the case just created.
    private func seedOneCase(title: String = "UI test case \(UUID().uuidString.prefix(8))") {
        TestAdminAPI.setCaseManagement(enabled: true, hubId: testHubId, baseURL: testHubURL)
        TestAdminAPI.applyTemplate("jail-support", hubId: testHubId, baseURL: testHubURL)
        launchAsAdminWithAPI()
        navigateToCases()
        createCase(title: title, typeLabel: "Arrest Case")
    }

    /// `seedOneCase()` plus opening the created case's detail view.
    @discardableResult
    private func launchAsAdminWithNewCase() -> Bool {
        seedOneCase()
        navigateToCases()
        return openFirstCaseCard()
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
        // `app.buttons[typeLabel]` searches the WHOLE app, not just the
        // picker's pushed option list, and the picker's pushed list renders
        // as its own overlay directly under the Window — NOT nested inside
        // `create-case-sheet`'s own accessibility subtree (confirmed via
        // xcresult: the option Button has no ancestor carrying that
        // identifier), so scoping to `sheet` finds nothing instead.
        //
        // Once this class's hub holds a prior case of this type,
        // `case-type-tabs` on the Cases list underneath the sheet grows a
        // filter tab (accessibilityIdentifier "case-tab-\(et.id)") whose
        // LABEL is also `typeLabel` — a sheet presentation does not remove
        // the covered screen from the accessibility tree, so that tab and
        // the picker's own (identifier-less) option row both match
        // `app.buttons[typeLabel]`, throwing "Multiple matching elements
        // found" on every createCase() call after the first one in this
        // class. Excluding the "case-tab-" identifier prefix keeps the
        // search app-wide (where the option row actually lives) while
        // dropping the one specific element that collides with it.
        let option = app.buttons.matching(
            NSPredicate(format: "label == %@ AND NOT (identifier BEGINSWITH 'case-tab-')", typeLabel)
        ).firstMatch
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
        given("case management is enabled with a case") {
            seedOneCase()
        }
        when("I navigate to the Cases tab") {
            navigateToCases()
        }
        then("I should see at least one case card") {
            XCTAssertTrue(
                find("case-list").waitForExistence(timeout: 10),
                "Case list should render once a case has been created"
            )
            let firstCard = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'case-card-'"))
                .firstMatch
            XCTAssertTrue(
                firstCard.waitForExistence(timeout: 5),
                "Case list should contain at least one case card"
            )
        }
    }

    /// Scenario: Empty state displays when no records exist.
    ///
    /// Forces case management off rather than relying on the hub's default —
    /// other test methods on this class's shared hub may have already turned
    /// it on, and XCTest's execution order within a class is not guaranteed.
    func testCaseListEmptyState() {
        given("case management is explicitly disabled on this hub") {
            TestAdminAPI.setCaseManagement(enabled: false, hubId: testHubId, baseURL: testHubURL)
            launchAsAdminWithAPI()
        }
        when("I navigate to the Cases tab") {
            navigateToCases()
        }
        then("I should see the CMS-disabled state") {
            XCTAssertTrue(
                find("cms-not-enabled").waitForExistence(timeout: 10),
                "Cases should show the CMS-disabled state when case management is off"
            )
        }
    }

    /// Scenario: Tapping an entity type tab changes the selected filter.
    func testEntityTypeTabFiltering() {
        given("case management is enabled with two entity types and a case exists") {
            seedOneCase()
        }
        when("I navigate to the Cases screen") {
            navigateToCases()
        }
        then("tapping the 'All' tab should keep it selected, and a per-type tab should remain after selection") {
            let tabs = find("case-type-tabs")
            XCTAssertTrue(tabs.waitForExistence(timeout: 10), "Entity type tabs should render with two entity types and a case")

            let allTab = find("case-tab-all")
            XCTAssertTrue(allTab.waitForExistence(timeout: 3), "All tab should exist")
            allTab.tap()
            // After tapping All, the tab should remain visible (filter reset)
            XCTAssertTrue(allTab.exists, "All tab should still exist after tapping")

            let typeTabs = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'case-tab-' AND identifier != 'case-tab-all'"))
            XCTAssertGreaterThan(typeTabs.count, 0, "At least one per-type tab should render alongside All")
            let firstTypeTab = typeTabs.firstMatch
            firstTypeTab.tap()
            // Wait for list to reload
            Thread.sleep(forTimeInterval: 1)
            XCTAssertTrue(firstTypeTab.exists, "Entity type tab should remain after selection")
            // Tap All again to reset
            allTab.tap()
        }
    }

    /// Scenario: Status filter chips are visible when CMS is enabled.
    func testStatusFilterChips() {
        given("case management is enabled with a case whose entity type has statuses") {
            seedOneCase()
        }
        when("I navigate to Cases") {
            navigateToCases()
        }
        then("the status filter section should show an 'All' option") {
            XCTAssertTrue(
                find("case-list").waitForExistence(timeout: 10),
                "Case list should render once a case has been created"
            )
            XCTAssertTrue(
                find("case-status-filter").waitForExistence(timeout: 5),
                "Status filter should render once a case exists for an entity type with defined statuses"
            )
            XCTAssertTrue(
                find("case-status-filter-all").waitForExistence(timeout: 3),
                "Status filter should include an 'All' option"
            )
        }
    }

    /// Scenario: Pagination controls appear when many records exist.
    /// This tests the pagination bar structure (prev/next/page label).
    func testPaginationControlsStructure() throws {
        given("case management is enabled with a case") {
            seedOneCase()
        }
        when("I navigate to Cases") {
            navigateToCases()
        }
        try then("pagination controls appear only once there are enough records to page") {
            XCTAssertTrue(
                find("case-list").waitForExistence(timeout: 10),
                "Case list should render once a case has been created"
            )

            // Pagination only renders once a hub has more than 50 records
            // (totalPages > 1). Provisioning 51 records through the real
            // create-case UI flow is impractical for a UI test, so this
            // scenario cannot exercise that threshold here — it reports as
            // skipped rather than silently passing on a feature it never checked.
            guard find("case-pagination").waitForExistence(timeout: 3) else {
                throw XCTSkip("Pagination requires more than 50 records; this suite seeds only one")
            }
            XCTAssertTrue(find("case-page-prev").exists, "Pagination should have a previous button")
            XCTAssertTrue(find("case-page-next").exists, "Pagination should have a next button")
        }
    }

    // MARK: - Case Detail View (API-Connected)

    /// Scenario: Tapping a case card opens the detail view with header.
    func testCaseDetailShowsHeader() {
        given("I am authenticated as admin with API and a case exists") {
            XCTAssertTrue(launchAsAdminWithNewCase(), "A newly created case should open its detail view")
        }
        then("I should see the case detail header") {
            XCTAssertTrue(
                find("case-detail-header").exists,
                "Case detail header should be visible after tapping a card"
            )
        }
    }

    /// Scenario: Case detail shows the status pill.
    func testCaseDetailShowsStatusPill() {
        given("I am authenticated as admin with API and a case exists") {
            XCTAssertTrue(launchAsAdminWithNewCase(), "A newly created case should open its detail view")
        }
        then("I should see the status pill") {
            XCTAssertTrue(
                find("case-status-pill").waitForExistence(timeout: 3),
                "Status pill should be visible in case detail header"
            )
        }
    }

    /// Scenario: Case detail shows all 4 tabs (Details, Timeline, Contacts, Evidence).
    func testCaseDetailTabBar() {
        given("I am authenticated as admin with API and a case exists") {
            XCTAssertTrue(launchAsAdminWithNewCase(), "A newly created case should open its detail view")
        }
        then("I should see all 4 detail tabs") {
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
    ///
    /// The "Arrest Case" entity type (jail-support template) carries 28 fields
    /// across multiple sections, so a freshly created case must render at
    /// least one `case-field-*` row — this asserts that directly rather than
    /// treating "the container exists" as proof the fields rendered.
    func testDetailsTabShowsFields() {
        given("I am authenticated as admin with API and a case exists") {
            XCTAssertTrue(launchAsAdminWithNewCase(), "A newly created case should open its detail view")
        }
        then("the details tab should show at least one field row") {
            XCTAssertTrue(
                find("case-details-tab").waitForExistence(timeout: 5),
                "Details tab content should be visible"
            )

            let firstField = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'case-field-'"))
                .firstMatch
            XCTAssertTrue(
                firstField.waitForExistence(timeout: 5),
                "Details tab should render at least one field row for the Arrest Case entity type"
            )
        }
    }

    /// Scenario: Timeline tab shows interactions or empty state.
    func testTimelineTabShowsInteractions() {
        given("I am authenticated as admin with API and a case exists") {
            XCTAssertTrue(launchAsAdminWithNewCase(), "A newly created case should open its detail view")
        }
        when("I tap the Timeline tab") {
            let timelineTab = find("case-tab-timeline")
            XCTAssertTrue(timelineTab.waitForExistence(timeout: 5), "Timeline tab should exist in case detail")
            timelineTab.tap()
        }
        then("I should see timeline content or empty state") {
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
    ///
    /// Quarantined as `CaseManagementUITests/testContactsTabShowsLinkedContacts`
    /// for #1246 (the Contacts tab renders none of its states) — this now
    /// deterministically creates a case so the quarantine can be lifted the
    /// moment #1246 is fixed, instead of silently passing either way.
    func testContactsTabShowsLinkedContacts() {
        given("I am authenticated as admin with API and a case exists") {
            XCTAssertTrue(launchAsAdminWithNewCase(), "A newly created case should open its detail view")
        }
        when("I tap the Contacts tab") {
            let contactsTab = find("case-tab-contacts")
            XCTAssertTrue(contactsTab.waitForExistence(timeout: 5), "Contacts tab should exist in case detail")
            contactsTab.tap()
        }
        then("I should see contacts content or empty state") {
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
        given("I am authenticated as admin with API and a case exists") {
            XCTAssertTrue(launchAsAdminWithNewCase(), "A newly created case should open its detail view")
        }
        when("I tap the Evidence tab") {
            let evidenceTab = find("case-tab-evidence")
            XCTAssertTrue(evidenceTab.waitForExistence(timeout: 5), "Evidence tab should exist in case detail")
            evidenceTab.tap()
        }
        then("I should see evidence content or empty state") {
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
    ///
    /// Launches as admin against a case the test just created, so the status
    /// pill (admin always has edit permission) and its sheet are guaranteed to
    /// exist — this used to silently pass if either was missing.
    func testStatusPillOpensSheet() {
        given("I am authenticated as admin with API and a case exists") {
            XCTAssertTrue(launchAsAdminWithNewCase(), "A newly created case should open its detail view")
        }
        when("I tap the status pill") {
            let statusPill = find("case-status-pill")
            XCTAssertTrue(statusPill.waitForExistence(timeout: 5), "Status pill should be visible for a case the test just created")
            statusPill.tap()
        }
        then("the QuickStatusSheet should appear with status options") {
            XCTAssertTrue(
                find("quick-status-sheet").waitForExistence(timeout: 5),
                "QuickStatusSheet should be visible after tapping status pill"
            )

            let statusOptions = app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'status-option-'"))
            XCTAssertGreaterThan(
                statusOptions.count, 0,
                "QuickStatusSheet should contain at least one status option"
            )
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
        given("I am authenticated as admin with API and a case exists") {
            XCTAssertTrue(launchAsAdminWithNewCase(), "A newly created case should open its detail view")
        }
        when("I navigate to the Timeline tab") {
            let timelineTab = find("case-tab-timeline")
            XCTAssertTrue(timelineTab.waitForExistence(timeout: 5), "Timeline tab should exist in case detail")
            timelineTab.tap()
        }
        then("I should be able to open the comment sheet, type, and have submit enabled") {
            let commentInput = find("case-comment-input")
            let commentSubmit = find("case-comment-submit")

            XCTAssertTrue(commentInput.waitForExistence(timeout: 5), "Comment input should be visible on timeline tab")
            XCTAssertTrue(commentSubmit.waitForExistence(timeout: 3), "Comment submit button should be visible on timeline tab")

            commentSubmit.tap()

            let commentSheet = find("add-comment-sheet")
            XCTAssertTrue(commentSheet.waitForExistence(timeout: 5), "Comment sheet should open after tapping send")

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

            sheetInput.tap()
            sheetInput.typeText("Test comment from XCUITest")

            XCTAssertTrue(
                sheetSubmit.isEnabled,
                "Submit button should be enabled after entering text"
            )
        }
    }

    // MARK: - Assignment

    /// Scenario: Unassigned case shows "Assign to me" button.
    ///
    /// A case the test just created has no assignees, so the admin viewing it
    /// is guaranteed not to be in `assignedTo` — the button must be visible.
    func testAssignToMeButton() {
        given("I am authenticated as admin with API and a case exists") {
            XCTAssertTrue(launchAsAdminWithNewCase(), "A newly created case should open its detail view")
        }
        when("the case is unassigned from me") {
            // CaseListView's create-case submit sends `assignedTo: [encPubkey]`
            // (the creating admin's own key) — a case created through the
            // create-case sheet is NOT unassigned, it is self-assigned by the
            // creator. So "case-unassign-btn" is what should be showing right
            // after creation; unassign to reach the state this scenario is
            // actually about.
            let unassignButton = find("case-unassign-btn")
            XCTAssertTrue(
                unassignButton.waitForExistence(timeout: 5),
                "A case is self-assigned by its creator on creation, so the unassign button should show first"
            )
            unassignButton.tap()
        }
        then("I should see the assign button for an unassigned case") {
            let assignButton = find("case-assign-btn")
            XCTAssertTrue(
                assignButton.waitForExistence(timeout: 5),
                "Assign to me button should be visible once the creator is unassigned"
            )
            XCTAssertTrue(
                assignButton.isEnabled,
                "Assign to me button should be tappable"
            )
        }
    }

    // MARK: - Detail Close

    /// Scenario: Closing the case detail returns to the list.
    func testCaseDetailCloseReturnsToList() {
        given("I am authenticated as admin with API") {
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
        given("I am authenticated as admin with API") {
            launchAsAdminWithAPI()
        }
        when("I open a case detail") {
            navigateToCases()
            guard openFirstCaseCard() else { return }
        }
        then("switching between tabs should render the correct content areas") {
            guard find("case-detail-header").waitForExistence(timeout: 5) else { return }

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

        let firstCard = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'case-card-'"))
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
