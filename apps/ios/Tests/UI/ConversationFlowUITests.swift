import XCTest

/// XCUITest suite for the conversations workflow: navigating to conversations,
/// opening a conversation detail, composing a message, and verifying the list.
///
/// Scenarios that need conversations connect to the live backend and create them
/// through the test simulation API (`simulateIncomingMessage`); the empty-state
/// scenario launches with no hub, where there can be none.
final class ConversationFlowUITests: BaseUITest {

    // MARK: - Helpers

    /// Connect to the backend, receive a message, and leave the app on the
    /// Conversations tab. Returns the new conversation's id.
    private func launchWithConversation(channel: String = "sms") -> String {
        launchWithAPI()
        let result = simulateIncomingMessage(
            senderNumber: "+1555\(Int.random(in: 1_000_000...9_999_999))",
            body: "Hello from the UI test \(UUID().uuidString.prefix(8))",
            channel: channel
        )
        XCTAssertFalse(result.conversationId.isEmpty, "The simulated message should create a conversation")
        navigateToConversations()
        return result.conversationId
    }

    /// Open the conversation's detail from the list.
    private func openConversation(_ conversationId: String) {
        let row = find("conversation-row-\(conversationId)")
        XCTAssertTrue(
            row.waitForExistence(timeout: 20),
            "Conversation \(conversationId) should be listed after its message was received"
        )
        row.tap()
        XCTAssertTrue(
            find("conversation-detail-view").waitForExistence(timeout: 10),
            "Conversation detail view should appear when tapping a conversation"
        )
    }

    // MARK: - Tab Navigation

    func testConversationsTabExists() {
        var conversationId = ""
        given("I am connected and a message has arrived") {
            conversationId = launchWithConversation()
        }
        then("the Conversations tab lists that conversation") {
            XCTAssertTrue(find("conversations-list").waitForExistence(timeout: 20), "A received message should produce a conversation list")
            XCTAssertTrue(
                find("conversation-row-\(conversationId)").waitForExistence(timeout: 10),
                "The conversation for the received message should be listed"
            )
            XCTAssertFalse(find("conversations-error").exists, "Conversations should have loaded without error")
        }
    }

    // MARK: - Empty State

    func testEmptyStateShowsMessage() {
        given("I am authenticated without a hub connection, so there are no conversations") {
            launchAuthenticated()
        }
        when("I open the Conversations tab") {
            navigateToConversations()
        }
        then("the empty state is displayed instead of a list") {
            XCTAssertTrue(
                find("conversations-empty-state").waitForExistence(timeout: 20),
                "Empty state is displayed when no conversations exist"
            )
            XCTAssertFalse(find("conversations-list").exists, "There is no list without conversations")
            XCTAssertFalse(find("conversations-error").exists, "No hub configured is not an error")
        }
    }

    // MARK: - Filter Menu

    func testFilterButtonExists() {
        given("I am authenticated") {
            launchAuthenticated()
        }
        when("I open the Conversations tab") {
            navigateToConversations()
            XCTAssertTrue(find("conversations-empty-state").waitForExistence(timeout: 20))
        }
        then("the filter button is in the toolbar") {
            XCTAssertTrue(
                find("conversations-filter-button").waitForExistence(timeout: 5),
                "Filter button should exist in the toolbar"
            )
        }
    }

    // MARK: - Conversation Detail

    func testConversationDetailOpens() {
        var conversationId = ""
        given("a conversation exists") {
            conversationId = launchWithConversation()
        }
        when("I open it") {
            openConversation(conversationId)
        }
        then("I can reply to it") {
            XCTAssertTrue(
                find("reply-text-field").waitForExistence(timeout: 5),
                "Reply text field should exist in conversation detail"
            )
            XCTAssertTrue(
                find("send-message-button").exists,
                "Send button should exist in conversation detail"
            )
        }
    }

    func testSendMessageButton() {
        var conversationId = ""
        given("I have a conversation open") {
            conversationId = launchWithConversation()
            openConversation(conversationId)
        }
        then("Send is disabled until I type a message") {
            let sendButton = app.buttons["send-message-button"]
            XCTAssertTrue(sendButton.waitForExistence(timeout: 5), "Send button should exist")
            XCTAssertFalse(sendButton.isEnabled, "Send should be disabled while the reply field is empty")

            let replyField = find("reply-text-field")
            XCTAssertTrue(replyField.waitForExistence(timeout: 5), "Reply field should exist")
            replyField.tap()
            replyField.typeText("Test message from UI test - \(Date().timeIntervalSince1970)")

            XCTAssertTrue(sendButton.isEnabled, "Send should be enabled once there is a message to send")
        }
    }

    // MARK: - Channel Header

    func testChannelHeaderVisible() {
        var conversationId = ""
        given("a WhatsApp conversation exists") {
            conversationId = launchWithConversation(channel: "whatsapp")
        }
        when("I open it") {
            openConversation(conversationId)
        }
        then("the channel header names the channel") {
            let header = find("conversation-channel-header")
            XCTAssertTrue(header.waitForExistence(timeout: 5), "Channel header is visible in conversation detail")
            XCTAssertTrue(
                app.staticTexts["WhatsApp"].exists,
                "The channel header should name the conversation's channel"
            )
        }
    }
}
