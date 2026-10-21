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

    /// Scenario: Navigating to Cases without an API connection says the load failed.
    /// With no hub configured the CMS request cannot be made at all. That is a failure,
    /// and the screen must say so with a way to retry — it used to render the same
    /// "case management is not enabled" state a hub answers with, so a broken
    /// connection and a deliberately disabled feature looked identical (#1918).
    func testCaseListShowsInitialState() {
        given("I am authenticated without an API connection") {
            launchAuthenticated()
        }
        when("I navigate to the Cases tab") {
            navigateToCases()
        }
        then("I should see that the cases could not be loaded") {
            XCTAssertEqual(
                waitForCasesScreenToSettle(), "case-load-error",
                "Cases view should settle on its load error when no hub is reachable"
            )
            XCTAssertTrue(find("case-load-retry").exists, "A failed load should offer a retry")
            XCTAssertFalse(find("cms-not-enabled").exists, "A failed request is not 'case management is off'")
            XCTAssertFalse(find("case-loading").exists, "Cases view should not still be loading")
            XCTAssertFalse(find("case-list").exists, "There is no case list without a hub")
            XCTAssertFalse(
                app.buttons["case-new-btn"].isEnabled,
                "New Case cannot be offered when case management state is unknown"
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

    /// The states the Cases screen settles on once it knows what it can show. While
    /// `case-loading` is up it has not decided; each of these is a decision.
    private static let casesSettledStates = ["case-list", "case-empty-state", "cms-not-enabled", "case-load-error"]

    /// Wait until the Cases screen leaves its loading state and return the identifier of
    /// the state it settled on, or nil if it never settled. One query over all of them,
    /// so no state is given a shorter wait than another.
    private func waitForCasesScreenToSettle(timeout: TimeInterval = 15) -> String? {
        let settled = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier IN %@", Self.casesSettledStates)
        ).firstMatch
        guard settled.waitForExistence(timeout: timeout) else { return nil }
        return Self.casesSettledStates.first { find($0).exists }
    }

    /// Wait for the Cases screen to be ready for a new case, failing with what it showed
    /// instead: still loading, case management off, or the load error and its message.
    private func waitForCasesReady(file: StaticString = #filePath, line: UInt = #line) {
        let state = waitForCasesScreenToSettle()
        switch state {
        case "case-list", "case-empty-state":
            break
        case "case-load-error":
            let shown = find("case-load-error").staticTexts.allElementsBoundByIndex.map(\.label)
            XCTFail("Cases failed to load: \(shown.joined(separator: " — "))", file: file, line: line)
        case "cms-not-enabled":
            XCTFail("Case management should be on for this hub", file: file, line: line)
        default:
            XCTFail("Cases screen was still loading after 15s", file: file, line: line)
        }
    }

    /// Create a case through the create-case sheet and wait for the sheet to close.
    private func createCase(title: String, entityTypeName: String) {
        // `case-new-btn` is a toolbar Button — query the button itself, not its
        // container. It exists from the first toolbar resolution and is disabled until
        // the screen is ready, which the content area signals: wait for that, then New
        // Case must already be offered. Its readiness and the content's come from one
        // model update, so a button still disabled here is a defect, not slowness.
        waitForCasesReady()
        let newCase = app.buttons["case-new-btn"]
        XCTAssertTrue(newCase.exists, "New Case should be present in the Cases toolbar")
        XCTAssertTrue(newCase.isEnabled, "New Case should be offered once the Cases screen is ready")
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
        // `typeText` returns once the key events are synthesized, not once the field has
        // consumed them, and a tap on Create reads the field as it is at that instant. A
        // run that submitted while only "Seeded ca" of "Seeded case 3632D769" had arrived
        // created a case no title lookup could ever find (#2050's merge group). So wait on
        // what the field holds — it either reaches the full title or fails here, naming
        // what it did hold, instead of surfacing as a missing row 30 seconds later.
        let titleTyped = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %@", title),
            object: titleInput
        )
        XCTAssertEqual(
            XCTWaiter.wait(for: [titleTyped], timeout: 10),
            .completed,
            "The title field should hold '\(title)' before Create, but holds '\(titleInput.value as? String ?? "nil")'"
        )

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

    /// Scenario: A list that fits on one page has no pagination bar.
    ///
    /// The bar appears only past one page (more than 50 records), which a UI test cannot
    /// seed through the app's E2EE create sheet; what it can pin down is the other half
    /// of the rule — one case, one page, no bar to page with.
    func testPaginationControlsStructure() {
        var title = ""
        given("case management is on and a single case exists") {
            title = launchWithSeededCase()
        }
        when("I navigate to Cases") {
            navigateToCases()
        }
        then("the case is listed and there is no pagination bar") {
            XCTAssertTrue(
                caseTitle(title).waitForExistence(timeout: 15),
                "The case '\(title)' should be listed"
            )
            XCTAssertFalse(
                find("case-pagination").exists,
                "A single page of results should not offer paging"
            )
        }
    }

    // MARK: - Case Detail View (API-Connected)

    /// Scenario: Tapping a case card opens the detail view with header.
    func testCaseDetailShowsHeader() {
        var title = ""
        given("case management is on and a case exists") {
            title = launchWithSeededCase()
        }
        when("I tap the case in the list") {
            openCase(titled: title)
        }
        then("the header names that case") {
            let headerTitle = find("case-detail-title")
            XCTAssertTrue(headerTitle.waitForExistence(timeout: 10), "The header should show the decrypted title")
            XCTAssertEqual(headerTitle.label, title, "The header should show the title of the case that was tapped")
        }
    }

    /// Scenario: Case detail shows the status pill with the case's status.
    func testCaseDetailShowsStatusPill() {
        var title = ""
        given("a newly created arrest case") {
            title = launchWithSeededCase()
        }
        when("I open the case") {
            openCase(titled: title)
        }
        then("the status pill shows the type's first status") {
            let statusPill = find("case-status-pill")
            XCTAssertTrue(statusPill.waitForExistence(timeout: 5), "Status pill should be visible in case detail header")
            XCTAssertTrue(
                statusPill.label.contains("Reported"),
                "A new arrest case starts as Reported (jail-support template); the pill reads '\(statusPill.label)'"
            )
        }
    }

    /// Scenario: Case detail opens on the Details tab, with all 4 tabs offered.
    ///
    /// The tab buttons do not expose which one is selected (#2032), so "opens on Details" is
    /// asserted by the content on screen: the Details body is shown and no other tab's is.
    func testCaseDetailTabBar() {
        var title = ""
        given("a case exists") {
            title = launchWithSeededCase()
        }
        when("I open the case") {
            openCase(titled: title)
        }
        then("it opens on Details, and Timeline, Contacts and Evidence are offered but not showing") {
            XCTAssertTrue(
                find("case-details-tab").waitForExistence(timeout: 10),
                "A case should open on its Details tab"
            )
            for name in ["details", "timeline", "contacts", "evidence"] {
                XCTAssertTrue(find("case-tab-\(name)").exists, "\(name) tab should exist in case detail")
            }
            for body in ["case-timeline-tab", "case-contacts-tab", "case-evidence-tab"] {
                XCTAssertFalse(find(body).exists, "\(body) should not be showing on the Details tab")
            }
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
        var title = ""
        given("a case exists") {
            title = launchWithSeededCase()
            openCase(titled: title)
        }
        when("I tap the status pill") {
            let statusPill = find("case-status-pill")
            XCTAssertTrue(statusPill.waitForExistence(timeout: 5), "Status pill should be visible")
            statusPill.tap()
        }
        then("the sheet offers every status of the case's type") {
            XCTAssertTrue(
                find("quick-status-sheet").waitForExistence(timeout: 5),
                "QuickStatusSheet should be visible after tapping status pill"
            )
            // arrest_case in the jail-support template.
            for status in ["reported", "confirmed", "in_custody", "arraigned", "released", "case_closed"] {
                XCTAssertTrue(
                    app.buttons["status-option-\(status)"].exists,
                    "The sheet should offer the '\(status)' status"
                )
            }
        }
    }

    /// Scenario: Selecting a new status updates the pill — and the server keeps it.
    func testSelectNewStatus() {
        var title = ""
        given("a case that is Reported") {
            title = launchWithSeededCase()
            openCase(titled: title)
            XCTAssertTrue(find("case-status-pill").label.contains("Reported"))
        }
        when("I choose In Custody in the status sheet") {
            find("case-status-pill").tap()
            let option = app.buttons["status-option-in_custody"]
            XCTAssertTrue(option.waitForExistence(timeout: 5), "The sheet should offer In Custody")
            option.tap()
            XCTAssertTrue(
                find("quick-status-sheet").waitForNonExistence(timeout: 10),
                "The sheet should dismiss once a status is chosen"
            )
        }
        then("the pill reads In Custody, and still does after reopening the case from the server") {
            let pill = find("case-status-pill")
            let updated = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "label CONTAINS 'In Custody'"), object: pill
            )
            XCTAssertEqual(XCTWaiter.wait(for: [updated], timeout: 10), .completed,
                           "The status pill should now read In Custody (reads '\(pill.label)')")

            find("case-detail-close").tap()
            openCase(titled: title)
            XCTAssertTrue(
                find("case-status-pill").label.contains("In Custody"),
                "The new status should have been saved: the reopened case reads '\(find("case-status-pill").label)'"
            )
        }
    }

    /// Scenario: Changing a case's status keeps who it is assigned to.
    func testStatusChangeKeepsAssignment() {
        var title = ""
        given("a case that is assigned to me") {
            title = launchWithSeededCase()
            openCase(titled: title)
            XCTAssertTrue(
                find("case-unassign-btn").waitForExistence(timeout: 10),
                "The creator of a case is assigned to it"
            )
        }
        when("I change its status") {
            find("case-status-pill").tap()
            let option = app.buttons["status-option-confirmed"]
            XCTAssertTrue(option.waitForExistence(timeout: 5))
            option.tap()
            XCTAssertTrue(find("quick-status-sheet").waitForNonExistence(timeout: 10))
        }
        then("I am still assigned") {
            let updated = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "label CONTAINS 'Confirmed'"), object: find("case-status-pill")
            )
            XCTAssertEqual(XCTWaiter.wait(for: [updated], timeout: 10), .completed, "The status should have changed")
            XCTAssertTrue(find("case-unassign-btn").exists, "A status change must not clear the assignee (#1643)")
            XCTAssertFalse(find("case-assign-btn").exists)
        }
    }

    // MARK: - Comments

    /// Scenario: Full add comment flow — type in the sheet, submit, and see the comment.
    func testAddCommentFlow() {
        var title = ""
        let comment = "Comment \(UUID().uuidString.prefix(8))"
        given("a case exists") {
            title = launchWithSeededCase()
            openCase(titled: title)
        }
        when("I open the comment sheet from the timeline, write a comment and submit") {
            let timelineTab = find("case-tab-timeline")
            XCTAssertTrue(timelineTab.waitForExistence(timeout: 5))
            timelineTab.tap()

            let expand = find("case-comment-expand")
            XCTAssertTrue(expand.waitForExistence(timeout: 10), "The timeline should offer the full comment sheet")
            expand.tap()

            XCTAssertTrue(find("add-comment-sheet").waitForExistence(timeout: 5), "The comment sheet should open")
            let sheetInput = find("comment-input")
            XCTAssertTrue(sheetInput.waitForExistence(timeout: 3))
            sheetInput.tap()
            sheetInput.typeText(comment)
            let submit = find("comment-submit")
            XCTAssertTrue(submit.isEnabled, "Submit should be enabled once there is text")
            submit.tap()
        }
        then("the comment appears in the case timeline") {
            XCTAssertTrue(
                find("add-comment-sheet").waitForNonExistence(timeout: 15),
                "The sheet should close once the comment is saved"
            )
            let posted = find("case-timeline").staticTexts.matching(
                NSPredicate(format: "label CONTAINS %@", comment)
            ).firstMatch
            XCTAssertTrue(
                posted.waitForExistence(timeout: 15),
                "The saved comment should read back, decrypted, in the timeline"
            )
        }
    }

    // MARK: - Assignment

    /// Scenario: Unassign and "Assign to me" round-trip through the server.
    /// The creator of a case is assigned to it, so the case opens offering Unassign.
    func testAssignToMeButton() {
        var title = ""
        given("a case I created, which is assigned to me") {
            title = launchWithSeededCase()
            openCase(titled: title)
            XCTAssertTrue(
                find("case-unassign-btn").waitForExistence(timeout: 10),
                "The creator of a case is assigned to it"
            )
        }
        when("I unassign myself") {
            find("case-unassign-btn").tap()
        }
        then("the case offers Assign to me, and assigning again offers Unassign") {
            let assignButton = find("case-assign-btn")
            XCTAssertTrue(assignButton.waitForExistence(timeout: 10), "An unassigned case should offer Assign to me")
            XCTAssertFalse(find("case-unassign-btn").exists)
            XCTAssertTrue(assignButton.isEnabled, "Assign to me should be tappable")
            assignButton.tap()
            XCTAssertTrue(
                find("case-unassign-btn").waitForExistence(timeout: 10),
                "After assigning, the case should offer Unassign"
            )
            XCTAssertFalse(find("case-assign-btn").exists, "An assigned case no longer offers Assign to me")
        }
    }

    // MARK: - Detail Close

    /// Scenario: Closing the case detail returns to the list, with the case still in it.
    func testCaseDetailCloseReturnsToList() {
        var title = ""
        given("case management is on and I have a case open") {
            title = launchWithSeededCase()
            openCase(titled: title)
        }
        when("I tap the close button") {
            let closeButton = find("case-detail-close")
            XCTAssertTrue(closeButton.waitForExistence(timeout: 5), "The detail should offer a close button")
            closeButton.tap()
        }
        then("I am back on the case list, which still shows the case") {
            XCTAssertTrue(
                find("case-detail-header").waitForNonExistence(timeout: 10),
                "The detail should be gone after closing it"
            )
            XCTAssertTrue(caseTitle(title).waitForExistence(timeout: 10), "The list should still show '\(title)'")
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

    /// Scenario: Cancelling the QuickStatusSheet dismisses it without changing the status.
    func testQuickStatusSheetCancel() {
        var title = ""
        given("a case that is Reported") {
            title = launchWithSeededCase()
            openCase(titled: title)
            XCTAssertTrue(find("case-status-pill").label.contains("Reported"))
        }
        when("I open the status sheet and cancel") {
            find("case-status-pill").tap()
            let sheet = find("quick-status-sheet")
            XCTAssertTrue(sheet.waitForExistence(timeout: 5), "The status sheet should open")
            let cancelButton = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Cancel'")).firstMatch
            XCTAssertTrue(cancelButton.waitForExistence(timeout: 3), "The sheet should offer Cancel")
            cancelButton.tap()
        }
        then("the sheet is gone and the status is unchanged") {
            XCTAssertTrue(
                find("quick-status-sheet").waitForNonExistence(timeout: 5),
                "QuickStatusSheet should dismiss after tapping Cancel"
            )
            XCTAssertTrue(
                find("case-status-pill").label.contains("Reported"),
                "Cancelling must not change the status (reads '\(find("case-status-pill").label)')"
            )
        }
    }

    // MARK: - Helpers

}
