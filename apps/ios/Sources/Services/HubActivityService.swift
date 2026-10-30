import Foundation

// MARK: - HubActivityState

/// Per-hub live activity state reflecting the latest relay events for that hub.
struct HubActivityState: Equatable {
    /// Number of active (ringing or in-progress) calls for this hub.
    var activeCallCount: Int = 0
    /// Number of unread messages for this hub since last opened.
    var unreadMessageCount: Int = 0
    /// Number of unread/unactioned conversation assignments for this hub since last opened.
    var unreadConversationCount: Int = 0
}

// MARK: - HubActivityService

/// Tracks per-hub live activity state driven by `AttributedHubEvent` events from
/// `WebSocketService.attributedEvents`. Each hub's state is maintained independently,
/// allowing the UI to display per-hub badges and indicators in a multi-hub list.
///
/// Thread-safe via `NSLock`. State mutations are lock-protected; reads return a
/// value-type copy so callers never hold a reference into the internal map.
///
/// Wire into `AppState` by consuming `webSocketService.attributedEvents` in a
/// background task and calling `handle(_:)` for each event.
@Observable
final class HubActivityService {

    // MARK: - Private State

    private var states: [String: HubActivityState] = [:]
    private let stateLock = NSLock()

    // MARK: - Public API

    /// Returns the current activity state for the given hub ID.
    /// Returns a default zero state if no events have been received for that hub.
    func state(for hubId: String) -> HubActivityState {
        stateLock.lock()
        defer { stateLock.unlock() }
        return states[hubId] ?? HubActivityState()
    }

    /// Process a hub-attributed event and update the corresponding hub's state.
    func handle(_ attributed: AttributedHubEvent) {
        stateLock.lock()
        var s = states[attributed.hubId] ?? HubActivityState()

        switch attributed.event {
        case .callRing:
            s.activeCallCount += 1

        case .callAnswered:
            // A call being answered transitions it from ringing to in-progress.
            // Decrement ringing count; the call is now active but already counted.
            // Guard against going negative (e.g. on reconnect with missed ring event).
            s.activeCallCount = max(0, s.activeCallCount - 1)

        case .callEnded:
            s.activeCallCount = max(0, s.activeCallCount - 1)

        case .callUpdate:
            // Status update only — no count change.
            break

        case .shiftStarted, .shiftEnded, .shiftUpdate:
            // Shift state is not tracked here: whether the user is a ring target on a hub is
            // the server's answer (`ShiftClockService`), and a relay event only says that it
            // may have changed. A local flag flipped by these events was a second notion of
            // "on shift" that disagreed with the server (#2204).
            break

        case .messageNew:
            s.unreadMessageCount += 1

        case .messageStatus:
            // Delivery/read receipt — no unread count change.
            break

        case .conversationNew, .conversationAssigned:
            s.unreadConversationCount += 1

        case .conversationClosed:
            s.unreadConversationCount = max(0, s.unreadConversationCount - 1)

        case .conversationEnvelopesAdded:
            // Keys for messages already counted — no new conversation or message.
            break

        case .noteCreated, .voicemailNew, .presenceSummary, .presenceDetail, .deviceWipe, .hubIncident, .unknown:
            break
        }

        states[attributed.hubId] = s
        stateLock.unlock()
    }

    /// Mark a hub as opened, clearing its unread message and conversation counts.
    /// Call this when the user navigates into a hub's dashboard.
    func markHubOpened(_ hubId: String) {
        stateLock.lock()
        var s = states[hubId] ?? HubActivityState()
        s.unreadMessageCount = 0
        s.unreadConversationCount = 0
        states[hubId] = s
        stateLock.unlock()
    }
}
