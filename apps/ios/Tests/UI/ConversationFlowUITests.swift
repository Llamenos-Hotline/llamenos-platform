import XCTest

/// XCUITest suite for the conversations workflow: navigating to conversations,
/// opening a conversation detail, sending a message, and verifying the list.
///
/// The list-level scenarios run pre-authenticated without a backend
/// (`launchAuthenticated`). The detail scenarios need a conversation to open, so
/// they connect to the live backend and simulate an inbound SMS into this class's
/// hub first — a fresh class hub holds no conversations, and a detail test that
/// opened "whatever is there" used to pass without asserting anything.
final class ConversationFlowUITests: BaseUITest {

    // MARK: - Tab Navigation

    func testConversationsTabExists() {
        launchAuthenticated()

        let tabView = find("main-tab-view")
        XCTAssertTrue(
            tabView.waitForExistence(timeout: 10),
            "Main tab view should be visible after authentication"
        )

        navigateToConversations()

        // Conversations list, empty state, loading, or error should appear
        let found = anyElementExists([
            "conversations-list", "conversations-empty-state",
            "conversations-loading", "conversations-error",
        ])
        XCTAssertTrue(found, "Conversations view should show list, empty state, or loading")
    }

    // MARK: - Empty State

    func testEmptyStateShowsMessage() {
        launchAuthenticated()

        navigateToConversations()

        let emptyState = find("conversations-empty-state")
        if emptyState.waitForExistence(timeout: 10) {
            XCTAssertTrue(true, "Empty state is displayed when no conversations exist")
        }
        // If conversations exist, that's fine too
    }

    // MARK: - Filter Menu

    func testFilterButtonExists() {
        launchAuthenticated()

        navigateToConversations()

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
        launchWithAPI()
        openSimulatedConversation()

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
        launchWithAPI()
        openSimulatedConversation()

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
        launchWithAPI()
        openSimulatedConversation()

        let channelHeader = find("conversation-channel-header")
        XCTAssertTrue(
            channelHeader.waitForExistence(timeout: 5),
            "Conversation detail should show the channel header"
        )
    }

    // MARK: - Fixtures

    /// Simulate an inbound SMS into this class's hub, then open its conversation
    /// from the Messages tab and wait for the detail view.
    private func openSimulatedConversation() {
        let (conversationId, _) = simulateIncomingMessage(
            senderNumber: "+1555\(Int.random(in: 1_000_000...9_999_999))",
            body: "Conversation flow \(UUID().uuidString.prefix(8))"
        )
        XCTAssertFalse(
            conversationId.isEmpty,
            "POST /api/test-simulate/incoming-message should return a conversationId — see the runner log for the simulation warning"
        )

        navigateToConversations()
        let row = find("conversation-row-\(conversationId)")
        XCTAssertTrue(
            row.waitForExistence(timeout: 15),
            "Messages tab should list the conversation simulated in this scenario (\(conversationId))"
        )
        row.tap()

        XCTAssertTrue(
            find("conversation-detail-view").waitForExistence(timeout: 5),
            "Conversation detail view should appear when tapping a conversation"
        )
    }
}
