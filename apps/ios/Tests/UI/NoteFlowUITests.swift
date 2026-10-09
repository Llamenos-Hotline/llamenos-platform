import XCTest

/// XCUITest suite for the notes workflow: creating notes, viewing the notes list,
/// tapping into note detail, and verifying custom field display.
///
/// The create-sheet scenarios run pre-authenticated without a backend
/// (`launchAuthenticated`). The note-detail scenarios need a note to open, so they
/// connect to the live backend and create one through the app's own create sheet —
/// a fresh class hub holds no notes, and a detail test that opened "whatever is
/// there" used to pass without asserting anything.
final class NoteFlowUITests: BaseUITest {

    // MARK: - Tab Navigation

    func testNotesTabExists() {
        launchAuthenticated()

        let tabView = find("main-tab-view")
        XCTAssertTrue(
            tabView.waitForExistence(timeout: 10),
            "Main tab view should be visible after authentication"
        )

        navigateToNotes()

        // Notes list, empty state, loading, or error should appear
        let found = anyElementExists([
            "notes-list", "notes-empty-state", "notes-loading", "notes-error",
        ])
        XCTAssertTrue(found, "Notes view should show list, empty state, or loading")
    }

    // MARK: - Create Note

    func testCreateNoteFlowOpensSheet() {
        launchAuthenticated()

        navigateToNotes()

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
        launchAuthenticated()

        navigateToNotes()

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
        launchAuthenticated()

        navigateToNotes()

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

        // A note belongs to a call: the server rejects one with neither a call nor a
        // conversation (createNoteBodySchema), so text alone must not enable Save.
        let saveButton = find("save-note")
        XCTAssertTrue(saveButton.exists, "Save button should exist")
        XCTAssertFalse(saveButton.isEnabled, "Save button should stay disabled until a call is entered")

        let callIdField = scrollToVisible("note-call-id-input")
        XCTAssertTrue(callIdField.isHittable, "Call ID field should be reachable in the create sheet")
        callIdField.tap()
        callIdField.typeText("call-ui-test")
        XCTAssertTrue(saveButton.isEnabled, "Save button should be enabled with text and a call ID")
    }

    // MARK: - Empty State

    func testEmptyStateShowsCreateButton() {
        launchAuthenticated()

        navigateToNotes()

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
        launchWithAPI()
        let noteText = uniqueNoteText()
        createNote(text: noteText)

        openNote(containing: noteText)

        // The detail shows the text decrypted from what the server stored.
        let noteTextElement = find("note-detail-text")
        XCTAssertTrue(
            noteTextElement.waitForExistence(timeout: 3),
            "Note detail should display the note text"
        )
        XCTAssertEqual(
            noteTextElement.label, noteText,
            "The saved note should read back from the server with the text that was typed"
        )
    }

    func testNoteDetailMenuExists() {
        launchWithAPI()
        let noteText = uniqueNoteText()
        createNote(text: noteText)

        openNote(containing: noteText)

        // Menu button should exist
        let menuButton = find("note-detail-menu")
        XCTAssertTrue(
            menuButton.exists,
            "Note detail should have a menu button"
        )
    }

    // MARK: - Fixtures

    private func uniqueNoteText() -> String {
        "UI test note \(UUID().uuidString.prefix(8))"
    }

    /// Create a note through the Notes tab's create sheet (client-side E2EE included)
    /// and wait for the sheet to close. The server stores it against a call ID; it
    /// does not require that call to exist.
    private func createNote(text: String) {
        navigateToNotes()
        let createButton = find("create-note-button")
        XCTAssertTrue(createButton.waitForExistence(timeout: 10), "Create note button should exist in the Notes toolbar")
        createButton.tap()

        let textEditor = find("note-text-editor")
        XCTAssertTrue(textEditor.waitForExistence(timeout: 5), "Note text editor should appear in the create sheet")
        textEditor.tap()
        textEditor.typeText(text)

        let callIdField = scrollToVisible("note-call-id-input")
        XCTAssertTrue(callIdField.isHittable, "Call ID field should be reachable in the create sheet")
        callIdField.tap()
        callIdField.typeText("call-\(UUID().uuidString.prefix(8))")

        find("save-note").tap()
        XCTAssertTrue(textEditor.waitForNonExistence(timeout: 20), "The create sheet should close once the note is saved")
        XCTAssertFalse(find("note-create-error").exists, "Saving the note should not report an error")
    }

    /// Tap the notes-list row showing `text` and wait for the note detail.
    private func openNote(containing text: String) {
        let row = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        XCTAssertTrue(
            row.waitForExistence(timeout: 15),
            "The notes list should show the note created in this scenario ('\(text)')"
        )
        row.tap()

        XCTAssertTrue(
            find("note-detail-view").waitForExistence(timeout: 5),
            "Note detail view should appear when tapping a note"
        )
    }

}
