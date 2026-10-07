import SwiftUI

// MARK: - Tab

/// Tabs in the main authenticated view.
enum Tab: String, CaseIterable, Sendable {
    case dashboard
    case notes
    case cases
    case conversations
    case shifts
    case settings

    var title: String {
        switch self {
        case .dashboard: return NSLocalizedString("tab_dashboard", comment: "Dashboard")
        case .notes: return NSLocalizedString("tab_notes", comment: "Notes")
        case .cases: return NSLocalizedString("tab_cases", comment: "Cases")
        case .conversations: return NSLocalizedString("tab_conversations", comment: "Messages")
        case .shifts: return NSLocalizedString("tab_shifts", comment: "Shifts")
        case .settings: return NSLocalizedString("tab_settings", comment: "Settings")
        }
    }

    var icon: String {
        switch self {
        case .dashboard: return "house.fill"
        case .notes: return "note.text"
        case .cases: return "folder.fill"
        case .conversations: return "bubble.left.and.bubble.right"
        case .shifts: return "calendar"
        case .settings: return "gearshape"
        }
    }
}

// MARK: - MainTabView

/// The primary authenticated experience. Contains a `TabView` with six tabs:
/// Dashboard, Notes, Cases, Conversations, Shifts, and Settings. Shown when `authStatus == .unlocked`.
///
/// Each tab has its own `NavigationStack` so navigation state is preserved
/// when switching between tabs.
struct MainTabView: View {
    @Environment(AppState.self) private var appState
    @Environment(Router.self) private var router
    @State private var selectedTab: Tab = .dashboard
    @State private var conversationsViewModel: ConversationsViewModel?

    var body: some View {
        TabView(selection: $selectedTab) {
            // Dashboard
            DashboardView()
                .tabItem {
                    Label(Tab.dashboard.title, systemImage: Tab.dashboard.icon)
                }
                .tag(Tab.dashboard)

            // Notes
            NotesView()
                .tabItem {
                    Label(Tab.notes.title, systemImage: Tab.notes.icon)
                }
                .tag(Tab.notes)

            // Cases
            CaseListView()
                .tabItem {
                    Label(Tab.cases.title, systemImage: Tab.cases.icon)
                }
                .tag(Tab.cases)
                .accessibilityIdentifier("cases-tab")

            // Conversations
            ConversationsView()
                .tabItem {
                    Label(Tab.conversations.title, systemImage: Tab.conversations.icon)
                }
                .tag(Tab.conversations)
                .badge(appState.unreadConversationCount)

            // Shifts
            ShiftsView()
                .tabItem {
                    Label(Tab.shifts.title, systemImage: Tab.shifts.icon)
                }
                .tag(Tab.shifts)

            // Settings
            SettingsView()
                .tabItem {
                    Label(Tab.settings.title, systemImage: Tab.settings.icon)
                }
                .tag(Tab.settings)
        }
        .tint(.brandPrimary)
        .accessibilityIdentifier("main-tab-view")
        .task {
            await fetchUnreadCount()
        }
    }

    // MARK: - Unread Count

    /// Seed the Messages tab badge: conversations in the active hub waiting for someone
    /// to claim them. The server keeps no per-reader unread count.
    private func fetchUnreadCount() async {
        do {
            let response: ConversationListResponse = try await appState.apiService.request(
                method: "GET",
                path: appState.apiService.hp("/api/conversations")
            )
            let total = response.conversations.filter { $0.conversationStatus == .waiting }.count
            await MainActor.run {
                appState.unreadConversationCount = total
            }
        } catch {
            // Non-critical — leave badge count as-is
        }
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Main Tab View") {
    MainTabView()
        .environment(AppState(hubContext: HubContext()))
        .environment(Router())
}
#endif
