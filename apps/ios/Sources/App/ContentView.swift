import SwiftUI

/// Root view that switches between screens based on the current auth status.
/// Uses `NavigationStack` with the `Router` for push-based navigation within
/// each auth state (e.g., login -> onboarding -> PIN set).
///
/// When authenticated (`rootRoute == .dashboard`), shows the `MainTabView`
/// with four tabs: Dashboard, Notes, Shifts, Settings.
struct ContentView: View {
    @Environment(AppState.self) private var appState
    @Environment(Router.self) private var router

    var body: some View {
        @Bindable var router = router

        switch router.rootRoute {
        case .dashboard:
            // MainTabView has its own NavigationStack per tab — no outer wrapper needed.
            // Wrapping it in another NavigationStack suppresses inner nav bars and toolbars.
            MainTabView()
        default:
            // Login, PIN unlock, and onboarding flows use a shared NavigationStack for push navigation.
            NavigationStack(path: $router.path) {
                rootView
                    .navigationDestination(for: Route.self) { route in
                        destinationView(for: route)
                    }
            }
        }
    }

    // MARK: - Root View

    /// The root view for non-dashboard states (login, PIN unlock).
    @ViewBuilder
    private var rootView: some View {
        switch router.rootRoute {
        case .login:
            LoginView()
        case .pinUnlock:
            PINUnlockView()
        default:
            LoginView()
        }
    }

    // MARK: - Navigation Destinations

    /// Maps each `Route` to its corresponding SwiftUI view for push navigation.
    @ViewBuilder
    private func destinationView(for route: Route) -> some View {
        switch route {
        case .login:
            LoginView()
        case .pinSet:
            PINSetView()
        case .pinUnlock:
            PINUnlockView()
        case .dashboard:
            MainTabView()
        case .noteDetail, .noteCreate:
            // These are handled within the Notes tab's own NavigationStack
            EmptyView()
        case .reports:
            ReportsView()
        case .reportDetail:
            // Handled within the Reports view's own NavigationStack
            EmptyView()
        case .contacts:
            ContactsView()
        case .contactTimeline(let hash, let displayIdentifier):
            ContactTimelineView(contactHash: hash, displayIdentifier: displayIdentifier)
        case .blasts:
            BlastsView()
        case .conversations:
            ConversationsView()
        case .conversationDetail(let id):
            ConversationDetailView(conversationId: id)
        case .callHistory:
            CallHistoryView()
        case .callDetail:
            // Handled within CallHistoryView's own NavigationStack
            EmptyView()
        case .cases:
            CaseListView()
        case .caseDetail:
            // Handled within CaseListView's own NavigationStack
            EmptyView()
        case .notes:
            NotesView()
        case .settings:
            SettingsView()
        case .admin:
            AdminTabView()
        }
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Content View - Unauthenticated") {
    let appState = AppState(hubContext: HubContext())
    let router = Router()
    router.resetForAuthStatus(.unauthenticated)
    return ContentView()
        .environment(appState)
        .environment(router)
}

#Preview("Content View - Locked") {
    let appState = AppState(hubContext: HubContext())
    let router = Router()
    router.resetForAuthStatus(.locked)
    return ContentView()
        .environment(appState)
        .environment(router)
}
#endif
