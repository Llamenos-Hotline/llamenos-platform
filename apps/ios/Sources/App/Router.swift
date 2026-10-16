import SwiftUI

// MARK: - Route

/// All navigable destinations in the app.
enum Route: Hashable {
    /// Login screen: hub URL entry, create identity or link device.
    case login
    /// PIN set: user creates a new PIN (generates device keys atomically).
    case pinSet
    /// PIN unlock: user enters their PIN to unlock stored identity.
    case pinUnlock
    /// Main dashboard: shift status, active calls, recent notes.
    case dashboard
    /// Note detail view: full decrypted note.
    case noteDetail(id: String)
    /// Note creation form.
    case noteCreate
    /// Conversations list.
    case conversations
    /// Conversation detail: messages in a single conversation.
    case conversationDetail(id: String)
    /// Reports list.
    case reports
    /// Report detail view.
    case reportDetail(id: String)
    /// Contacts list (admin only).
    case contacts
    /// Contact timeline detail.
    case contactTimeline(hash: String, displayIdentifier: String)
    /// Message blasts (admin only).
    case blasts
    /// Call history list.
    case callHistory
    /// Call detail view.
    case callDetail(id: String)
    /// Cases list.
    case cases
    /// Case detail view.
    case caseDetail(id: String)
    /// Notes list (deep link target).
    case notes
    /// Settings screen (deep link target).
    case settings
    /// Admin management screens.
    case admin
}

// MARK: - Router

/// Navigation coordinator using `@Observable`. Manages a navigation stack path
/// and provides methods for common navigation transitions. The router observes
/// the AppState's auth status and resets the stack when the auth state changes
/// (e.g., lock → unlock, logout).
@Observable
final class Router {
    /// The current navigation path for NavigationStack.
    var path: [Route] = []

    /// The root route, determined by auth status. Not part of the path stack.
    var rootRoute: Route = .login

    // MARK: - Navigation

    /// Push a new route onto the navigation stack.
    func navigate(to route: Route) {
        path.append(route)
    }

    /// Pop the top route from the stack.
    func goBack() {
        if !path.isEmpty {
            path.removeLast()
        }
    }

    /// Pop to the root of the navigation stack.
    func popToRoot() {
        path.removeAll()
    }

    /// Replace the entire stack with a single route.
    func replaceStack(with route: Route) {
        path = [route]
    }

    /// Reset navigation to match the current auth status.
    func resetForAuthStatus(_ status: AuthStatus) {
        path.removeAll()
        switch status {
        case .unauthenticated:
            rootRoute = .login
        case .locked:
            rootRoute = .pinUnlock
        case .unlocked:
            rootRoute = .dashboard
        }
    }

    // MARK: - Auth Flow Navigation

    /// Navigate to PIN set (creates device keys atomically with PIN encryption).
    func showPINSet() {
        navigate(to: .pinSet)
    }

    /// Navigate to dashboard after successful unlock or onboarding.
    func showDashboard() {
        popToRoot()
        rootRoute = .dashboard
    }

    /// Navigate to PIN unlock (e.g., after background lock).
    func showPINUnlock() {
        popToRoot()
        rootRoute = .pinUnlock
    }

    /// Navigate to login (e.g., after logout).
    func showLogin() {
        popToRoot()
        rootRoute = .login
    }
}
