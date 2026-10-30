import Foundation
import UIKit

// MARK: - ConversationsViewModel

/// View model for the Conversations tab. Fetches conversations from the API,
/// manages status filtering, and handles real-time message updates via WebSocket.
///
/// `@MainActor` (#1920 audit): SwiftUI reads this `@Observable` state on the main thread,
/// so every write has to land there too. Unisolated, each `async` method ran on the global
/// executor under Swift 5.9 and wrote state from a GCD worker mid-render — the data race
/// Thread Sanitizer reported in #1918, #2049 and #1811. Network calls still suspend off the
/// main thread inside the API layer; only the state changes are pinned here.
@MainActor
@Observable
final class ConversationsViewModel {
    private let apiService: APIService
    private let cryptoService: CryptoService
    private let webSocketService: WebSocketService
    private let hubContext: HubContext
    var adminPubkeys: [String]

    // MARK: - Public State

    /// All conversations from the server, filtered by current status filter.
    var filteredConversations: [AppConversation] = []

    /// All conversations (unfiltered), used for badge count calculations.
    var allConversations: [AppConversation] = []

    /// Total unread message count across all conversations.
    var totalUnreadCount: Int {
        allConversations.reduce(0) { $0 + $1.unreadCount }
    }

    /// Current status filter.
    var statusFilter: ConversationStatusFilter = .active {
        didSet { applyFilter() }
    }

    /// Whether the initial load is in progress.
    var isLoading: Bool = false

    /// Error message from the last failed operation.
    var errorMessage: String?

    /// Every message of the currently viewed conversation, readable or not. A message this
    /// device cannot open stays in the list as an explicit `.unreadable` row — dropping it
    /// made a thread with an inbound message read "No messages yet".
    var currentMessages: [ThreadMessage] = []

    /// The currently viewed conversation ID.
    var currentConversationId: String?

    /// The currently viewed conversation as the server last reported it; nil until loaded.
    var currentConversation: AppConversation?

    /// Why the currently viewed conversation could not be loaded, if it could not.
    var conversationLoadError: String?

    /// Whether a claim request is in flight.
    var isClaiming: Bool = false

    /// Why the last claim failed, if it did. Cleared when the next claim starts.
    var claimErrorMessage: String?

    /// Whether messages are loading for the current conversation.
    var isLoadingMessages: Bool = false

    /// Text input for the reply field.
    var replyText: String = ""

    /// Whether a send is in progress.
    var isSending: Bool = false

    /// Why the last send failed, if it did. Separate from `errorMessage`, which the thread
    /// only shows in place of an empty list — a failed send must show over a full one.
    var sendErrorMessage: String?

    // MARK: - Private State

    /// Exempt from main-actor isolation only so the nonisolated `deinit` can cancel it:
    /// a `Task` handle is `Sendable` and `cancel()` is thread-safe, every other read and
    /// write happens on the main actor, and `deinit` runs once the last reference is
    /// gone, so nothing can race it. Not observed — no view reads it.
    @ObservationIgnored nonisolated(unsafe) private var eventTask: Task<Void, Never>?

    /// The hub whose conversations this view model last loaded. Conversations are served
    /// only under `/api/hubs/{hubId}/conversations…` (#2381), and every call here is scoped
    /// to this hub, so the data on screen belongs to it; an event from any other member hub
    /// says nothing about it. Read at load time rather than per event, so a hub switch
    /// cannot make a stale thread follow it.
    @ObservationIgnored private var loadedHubId: String?

    /// `path` under the hub whose data is on screen. Nil when no hub is selected: there is
    /// no unscoped conversations route to fall back to.
    private func conversationsPath(_ path: String) -> String? {
        guard let hubId = loadedHubId else { return nil }
        return APIService.hubPath(hubId, "/api/conversations\(path)")
    }

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
        loadedHubId = hubContext.activeHubId
        guard let path = conversationsPath("") else {
            // No hub selected — nothing to list.
            allConversations = []
            applyFilter()
            isLoading = false
            return
        }

