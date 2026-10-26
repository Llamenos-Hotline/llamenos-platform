import SwiftUI

// MARK: - ConversationDetailView

/// Detail view for a single conversation, showing message bubbles, channel indicator,
/// text input, and real-time updates.
///
/// The screen's view model owns the conversation it shows (#1913). It used to look the
/// conversation up in `vm.allConversations`, but this screen builds its own view model and
/// only ever loaded messages into it, so that list was always empty: no channel header, a
/// generic title, and a closed conversation that still offered a reply bar. The channel
/// header, the title and the reply bar now all derive from `GET /api/conversations/:id`.
///
/// A waiting conversation is taken with an explicit Claim (`POST …/claim`); replying never
/// claims. The thread re-reads when a relay event says its messages or assignee changed.
struct ConversationDetailView: View {
    @Environment(AppState.self) private var appState
    @Environment(HubContext.self) private var hubContext
    @State private var viewModelBox = ViewModelBox<ConversationsViewModel>()

    let conversationId: String

    var body: some View {
        let vm = resolvedViewModel
        let conversation = vm.currentConversation

        VStack(spacing: 0) {
            if let conversation {
                channelHeader(conversation)
            }

            // Messages
            if let error = vm.conversationLoadError, conversation == nil {
                errorState(error, vm: vm)
            } else if conversation == nil || (vm.isLoadingMessages && vm.currentMessages.isEmpty) {
                loadingState
            } else if let error = vm.errorMessage, vm.currentMessages.isEmpty {
                // A failed message load is an error, not an empty conversation.
                errorState(error, vm: vm)
            } else if vm.currentMessages.isEmpty {
                emptyMessagesState
            } else {
                messagesList(vm: vm)
            }

            // Reply input — only once the conversation is known, and never for a
            // closed one. Offering a reply before the status has loaded would let a
            // volunteer type into a conversation that turns out to be closed.
            if let conversation {
                replyBar(vm: vm, conversation: conversation)
            }
        }
        .navigationTitle(conversationTitle(conversation))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: conversationId) {
            // Listen before loading so an event during the load is not missed; the filter
            // drops events until the thread's hub is known.
            vm.startEventListener()
            await vm.loadThread(for: conversationId)
        }
        .onDisappear { vm.stopEventListener() }
        // `.contain` keeps the container a container (#1914). A bare identifier on a
        // plain VStack is pushed down onto every child, overwriting `reply-text-field`,
        // `send-message-button` and the header's id, so none of them was reachable.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("conversation-detail-view")
    }

    // MARK: - Channel Header

    private func channelHeader(_ conversation: AppConversation) -> some View {
        HStack(spacing: 8) {
            Image(systemName: conversation.channel.iconName)
                .font(.caption)
                .foregroundStyle(channelColor(for: conversation.channel))

            Text(conversation.channel.displayName)
                .font(.brand(.caption))
                .fontWeight(.medium)
                .foregroundStyle(channelColor(for: conversation.channel))

            Spacer()

            BadgeView(
                text: conversation.conversationStatus.displayName,
                color: statusColor(for: conversation.conversationStatus),
                style: .subtle
            )
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color.brandCard)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("conversation-channel-header")
    }

    // MARK: - Messages List

    @ViewBuilder
    private func messagesList(vm: ConversationsViewModel) -> some View {
        ScrollViewReader { scrollProxy in
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(vm.currentMessages) { message in
                        switch message {
                        case .readable(let readable):
                            MessageBubbleView(message: readable)
                                .id(message.id)
                        case .unreadable(let unreadable):
                            UnreadableMessageRow(message: unreadable)
                                .id(message.id)
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .onChange(of: vm.currentMessages.count) { _, _ in
                // Auto-scroll to bottom when new messages arrive
                if let lastMessage = vm.currentMessages.last {
                    withAnimation(.easeOut(duration: 0.3)) {
                        scrollProxy.scrollTo(lastMessage.id, anchor: .bottom)
                    }
                }
            }
            .onAppear {
                // Scroll to bottom on initial load
                if let lastMessage = vm.currentMessages.last {
                    scrollProxy.scrollTo(lastMessage.id, anchor: .bottom)
                }
            }
        }
        .accessibilityIdentifier("messages-list")
    }

    // MARK: - Reply Bar

    @ViewBuilder
    private func replyBar(vm: ConversationsViewModel, conversation: AppConversation) -> some View {
        if conversation.conversationStatus == .closed {
            HStack {
                Image(systemName: "lock.fill")
                    .font(.caption)
                    .foregroundStyle(Color.brandMutedForeground)
                Text(NSLocalizedString(
                    "conversation_closed_message",
                    comment: "This conversation is closed"
                ))
                .font(.brand(.footnote))
                .foregroundStyle(Color.brandMutedForeground)
            }
            .padding(12)
            .frame(maxWidth: .infinity)
            .background(Color.brandCard)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("conversation-closed-bar")
        } else {
            VStack(spacing: 0) {
                if ConversationAccess.canClaim(conversation, hasPermission: appState.hasPermission) {
                    claimBar(vm: vm, conversation: conversation)
                }
                if ConversationAccess.canReply(
                    conversation,
                    userPubkey: appState.cryptoService.signingPubkeyHex,
                    hasPermission: appState.hasPermission
                ) {
                    composer(vm: vm)
                }
            }
            .background(Color.brandCard)
        }
    }

    /// The explicit Claim control for a waiting, unassigned conversation.
    private func claimBar(vm: ConversationsViewModel, conversation: AppConversation) -> some View {
        VStack(spacing: 8) {
            Divider()
            if let error = vm.claimErrorMessage {
                Text(error)
                    .font(.brand(.footnote))
                    .foregroundStyle(Color.red)
                    .accessibilityIdentifier("claim-error")
            }
            Button {
                Task { await vm.claimConversation(conversation.id) }
            } label: {
                if vm.isClaiming {
                    ProgressView()
                } else {
                    Text(NSLocalizedString("conversations_claim", comment: "Claim"))
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(vm.isClaiming)
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
            .accessibilityIdentifier("claim-conversation-button")
        }
    }

    private func composer(vm: ConversationsViewModel) -> some View {
        VStack(spacing: 0) {
            Divider()
            if let error = vm.sendErrorMessage {
                Text(error)
                    .font(.brand(.footnote))
                    .foregroundStyle(Color.red)
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                    .accessibilityIdentifier("send-error")
            }
            HStack(spacing: 12) {
                TextField(
                    NSLocalizedString("conversation_reply_placeholder", comment: "Type a message..."),
                    text: Binding(
                        get: { vm.replyText },
                        set: { vm.replyText = $0 }
                    ),
                    axis: .vertical
                )
                .lineLimit(1...5)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("reply-text-field")

                Button {
                    Task { await vm.sendReply() }
                } label: {
                    if vm.isSending {
                        ProgressView()
                            .scaleEffect(0.8)
                    } else {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.title2)
                            .foregroundStyle(
                                vm.replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                    ? Color.brandMutedForeground
                                    : Color.brandPrimary
                            )
                    }
                }
                .disabled(
                    vm.replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || vm.isSending
                )
                .accessibilityIdentifier("send-message-button")
                .accessibilityLabel(NSLocalizedString("conversation_send", comment: "Send message"))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
    }

    // MARK: - Error State

    private func errorState(_ error: String, vm: ConversationsViewModel) -> some View {
        ContentUnavailableView {
            Label(
                NSLocalizedString("conversations_error_title", comment: "Unable to Load"),
                systemImage: "exclamationmark.triangle"
            )
        } description: {
            Text(error)
        } actions: {
            Button {
                Task {
                    vm.conversationLoadError = nil
                    vm.errorMessage = nil
                    await vm.loadThread(for: conversationId)
                }
            } label: {
                Text(NSLocalizedString("retry", comment: "Retry"))
            }
            .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("conversation-detail-error")
    }

    // MARK: - Empty State

    private var emptyMessagesState: some View {
        VStack(spacing: 12) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 40))
                .foregroundStyle(.tertiary)
            Text(NSLocalizedString(
                "conversation_no_messages",
                comment: "No messages yet"
            ))
            .font(.brand(.subheadline))
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("messages-empty-state")
    }

    // MARK: - Loading State

    private var loadingState: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text(NSLocalizedString("conversation_loading", comment: "Loading messages..."))
                .font(.brand(.subheadline))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("messages-loading")
    }

    // MARK: - Helpers

    private func conversationTitle(_ conversation: AppConversation?) -> String {
        conversation?.contactDisplayHash
            ?? NSLocalizedString("conversation_title", comment: "Conversation")
    }

    private func channelColor(for channel: ClientChannelType) -> Color {
        switch channel {
        case .sms: return .brandPrimary
        case .whatsapp: return .green
        case .signal: return .brandPrimary
        }
    }

    private func statusColor(for status: ConversationStatus) -> Color {
        switch status {
        case .active: return .statusActive
        case .waiting: return .orange
        case .closed: return .brandMutedForeground
        }
    }

    // MARK: - ViewModel Resolution

    private var resolvedViewModel: ConversationsViewModel {
        let currentAdminPubkeys = [appState.adminDecryptionPubkey].compactMap { $0 }
        if let vm = viewModelBox.value {
            vm.adminPubkeys = currentAdminPubkeys
            return vm
        }
        let vm = ConversationsViewModel(
            apiService: appState.apiService,
            cryptoService: appState.cryptoService,
            webSocketService: appState.webSocketService,
            hubContext: hubContext,
            adminPubkeys: currentAdminPubkeys
        )
        viewModelBox.value = vm
        return vm
    }
}

// MARK: - MessageBubbleView

/// A single message bubble. Inbound messages appear on the left with a gray background,
/// outbound messages on the right with a tinted background.
struct MessageBubbleView: View {
    let message: DecryptedMessage

    var body: some View {
        HStack {
            if message.isOutbound {
                Spacer(minLength: 60)
            }

            VStack(alignment: message.isInbound ? .leading : .trailing, spacing: 4) {
                // Message text
                Text(message.text)
                    .font(.brand(.body))
                    .foregroundStyle(message.isOutbound ? .white : Color.brandForeground)
                    .accessibilityIdentifier("message-text-\(message.id)")

                // Timestamp and read status
                HStack(spacing: 4) {
                    Text(message.timeDisplay)
                        .font(.brand(.caption2))
                        .foregroundStyle(message.isOutbound ? Color.white.opacity(0.7) : Color.brandMutedForeground)

                    if message.isOutbound && message.isRead {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.caption2)
                            .foregroundStyle(.white.opacity(0.7))
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(bubbleBackground)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay(
                message.isInbound
                    ? RoundedRectangle(cornerRadius: 16)
                        .stroke(Color.brandBorder, lineWidth: 1)
                    : nil
            )

            if message.isInbound {
                Spacer(minLength: 60)
            }
        }
        .accessibilityIdentifier("message-bubble-\(message.id)")
        .accessibilityLabel(accessibilityDescription)
    }

    // MARK: - Background

    private var bubbleBackground: some ShapeStyle {
        if message.isOutbound {
            return AnyShapeStyle(Color.brandPrimary)
        } else {
            return AnyShapeStyle(Color.brandCard)
        }
    }

    // MARK: - Accessibility

    private var accessibilityDescription: String {
        let direction = message.isInbound
            ? NSLocalizedString("message_inbound", comment: "Received")
            : NSLocalizedString("message_outbound", comment: "Sent")
        return "\(direction): \(message.text). \(message.fullDateDisplay)"
    }
}

// MARK: - UnreadableMessageRow

/// Stands in for a message this device could not open, so the thread says that someone
/// wrote in instead of reading as empty.
struct UnreadableMessageRow: View {
    let message: ThreadMessage.UnreadableMessage

    var body: some View {
        HStack {
            if message.direction == "outbound" {
                Spacer(minLength: 60)
            }
            HStack(spacing: 8) {
                Image(systemName: "lock.fill")
                    .font(.caption)
                Text(NSLocalizedString(
                    "hubs_key_unavailable",
                    comment: "Encrypted content can't be opened on this device yet"
                ))
                .font(.brand(.footnote))
            }
            .foregroundStyle(Color.brandMutedForeground)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.brandBorder, style: StrokeStyle(lineWidth: 1, dash: [4])))
            if message.direction != "outbound" {
                Spacer(minLength: 60)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("message-unreadable-\(message.id)")
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Conversation Detail") {
    NavigationStack {
        ConversationDetailView(conversationId: "preview-1")
            .environment(AppState(hubContext: HubContext()))
    }
}
#endif
