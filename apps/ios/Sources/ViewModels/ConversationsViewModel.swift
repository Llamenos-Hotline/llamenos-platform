import Foundation
import UIKit

// MARK: - ConversationsViewModel

/// View model for the Conversations tab. Fetches conversations from the API,
/// manages status filtering, and handles real-time message updates via WebSocket.
@Observable
final class ConversationsViewModel {
    private let apiService: APIService
    private let cryptoService: CryptoService
    private let webSocketService: WebSocketService
    private let hubContext: HubContext
    var adminPubkeys: [String]

    // MARK: - Public State

    /// All conversations from the server, filtered by current status filter.
    var filteredConversations: [ConversationListResponseConversation] = []

    /// All conversations (unfiltered), used for badge count calculations.
    var allConversations: [ConversationListResponseConversation] = []

    /// Current status filter.
    var statusFilter: ConversationStatusFilter = .active {
        didSet { applyFilter() }
    }

    /// Whether the initial load is in progress.
    var isLoading: Bool = false

    /// Error message from the last failed operation.
    var errorMessage: String?

    /// Messages for the currently viewed conversation.
    var currentMessages: [DecryptedMessage] = []

    /// The currently viewed conversation ID.
    var currentConversationId: String?

    /// Whether messages are loading for the current conversation.
    var isLoadingMessages: Bool = false

    /// Text input for the reply field.
    var replyText: String = ""

    /// Whether a send is in progress.
    var isSending: Bool = false

    // MARK: - Private State

    private var eventTask: Task<Void, Never>?

    // MARK: - Initialization

    init(apiService: APIService, cryptoService: CryptoService, webSocketService: WebSocketService, hubContext: HubContext, adminPubkeys: [String] = []) {
        self.apiService = apiService
        self.cryptoService = cryptoService
        self.webSocketService = webSocketService
        self.hubContext = hubContext
        self.adminPubkeys = adminPubkeys
    }

    // MARK: - Data Loading

    /// Load conversations from the API.
    func loadConversations() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil

