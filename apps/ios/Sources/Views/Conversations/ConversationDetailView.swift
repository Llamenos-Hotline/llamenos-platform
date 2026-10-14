import SwiftUI

// MARK: - ConversationDetailView

/// Detail view for a single conversation, showing message bubbles, channel indicator,
/// text input, and real-time updates.
struct ConversationDetailView: View {
    @Environment(AppState.self) private var appState
    @Environment(HubContext.self) private var hubContext
    @State private var viewModelBox = ViewModelBox<ConversationsViewModel>()

    let conversationId: String

    var body: some View {
        let vm = resolvedViewModel

        VStack(spacing: 0) {
            // Channel indicator
            channelHeader(vm: vm)

            // Messages
            if vm.isLoadingMessages && vm.currentMessages.isEmpty {
                loadingState
            } else if vm.currentMessages.isEmpty {
                emptyMessagesState
            } else {
                messagesList(vm: vm)
            }

            // Reply input
            replyBar(vm: vm)
        }
        .navigationTitle(conversationTitle(vm: vm))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            // This view owns its view model, so it loads the conversation itself: the
            // channel header, the reply bar and the reply's reader list all need it.
            await vm.loadConversations()
            await vm.loadMessages(for: conversationId)
        }
        // `.contain` keeps this identifier off the children (reply field, send button).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("conversation-detail-view")
    }

    // MARK: - Channel Header

    @ViewBuilder
    private func channelHeader(vm: ConversationsViewModel) -> some View {
        let conversation = vm.allConversations.first { $0.id == conversationId }

        if let conversation {
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
            .accessibilityIdentifier("conversation-channel-header")
        }
    }

    // MARK: - Messages List

    @ViewBuilder
    private func messagesList(vm: ConversationsViewModel) -> some View {
        ScrollViewReader { scrollProxy in
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(vm.currentMessages) { message in
                        MessageBubbleView(message: message)
                            .id(message.id)
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
    private func replyBar(vm: ConversationsViewModel) -> some View {
        let conversation = vm.allConversations.first { $0.id == conversationId }
        let isClosed = conversation?.conversationStatus == .closed

        if isClosed {
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
            .background(Color.brandCard)
            .accessibilityIdentifier("conversation-closed-bar")
        } else {
            VStack(spacing: 0) {
                Divider()
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
            .background(Color.brandCard)
        }
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
        .accessibilityIdentifier("messages-loading")
    }

    // MARK: - Helpers

    private func conversationTitle(vm: ConversationsViewModel) -> String {
        let conversation = vm.allConversations.first { $0.id == conversationId }
        return conversation?.contactDisplayHash
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

// MARK: - Preview

#if DEBUG
#Preview("Conversation Detail") {
    NavigationStack {
        ConversationDetailView(conversationId: "preview-1")
            .environment(AppState(hubContext: HubContext()))
    }
}
#endif
