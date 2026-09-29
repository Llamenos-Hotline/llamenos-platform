import SwiftUI

// MARK: - ConversationsView

/// Main conversations list view showing all messaging conversations (SMS/WhatsApp/Signal)
/// with channel badges, unread counts, status filtering, and pull-to-refresh.
struct ConversationsView: View {
    @Environment(AppState.self) private var appState
    @Environment(HubContext.self) private var hubContext
    @State private var viewModelBox = ViewModelBox<ConversationsViewModel>()

    var body: some View {
        let vm = resolvedViewModel

        NavigationStack {
            ZStack {
                if vm.isLoading && vm.filteredConversations.isEmpty {
                    loadingState
                } else if let error = vm.errorMessage, vm.filteredConversations.isEmpty {
                    errorState(error, vm: vm)
                } else if vm.filteredConversations.isEmpty {
                    emptyState
                } else {
                    conversationsList(vm: vm)
                }
            }
            .navigationTitle(NSLocalizedString("conversations_title", comment: "Conversations"))
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    statusFilterMenu(vm: vm)
                }
            }
            .refreshable {
                await vm.refresh()
            }
            .task(id: hubContext.activeHubId) {
                await vm.loadConversations()
                vm.startEventListener()
            }
            .onDisappear {
                vm.stopEventListener()
            }
            .navigationDestination(for: String.self) { conversationId in
                ConversationDetailView(conversationId: conversationId)
            }
        }
    }

    // MARK: - Status Filter Menu

    @ViewBuilder
    private func statusFilterMenu(vm: ConversationsViewModel) -> some View {
        Menu {
            ForEach(ConversationStatusFilter.allCases, id: \.self) { filter in
                Button {
                    vm.statusFilter = filter
                } label: {
                    HStack {
                        Text(filter.displayName)
                        if vm.statusFilter == filter {
                            Image(systemName: "checkmark")
                        }
                    }
                }
                .accessibilityIdentifier("filter-\(filter.rawValue)")
            }
        } label: {
            Image(systemName: "line.3.horizontal.decrease.circle")
                .font(.body)
        }
        .accessibilityIdentifier("conversations-filter-button")
        .accessibilityLabel(NSLocalizedString("conversations_filter", comment: "Filter conversations"))
    }

    // MARK: - Conversations List

    @ViewBuilder
    private func conversationsList(vm: ConversationsViewModel) -> some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                ForEach(vm.filteredConversations) { conversation in
                    NavigationLink(value: conversation.id) {
                        ConversationRowView(conversation: conversation)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("conversation-row-\(conversation.id)")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .accessibilityIdentifier("conversations-list")
    }

    // MARK: - Empty State

    private var emptyState: some View {
        ContentUnavailableView {
            Label(
                NSLocalizedString("conversations_empty_title", comment: "No Conversations"),
                systemImage: "bubble.left.and.bubble.right"
            )
        } description: {
            Text(NSLocalizedString(
                "conversations_empty_message",
                comment: "Incoming messages from SMS, WhatsApp, and Signal will appear here."
            ))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("conversations-empty-state")
    }

    // MARK: - Loading State

    private var loadingState: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text(NSLocalizedString("conversations_loading", comment: "Loading conversations..."))
                .font(.brand(.subheadline))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("conversations-loading")
    }

    // MARK: - Error State

    @ViewBuilder
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
                Task { await vm.refresh() }
            } label: {
                Text(NSLocalizedString("retry", comment: "Retry"))
            }
            .buttonStyle(.bordered)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("conversations-error")
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

// MARK: - ConversationRowView

/// A single conversation row in the list, showing channel badge, contact hash,
/// unread count, status, and last message time.
struct ConversationRowView: View {
    let conversation: AppConversation
    @Environment(\.layoutDirection) private var layoutDirection

    var body: some View {
        HStack(spacing: 12) {
            // Avatar with channel overlay
            ZStack(alignment: .bottomTrailing) {
                GeneratedAvatar(hash: conversation.contactHash, size: 36)

                Image(systemName: conversation.channel.iconName)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 16, height: 16)
                    .background(Circle().fill(channelColor))
                    .offset(x: layoutDirection == .rightToLeft ? -2 : 2, y: 2)
                    .accessibilityLabel(conversation.channel.displayName)
            }

            // Content
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(conversation.contactDisplayHash)
                        .font(.brandMono(.body))
                        .fontWeight(conversation.unreadCount > 0 ? .semibold : .regular)
                        .foregroundStyle(Color.brandForeground)
                        .lineLimit(1)

                    Spacer()

                    Text(conversation.lastMessageRelativeTime)
                        .font(.brand(.caption2))
                        .foregroundStyle(Color.brandMutedForeground)
                }

                HStack {
                    statusBadge

                    Spacer()

                    if conversation.unreadCount > 0 {
                        unreadBadge
                    }
                }
            }
        }
        .padding(12)
        .background(Color.brandCard)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.brandBorder, lineWidth: 1)
        )
    }

    // MARK: - Channel Color

    private var channelColor: Color {
        switch conversation.channel {
        case .sms: return .brandPrimary
        case .whatsapp: return .green
        case .signal: return .brandPrimary
        }
    }

    // MARK: - Status Badge

    private var statusBadge: some View {
        BadgeView(
            text: conversation.conversationStatus.displayName,
            color: statusColor,
            style: .subtle
        )
    }

    private var statusColor: Color {
        switch conversation.conversationStatus {
        case .active: return .statusActive
        case .waiting: return .orange
        case .closed: return .brandMutedForeground
        }
    }

    // MARK: - Unread Badge

    private var unreadBadge: some View {
        Text("\(conversation.unreadCount)")
            .font(.brand(.caption))
            .fontWeight(.bold)
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(
                Capsule()
                    .fill(Color.brandDestructive)
            )
            .accessibilityLabel(String(format: NSLocalizedString(
                "conversations_unread_count",
                comment: "%d unread messages"
            ), conversation.unreadCount))
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Conversations - Empty") {
    ConversationsView()
        .environment(AppState(hubContext: HubContext()))
}
#endif