        do {
            let response: ConversationsListResponse = try await apiService.request(
                method: "GET",
                path: path
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

    /// Load a conversation and its messages. The thread screen's single entry point.
    func loadThread(for conversationId: String) async {
        focus(conversationId)
        await loadConversation(conversationId)
        await loadMessages(for: conversationId)
    }

    /// Make `conversationId` the viewed conversation. Switching to a different one clears
    /// the previous thread; focusing the one already on screen changes nothing.
    private func focus(_ conversationId: String) {
        guard currentConversationId != conversationId else { return }
        currentConversationId = conversationId
        currentConversation = nil
        conversationLoadError = nil
        currentMessages = []
    }

    /// Re-read the viewed conversation's record (status, assignee).
    func loadConversation(_ conversationId: String) async {
        loadedHubId = hubContext.activeHubId
        guard let path = conversationsPath("/\(conversationId)") else { return }
        do {
            let loaded: AppConversation = try await apiService.request(
                method: "GET",
                path: path
            )
            guard currentConversationId == conversationId else { return }
            currentConversation = loaded
            conversationLoadError = nil
        } catch {
            guard currentConversationId == conversationId else { return }
            conversationLoadError = error.localizedDescription
        }
    }

    /// Load messages for a specific conversation and decrypt them.
    ///
    /// Switching to a different conversation clears the list; re-reading the one already
    /// on screen (after a send, a claim or a relay event) keeps it visible meanwhile, so
    /// the thread does not flash its loading state under the volunteer's eyes.
    func loadMessages(for conversationId: String) async {
        focus(conversationId)
        loadedHubId = hubContext.activeHubId
        guard let path = conversationsPath("/\(conversationId)/messages") else { return }
        isLoadingMessages = true

        do {
            let response: ConversationMessagesResponse = try await apiService.request(
                method: "GET",
                path: path
            )

            guard currentConversationId == conversationId else { return }
            let devicePubkey = cryptoService.encryptionPubkeyHex
            currentMessages = response.messages
                .map { message in
                    ThreadMessage(message, devicePubkey: devicePubkey) {
                        try self.cryptoService.decryptMessage(
                            encryptedContent: $0.encryptedContent,
                            readerEnvelopes: $0.readerEnvelopes
                        )
                    }
                }
                .sorted { $0.createdAt < $1.createdAt }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoadingMessages = false
    }

    // MARK: - Claim

    /// Claim the waiting conversation for this volunteer — `POST /conversations/:id/claim`.
    ///
    /// Only ever called from the explicit Claim control. Replying never claims: a send
    /// to a conversation the sender does not hold is the server's 403 to give.
    func claimConversation(_ conversationId: String) async {
        guard !isClaiming, let path = conversationsPath("/\(conversationId)/claim") else { return }
        isClaiming = true
        claimErrorMessage = nil

        do {
            let claimed: AppConversation = try await apiService.request(
                method: "POST",
                path: path
            )
            if currentConversationId == conversationId {
                currentConversation = claimed
            }
            if let index = allConversations.firstIndex(where: { $0.id == conversationId }) {
                allConversations[index] = claimed
                applyFilter()
            }
            // Claiming can change which envelopes the server holds for this device.
            await loadMessages(for: conversationId)
        } catch {
            claimErrorMessage = NSLocalizedString("conversations_claim_error", comment: "Failed to claim conversation")
            // Most likely someone else got there first (409) — show who holds it now.
            await loadConversation(conversationId)
        }

        isClaiming = false
    }

    // MARK: - Send Reply

    /// Encrypt and send a reply message in the current conversation.
    func sendReply() async {
        guard let conversationId = currentConversationId,
              let path = conversationsPath("/\(conversationId)/messages") else { return }
        let text = replyText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        isSending = true
        sendErrorMessage = nil

        do {
            var readerPubkeys: [String] = []

            // Include our own encryption pubkey for self-decryption
            if let ourPubkey = cryptoService.encryptionPubkeyHex {
                readerPubkeys.append(ourPubkey)
            }

            // Not the assignee: `assignedTo` is the assignee's signing (auth) pubkey, not a
            // key a message can be sealed to. Another device reads this reply through its own
            // registered key's envelope, which the server adds (assignee re-wrap, #1512).

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
                readerEnvelopes: encrypted.envelopes
            )

            let _: ConversationMessage = try await apiService.request(
                method: "POST",
                path: path,
                body: request
            )

            // Haptic feedback on success
            let generator = UIImpactFeedbackGenerator(style: .light)
            generator.impactOccurred()

            // Clear input and reload messages
            replyText = ""
            await loadMessages(for: conversationId)
        } catch {
            sendErrorMessage = error.localizedDescription
        }

        isSending = false
    }

    // MARK: - Real-time Events

    /// Start listening for typed WebSocket events related to conversations.
    func startEventListener() {
        eventTask?.cancel()
        eventTask = Task { [weak self] in
            guard let self else { return }
            for await attributed in self.webSocketService.attributedEvents {
                guard !Task.isCancelled else { break }
                // Events from every member hub arrive here; only the hub whose data is
                // on screen can change it. Nothing here touches `setActiveHub`.
                guard attributed.hubId == self.loadedHubId else { continue }
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
    private func handleTypedEvent(_ eventType: HubEventType) {
        switch eventType {
        case .messageNew, .conversationAssigned, .conversationClosed:
            Task { await loadConversations() }
            if let id = currentConversationId {
                Task { await loadThread(for: id) }
            }
        case .conversationEnvelopesAdded:
            // An admin device re-sealed the thread's content keys to this device's
            // registered keys: rows that were unreadable can open now. No list change.
            if let id = currentConversationId {
                Task { await loadMessages(for: id) }
            }
        case .conversationNew:
            Task { await loadConversations() }
        case .messageStatus:
            if let id = currentConversationId {
                Task { await loadMessages(for: id) }
            }
        case .callRing, .callAnswered, .callUpdate, .callEnded, .voicemailNew, .presenceSummary, .presenceDetail, .shiftStarted, .shiftEnded, .shiftUpdate, .noteCreated, .deviceWipe, .hubIncident, .unknown:
            // Not conversation-related — ignore
            break
        }
    }

    // MARK: - Filtering

    /// Apply the current status filter to the conversations list.
    private func applyFilter() {
        switch statusFilter {
        case .all:
            filteredConversations = allConversations
        case .active:
            // "Active" is every open conversation. A new inbound message arrives as
            // `waiting` (unclaimed) and stays so until someone replies; filtering on
            // `.active` alone hid exactly the conversations a volunteer needs to claim.
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

// MARK: - ThreadMessage

/// One row of a conversation thread: a message this device opened, or one it could not.
///
/// A thread that silently drops what it cannot decrypt is indistinguishable from an empty
/// one, and on a crisis line "no messages" over a caller's text is the worst thing to show.
/// An unreadable message stays in the list, in order, saying so.
enum ThreadMessage: Identifiable, Sendable {
    case readable(DecryptedMessage)
    case unreadable(UnreadableMessage)

    /// Why a message could not be opened.
    enum Reason: Sendable, Equatable {
        /// No reader envelope is addressed to this device's key — the server sealed it
        /// to other devices, or it predates this device's registration.
        case noEnvelopeForThisDevice
        /// An envelope is addressed to this device but did not open.
        case decryptionFailed
    }

    struct UnreadableMessage: Identifiable, Sendable {
        let id: String
        let direction: String
        let createdAt: Date
        let reason: Reason
    }

    var id: String {
        switch self {
        case .readable(let message): return message.id
        case .unreadable(let message): return message.id
        }
    }

    var createdAt: Date {
        switch self {
        case .readable(let message): return message.createdAt
        case .unreadable(let message): return message.createdAt
        }
    }

    /// Classify `message`: open it with `decrypt` when an envelope is addressed to
    /// `devicePubkey`, otherwise record why it stayed closed.
    init(
        _ message: ConversationMessage,
        devicePubkey: String?,
        decrypt: (ConversationMessage) throws -> String
    ) {
        let createdAt = DateFormatting.parseISO(message.createdAt) ?? Date()
        let addressedToDevice = devicePubkey.map { device in
            message.readerEnvelopes.contains { $0.pubkey.lowercased() == device.lowercased() }
        } ?? false

        guard addressedToDevice else {
            self = .unreadable(UnreadableMessage(
                id: message.id, direction: message.direction,
                createdAt: createdAt, reason: .noEnvelopeForThisDevice
            ))
            return
        }
        do {
            self = .readable(DecryptedMessage(
                id: message.id,
                text: try decrypt(message),
                direction: message.direction,
                createdAt: createdAt,
                isRead: message.isRead
            ))
        } catch {
            self = .unreadable(UnreadableMessage(
                id: message.id, direction: message.direction,
                createdAt: createdAt, reason: .decryptionFailed
            ))
        }
    }
}

// MARK: - ConversationAccess

/// What the signed-in user may do with a conversation. Decided by permission strings the
/// server also enforces — never by role name or admin flag (#2247).
enum ConversationAccess {
    /// The permission that lets a user claim a conversation on `channelType`. The server's
    /// `CHANNEL_CLAIM_PERMISSIONS` is exactly `conversations:claim-<channel>`.
    static func claimPermission(forChannelType channelType: String) -> String {
        "conversations:claim-\(channelType)"
    }

    /// Whether to offer Claim: the conversation is waiting and unassigned, and the user
    /// holds `conversations:claim-any` or the claim permission for its channel.
    static func canClaim(_ conversation: AppConversation, hasPermission: (String) -> Bool) -> Bool {
        guard conversation.conversationStatus == .waiting,
              conversation.assignedVolunteerPubkey == nil else { return false }
        return hasPermission("conversations:claim-any")
            || hasPermission(claimPermission(forChannelType: conversation.channelType))
    }

    /// Whether the server will accept a reply from this user (`POST …/messages`): the user
    /// is the assignee, or holds `conversations:send-any`. Never granted by claiming
    /// implicitly — a waiting conversation is claimed with the Claim control.
    static func canReply(_ conversation: AppConversation, userPubkey: String?, hasPermission: (String) -> Bool) -> Bool {
        if let userPubkey, conversation.assignedVolunteerPubkey == userPubkey { return true }
        return hasPermission("conversations:send-any")
    }
}
