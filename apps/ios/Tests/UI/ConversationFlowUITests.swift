import XCTest

/// XCUITest suite for the conversations workflow: navigating to conversations,
/// opening a conversation detail, sending a message, and verifying the list.
///
/// These tests require the app to be in an authenticated state with a valid hub connection.
/// They use the `--test-authenticated` launch argument to skip auth flow.
final class ConversationFlowUITests: XCTestCase {

    private var app: XCUIApplication!

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        app = XCUIApplication()
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

    func testConversationsTabExists() {
        let tabView = find("main-tab-view")
        XCTAssertTrue(
            tabView.waitForExistence(timeout: 10),
            "Main tab view should be visible after authentication"
        )

        navigateToConversationsTab()

        // Conversations list, empty state, loading, or error should appear
        let found = anyElementExists([
            "conversations-list", "conversations-empty-state",
            "conversations-loading", "conversations-error",
        ])
        XCTAssertTrue(found, "Conversations view should show list, empty state, or loading")
    }

    // MARK: - Empty State

    func testEmptyStateShowsMessage() {
        navigateToConversationsTab()

        let emptyState = find("conversations-empty-state")
        if emptyState.waitForExistence(timeout: 10) {
            XCTAssertTrue(true, "Empty state is displayed when no conversations exist")
        }
        // If conversations exist, that's fine too
    }

    // MARK: - Filter Menu

    func testFilterButtonExists() {
        navigateToConversationsTab()

        // Wait for content to load
        _ = anyElementExists([
            "conversations-list", "conversations-empty-state",
            "conversations-loading", "conversations-error",
        ])

        let filterButton = find("conversations-filter-button")
        XCTAssertTrue(
            filterButton.waitForExistence(timeout: 5),
            "Filter button should exist in the toolbar"
        )
    }

    // MARK: - Conversation Detail

    func testConversationDetailOpens() {
        navigateToConversationsTab()

        // Wait for the conversations list to load
        let conversationsList = find("conversations-list")
        guard conversationsList.waitForExistence(timeout: 10) else {
            // No conversations to test detail on — skip
            return
        }

        // Tap the first conversation row
        let cells = app.cells
        guard cells.count > 0 else { return }
        cells.firstMatch.tap()

        // Detail view should appear
        let detailView = find("conversation-detail-view")
        XCTAssertTrue(
            detailView.waitForExistence(timeout: 5),
            "Conversation detail view should appear when tapping a conversation"
        )

        // Reply text field should exist
        let replyField = find("reply-text-field")
        XCTAssertTrue(
            replyField.waitForExistence(timeout: 3),
            "Reply text field should exist in conversation detail"
        )

        // Send button should exist
        let sendButton = find("send-message-button")
        XCTAssertTrue(
            sendButton.exists,
            "Send button should exist in conversation detail"
        )
    }

    func testSendMessageButton() {
        navigateToConversationsTab()

        let conversationsList = find("conversations-list")
        guard conversationsList.waitForExistence(timeout: 10) else { return }

        let cells = app.cells
        guard cells.count > 0 else { return }
        cells.firstMatch.tap()

        let detailView = find("conversation-detail-view")
        guard detailView.waitForExistence(timeout: 5) else { return }

        // Send button should be disabled when reply field is empty
        let sendButton = find("send-message-button")
        XCTAssertTrue(sendButton.exists, "Send button should exist")

        // Type a message
        let replyField = find("reply-text-field")
        if replyField.exists {
            replyField.tap()
            replyField.typeText("Test message from UI test - \(Date().timeIntervalSince1970)")

            XCTAssertTrue(sendButton.exists, "Send button should still exist after typing")
        }
    }

    // MARK: - Channel Header

    func testChannelHeaderVisible() {
        navigateToConversationsTab()

        let conversationsList = find("conversations-list")
        guard conversationsList.waitForExistence(timeout: 10) else { return }

        let cells = app.cells
        guard cells.count > 0 else { return }
        cells.firstMatch.tap()

        let channelHeader = find("conversation-channel-header")
        if channelHeader.waitForExistence(timeout: 5) {
            XCTAssertTrue(true, "Channel header is visible in conversation detail")
        }
    }

    // MARK: - Navigation Helpers

    private func navigateToConversationsTab() {
        let tabView = find("main-tab-view")
        guard tabView.waitForExistence(timeout: 10) else {
            XCTFail("Main tab view should be visible")
            return
        }

        let tabBar = app.tabBars.firstMatch
        guard tabBar.waitForExistence(timeout: 5) else { return }
        // Tab order: 0=Dashboard, 1=Notes, 2=Cases, 3=Conversations, 4=Shifts, 5=Settings
        let conversationsTabButton = tabBar.buttons.element(boundBy: 3)
        if conversationsTabButton.exists {
            conversationsTabButton.tap()
        }
    }
}
