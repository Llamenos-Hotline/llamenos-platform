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