        do {
            let response: ConversationListResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/conversations")
            )
            allConversations = response.conversations.sorted { lhs, rhs in
                // Sort by last message time, newest first
                let lhsDate = lhs.lastMessageDate ?? lhs.createdDate ?? Date.distantPast
                let rhsDate = rhs.lastMessageDate ?? rhs.createdDate ?? Date.distantPast
                return lhsDate > rhsDate
            }
            applyFilter()
        } catch {
            if case APIError.noBaseURL = error {
                // Hub not configured — show empty state
            } else {
                errorMessage = error.localizedDescription
            }
        }

        isLoading = false
    }

    /// Refresh conversations (pull-to-refresh).
    func refresh() async {
        isLoading = false
        await loadConversations()
    }

    // MARK: - Message Loading

    /// Load messages for a specific conversation and decrypt them.
    func loadMessages(for conversationId: String) async {
        currentConversationId = conversationId
        isLoadingMessages = true
        currentMessages = []

        do {
            let response: ConversationMessagesResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/conversations/\(conversationId)/messages")
            )

            currentMessages = response.messages.compactMap { decryptConversationMessage($0) }
                .sorted { $0.createdAt < $1.createdAt }

            // Mark as read
            await markAsRead(conversationId: conversationId)
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoadingMessages = false
    }

    // MARK: - Send Reply

    /// Encrypt and send a reply message in the current conversation.
    func sendReply() async {
        guard let conversationId = currentConversationId else { return }
        let text = replyText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        isSending = true

        do {
            // Find the conversation to get reader pubkeys
            let conversation = allConversations.first { $0.id == conversationId }
            var readerPubkeys: [String] = []

            // Include our own encryption pubkey for self-decryption
            if let ourPubkey = cryptoService.encryptionPubkeyHex {
                readerPubkeys.append(ourPubkey)
            }

            // Include assigned volunteer (may be us or someone else)
            if let assignedPubkey = conversation?.assignedTo,
               !readerPubkeys.contains(assignedPubkey) {
                readerPubkeys.append(assignedPubkey)
            }

            // Include admin pubkeys so admins can decrypt messages
            for adminPubkey in adminPubkeys where !readerPubkeys.contains(adminPubkey) {
                readerPubkeys.append(adminPubkey)
            }

            let encrypted = try cryptoService.encryptMessage(
                plaintext: text,
                readerPubkeys: readerPubkeys
            )

            let request = SendMessageRequest(
                encryptedContent: encrypted.encryptedContent,
                recipientEnvelopes: encrypted.envelopes
            )

            let _: ConversationMessage = try await apiService.request(
                method: "POST",
                path: apiService.hp("/api/conversations/\(conversationId)/messages"),
                body: request
            )

            // Haptic feedback on success
            let generator = UIImpactFeedbackGenerator(style: .light)
            generator.impactOccurred()

            // Clear input and reload messages
            replyText = ""
            await loadMessages(for: conversationId)
        } catch {
            errorMessage = error.localizedDescription
        }

        isSending = false
    }

    // MARK: - Mark as Read

    /// Mark all messages in a conversation as read.
    private func markAsRead(conversationId: String) async {
        do {
            let _: MarkReadResponse = try await apiService.request(
                method: "POST",
                path: apiService.hp("/api/conversations/\(conversationId)/read")
            )

            // Update the local unread count
            if let index = allConversations.firstIndex(where: { $0.id == conversationId }) {
                // Re-fetch to get updated count since Conversation is immutable
                await loadConversations()
            }
        } catch {
            // Non-critical — don't surface this error
        }
    }

    // MARK: - Real-time Events

    /// Start listening for typed WebSocket events related to conversations.
    func startEventListener() {
        eventTask?.cancel()
        eventTask = Task { [weak self] in
            guard let self else { return }
            for await attributed in self.webSocketService.attributedEvents {
                guard !Task.isCancelled else { break }
                guard attributed.hubId == self.hubContext.activeHubId else { continue }
                await self.handleTypedEvent(attributed.event)
            }
        }
    }

    /// Stop listening for events.
    func stopEventListener() {
        eventTask?.cancel()
        eventTask = nil
    }

    /// Handle a decrypted, typed hub event — only react to conversation-related events.
    @MainActor
    private func handleTypedEvent(_ eventType: HubEventType) {
        switch eventType {
        case .messageNew, .conversationAssigned, .conversationClosed:
            Task { await loadConversations() }
            if let id = currentConversationId {
                Task { await loadMessages(for: id) }
            }
        case .conversationNew:
            Task { await loadConversations() }
        case .messageStatus:
            if let id = currentConversationId {
                Task { await loadMessages(for: id) }
            }
        case .callRing, .callAnswered, .callUpdate, .callEnded, .voicemailNew, .presenceSummary, .presenceDetail, .shiftStarted, .shiftEnded, .shiftUpdate, .noteCreated, .deviceWipe, .unknown:
            // Not conversation-related — ignore
            break
        }
    }

    // MARK: - Message Decryption

    /// Decrypt a conversation message using the HPKE envelope for our encryption pubkey.
    private func decryptConversationMessage(_ message: ConversationMessage) -> DecryptedMessage? {
        guard let ourPubkey = cryptoService.encryptionPubkeyHex else { return nil }

        // Find our envelope
        guard let ourEnvelope = message.recipientEnvelopes.first(where: { $0.pubkey == ourPubkey }) else {
            return nil
        }

        do {
            // Reconstruct HPKE envelope from the protocol wire format
            let hpkeEnvelope = HpkeEnvelope(
                v: 3,
                labelId: 0,
                enc: ourEnvelope.enc,
                ct: ourEnvelope.ct
            )

            let decryptedText = try cryptoService.decryptMessage(
                encryptedContent: message.encryptedContent,
                envelope: hpkeEnvelope
            )

            return DecryptedMessage(
                id: message.id,
                text: decryptedText,
                direction: message.direction,
                channelType: message.channelType,
                createdAt: DateFormatting.parseISO(message.createdAt) ?? Date(),
                isRead: message.isRead
            )
        } catch {
            return nil
        }
    }

    // MARK: - Filtering

    /// Apply the current status filter to the conversations list.
    private func applyFilter() {
        switch statusFilter {
        case .all:
            filteredConversations = allConversations
        case .active:
            // Open conversations: in progress, or waiting for someone to claim them.
            filteredConversations = allConversations.filter { $0.conversationStatus != .closed }
        case .closed:
            filteredConversations = allConversations.filter { $0.conversationStatus == .closed }
        }
    }

    // MARK: - Helpers


    deinit {
        eventTask?.cancel()
    }
}

// MARK: - ConversationStatusFilter

/// Filter options for the conversations list.
enum ConversationStatusFilter: String, CaseIterable, Sendable {
    case active
    case closed
    case all

    var displayName: String {
        switch self {
        case .active: return NSLocalizedString("filter_active", comment: "Active")
        case .closed: return NSLocalizedString("filter_closed", comment: "Closed")
        case .all: return NSLocalizedString("filter_all", comment: "All")
        }
    }
}
