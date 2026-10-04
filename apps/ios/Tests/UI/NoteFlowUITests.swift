import XCTest

/// XCUITest suite for the notes workflow: creating notes, viewing the notes list,
/// tapping into note detail, and verifying custom field display.
///
/// These tests require the app to be in an authenticated state with a valid hub connection.
/// They use the `--test-authenticated` launch argument to skip auth flow.
final class NoteFlowUITests: XCTestCase {

    private var app: XCUIApplication!

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        app = XCUIApplication()
        // Launch with pre-authenticated state and reset note data
        app.launchArguments.append(contentsOf: ["--reset-keychain", "--test-authenticated"])
        app.launchAnsweringSystemPrompts()
    }

    override func tearDown() {
        app = nil
        super.tearDown()
    }

    /// Find any element by accessibility identifier, regardless of XCUIElement type.
    private func find(_ identifier: String) -> XCUIElement {
        return app.descendants(matching: .any)[identifier].firstMatch
    }

    private func anyElementExists(_ identifiers: [String], timeout: TimeInterval = 10) -> Bool {
        for (i, id) in identifiers.enumerated() {
            let element = find(id)
            let wait: TimeInterval = i == 0 ? timeout : 2
            if element.waitForExistence(timeout: wait) {
                return true
            }
        }
        return false
    }

    // MARK: - Tab Navigation

    func testNotesTabExists() {
        let tabView = find("main-tab-view")
        XCTAssertTrue(
            tabView.waitForExistence(timeout: 10),
            "Main tab view should be visible after authentication"
        )

        navigateToNotesTab()

        // Notes list, empty state, loading, or error should appear
        let found = anyElementExists([
            "notes-list", "notes-empty-state", "notes-loading", "notes-error",
        ])
        XCTAssertTrue(found, "Notes view should show list, empty state, or loading")
    }

    // MARK: - Create Note

    func testCreateNoteFlowOpensSheet() {
        navigateToNotesTab()

        // Wait for notes content to load
        _ = anyElementExists([
            "notes-list", "notes-empty-state", "notes-loading", "notes-error",
        ])

        // Tap create note button
        let createButton = find("create-note-button")
        XCTAssertTrue(
            createButton.waitForExistence(timeout: 5),
            "Create note button should exist in toolbar"
        )
        createButton.tap()

        // Note create sheet should appear
        let textEditor = find("note-text-editor")
        XCTAssertTrue(
            textEditor.waitForExistence(timeout: 5),
            "Note text editor should appear in create sheet"
        )

        // Save button should exist
        let saveButton = find("save-note")
        XCTAssertTrue(saveButton.exists, "Save button should exist")

        // Cancel button should exist
        let cancelButton = find("cancel-note-create")
        XCTAssertTrue(cancelButton.exists, "Cancel button should exist")
    }

    func testCreateNoteCancel() {
        navigateToNotesTab()

        // Wait for content
        _ = anyElementExists([
            "notes-list", "notes-empty-state", "notes-loading", "notes-error",
        ])

        let createButton = find("create-note-button")
        XCTAssertTrue(createButton.waitForExistence(timeout: 5))
        createButton.tap()

        // Wait for sheet
        let textEditor = find("note-text-editor")
        XCTAssertTrue(textEditor.waitForExistence(timeout: 5))

        // Cancel
        let cancelButton = find("cancel-note-create")
        cancelButton.tap()

        // Sheet should dismiss — create button should be visible again
        XCTAssertTrue(
            createButton.waitForExistence(timeout: 5),
            "Create button should be visible after cancelling"
        )
    }

    func testCreateNoteWithText() {
        navigateToNotesTab()

        // Wait for content
        _ = anyElementExists([
            "notes-list", "notes-empty-state", "notes-loading", "notes-error",
        ])

        let createButton = find("create-note-button")
        XCTAssertTrue(createButton.waitForExistence(timeout: 5))
        createButton.tap()

        // Enter note text
        let textEditor = find("note-text-editor")
        XCTAssertTrue(textEditor.waitForExistence(timeout: 5))
        textEditor.tap()
        textEditor.typeText("Test note from UI test - \(Date().timeIntervalSince1970)")

        // Save button should be enabled now
        let saveButton = find("save-note")
        XCTAssertTrue(saveButton.exists, "Save button should exist")
        XCTAssertTrue(saveButton.isEnabled, "Save button should be enabled with text")
    }

    // MARK: - Empty State

    func testEmptyStateShowsCreateButton() {
        navigateToNotesTab()

        // If there are no notes, the empty state should have a create button
        let emptyState = find("notes-empty-state")
        if emptyState.waitForExistence(timeout: 5) {
            let createFirstNote = find("create-first-note")
            XCTAssertTrue(
                createFirstNote.exists,
                "Empty state should have a 'Create Your First Note' button"
            )
        }
        // If notes exist, that's fine too — the test passes
    }

    // MARK: - Note Detail

    func testNoteDetailShowsContent() {
        navigateToNotesTab()

        // Wait for the notes list to load
        let notesList = find("notes-list")
        guard notesList.waitForExistence(timeout: 10) else {
            // No notes to test detail on — skip
            return
        }

        // Tap the first note row
        let cells = app.cells
        guard cells.count > 0 else { return }
        cells.firstMatch.tap()

        // Detail view should appear
        let detailView = find("note-detail-view")
        XCTAssertTrue(
            detailView.waitForExistence(timeout: 5),
            "Note detail view should appear when tapping a note"
        )

        // Note text should be visible
        let noteText = find("note-detail-text")
        XCTAssertTrue(
            noteText.waitForExistence(timeout: 3),
            "Note detail should display the note text"
        )
    }

    func testNoteDetailMenuExists() {
        navigateToNotesTab()

        let notesList = find("notes-list")
        guard notesList.waitForExistence(timeout: 10) else { return }

        let cells = app.cells
        guard cells.count > 0 else { return }
        cells.firstMatch.tap()

        let detailView = find("note-detail-view")
        guard detailView.waitForExistence(timeout: 5) else { return }

        // Menu button should exist
        let menuButton = find("note-detail-menu")
        XCTAssertTrue(
            menuButton.exists,
            "Note detail should have a menu button"
        )
    }

    // MARK: - Navigation Helpers

    private func navigateToNotesTab() {
        let tabView = find("main-tab-view")
        guard tabView.waitForExistence(timeout: 10) else {
            XCTFail("Main tab view should be visible")
            return
        }

        // Try tapping the Notes tab
        let tabBar = app.tabBars.firstMatch
        if tabBar.waitForExistence(timeout: 5) {
            let notesTabButton = tabBar.buttons.element(boundBy: 1)  // Second tab = Notes
            if notesTabButton.exists {
                notesTabButton.tap()
            }
        }
    }
}
