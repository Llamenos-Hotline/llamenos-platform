import SwiftUI

/// Animated banner that appears when the device is offline or there are
/// queued operations waiting to sync. Mirrors the desktop offline banner behavior.
///
/// Shows:
/// - "You are offline" when there is no network connectivity
/// - "X operations pending" when the offline queue has items waiting to replay
/// - Both messages simultaneously when offline with a non-empty queue
struct OfflineBanner: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        let offlineQueue = appState.offlineQueue
        let isOffline = !appState.webSocketService.connectionState.isConnected
        let pending = offlineQueue.pendingCount

        if isOffline || pending > 0 {
            VStack(spacing: 4) {
                if isOffline {
                    HStack(spacing: 6) {
                        Image(systemName: "wifi.slash")
                            .font(.caption2)
                        Text(NSLocalizedString("offline_banner", comment: "You are offline"))
                            .font(.brand(.caption))
                            .lineLimit(2)
                    }
                }

                if pending > 0 {
                    HStack(spacing: 6) {
                        if offlineQueue.isReplaying {
                            ProgressView()
                                .scaleEffect(0.6)
                        } else {
                            Image(systemName: "arrow.triangle.2.circlepath")
                                .font(.caption2)
                        }

                        Text(L10n.format(
                            pending == 1 ? "offline_pending_sync_message_one" : "offline_pending_sync_message",
                            comment: "N operations waiting to sync",
                            pending
                        ))
                        .font(.brand(.caption))
                    }
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(Color.brandAccent.opacity(0.15))
            .foregroundStyle(Color.brandAccent)
            .accessibilityIdentifier("offline-banner")
            .transition(.move(edge: .top).combined(with: .opacity))
            .animation(.easeInOut(duration: 0.3), value: isOffline)
            .animation(.easeInOut(duration: 0.3), value: pending)
        }
    }
}

// MARK: - RejectedWritesBanner

/// Tells the author a queued write was refused by the server, on whichever tab they are
/// on — the failure is useless on a screen they may not visit again (#2208).
///
/// Each row names the kind of write and offers Retry (their content is still held by the
/// queue and is sent again) and Dismiss (discard it). Nothing here clears itself: a
/// refused write stays until the author acts on it.
struct RejectedWritesBanner: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        let queue = appState.offlineQueue
        let rejected = queue.rejected

        if !rejected.isEmpty {
            VStack(spacing: 6) {
                ForEach(rejected) { op in
                    row(op, queue: queue)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(Color.brandAccent.opacity(0.15))
            .foregroundStyle(Color.brandAccent)
            .accessibilityIdentifier("offline-rejected-banner")
            .transition(.move(edge: .top).combined(with: .opacity))
            .animation(.easeInOut(duration: 0.3), value: rejected.count)
        }
    }

    private func row(_ op: QueuedOperation, queue: OfflineQueue) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption2)
            VStack(alignment: .leading, spacing: 0) {
                if let titleKey = Self.titleKey(for: op.type) {
                    Text(NSLocalizedString(titleKey, comment: "What kind of write was refused"))
                        .fontWeight(.semibold)
                }
                Text(NSLocalizedString("offline_rejected", comment: "Not saved: the server refused it"))
            }
            Spacer(minLength: 8)
            Button(NSLocalizedString("common_retry", comment: "Retry")) {
                queue.retryRejected(id: op.id)
            }
            .accessibilityIdentifier("offline-rejected-retry-\(op.id)")
            Button(NSLocalizedString("common_dismiss", comment: "Dismiss")) {
                queue.dismissRejected(id: op.id)
            }
            .accessibilityIdentifier("offline-rejected-dismiss-\(op.id)")
        }
        .font(.brand(.caption))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("offline-rejected-\(op.id)")
    }

    /// The feature a refused write belonged to, so the author knows which record to look
    /// for; nil for a write with no user-facing name.
    static func titleKey(for type: QueuedOperationType) -> String? {
        switch type {
        case .noteCreate, .noteUpdate: return "notes_title"
        case .messageSend: return "conversations_title"
        case .reportCreate, .reportMessage: return "reports_title"
        case .shiftToggle: return "shifts_title"
        case .banAdd, .banRemove: return "nav_ban_list"
        case .genericWrite: return nil
        }
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Offline Banner") {
    VStack {
        OfflineBanner()
        Spacer()
    }
    .environment(AppState(hubContext: HubContext()))
}
#endif
