import Foundation

// MARK: - ShiftClockService

/// Clock-in / clock-out against one hub's active-shift roster.
///
/// The backend keys clock state by (pubkey, hubId) and reads the hub from the
/// `/api/hubs/{hubId}/shifts/...` path. Every call here names its hub explicitly and
/// never goes through `APIService.hp(_:)`: `hp` falls back to the unscoped path when no
/// hub is active, and on the unscoped path the backend resolves the hub to `""` —
/// recording a clock-in that no hub's `/shifts/active` roster can see (#1241, the same
/// defect Android's `ShiftClockRepository` fixed in #1216).
///
/// Clocked-in state is held per hub, so switching the active hub (browsing context)
/// never loses or alters this device's shift state in any other member hub.
@Observable
final class ShiftClockService {
    private let apiService: APIService

    /// hubId → when this device clocked in to that hub.
    private(set) var clockedInHubs: [String: Date] = [:]

    init(apiService: APIService) {
        self.apiService = apiService
    }

    /// Whether this device is clocked in to the given hub.
    func isClockedIn(to hubId: String) -> Bool {
        clockedInHubs[hubId] != nil
    }

    /// When this device clocked in to the given hub, if it is.
    func clockedInAt(for hubId: String) -> Date? {
        clockedInHubs[hubId]
    }

    /// Clock in to `hubId`. Clocking in again is idempotent server-side and keeps the
    /// original start, so a stale local start is only ever set once.
    func clockIn(hubId: String) async throws {
        let _: OkResponse = try await apiService.request(
            method: "POST",
            path: APIService.hubPath(hubId, "/api/shifts/clock-in")
        )
        if clockedInHubs[hubId] == nil {
            clockedInHubs[hubId] = Date()
        }
    }

    /// Clock out of `hubId`. The backend answers 404 when it holds no active shift for
    /// this user in the hub — the requested end state already holds, so that is success.
    func clockOut(hubId: String) async throws {
        do {
            let _: OkResponse = try await apiService.request(
                method: "POST",
                path: APIService.hubPath(hubId, "/api/shifts/clock-out")
            )
        } catch APIError.requestFailed(let statusCode, _) where statusCode == 404 {
            // Already clocked out server-side — the end state the caller asked for.
        }
        clockedInHubs[hubId] = nil
    }
}
