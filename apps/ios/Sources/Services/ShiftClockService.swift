import Foundation

// MARK: - ShiftClockService

/// The volunteer's shift state per hub, as the server holds it, plus clock-in / clock-out.
///
/// Nothing here is a local notion of "on shift". Every hub's state is the server's
/// `GET /api/hubs/{hubId}/shifts/my-status` (`MyStatusResponse`: scheduled-now `onShift`,
/// `clockedIn`, `clockedInAt`), and `ShiftReadiness` combines that with the break flag the
/// same way the ring set does. The previous in-memory `hubId → Date` dictionary was set on
/// a successful clock-in and never loaded, so a relaunch showed "Off Shift" for a volunteer
/// the server was still ringing, while the dashboard — reading the scheduled-only `onShift`
/// — showed "On Shift" for one it was not (#2204, iOS counterpart of #2108).
///
/// The backend keys clock state by (pubkey, hubId) and reads the hub from the
/// `/api/hubs/{hubId}/shifts/...` path. Every call here names its hub explicitly and
/// never goes through `APIService.hp(_:)`: `hp` falls back to the unscoped path when no
/// hub is active, and on the unscoped path the backend resolves the hub to `""` —
/// recording a clock-in that no hub's `/shifts/active` roster can see (#1241, the same
/// defect Android's `ShiftClockRepository` fixed in #1216).
///
/// State is held per member hub — rings come from all of them — so switching the active
/// hub (browsing context) never loses or alters the state of any other hub.
///
/// `@MainActor` (#1920 audit): SwiftUI reads this `@Observable` state on the main thread,
/// so every write has to land there too. Unisolated, each `async` method ran on the global
/// executor under Swift 5.9 and wrote state from a GCD worker mid-render — the data race
/// Thread Sanitizer reported in #1918, #2049 and #1811. Network calls still suspend off the
/// main thread inside the API layer; only the state changes are pinned here.
@MainActor
@Observable
final class ShiftClockService {
    private let apiService: APIService

    /// hubId → the server's answer for this user in that hub. A hub whose request failed
    /// has no entry: unknown is shown as unknown, never as the last answer.
    private(set) var statuses: [String: MyStatusResponse] = [:]

    /// Whether the server has this user on break (`GET /api/auth/me` → `onBreak`). Global,
    /// not per hub: a break excludes the user from ringing everywhere.
    private(set) var onBreak: Bool = false

    init(apiService: APIService) {
        self.apiService = apiService
    }

    // MARK: - Reading state

    /// The readiness the server implies for `hubId`, or nil when it has not answered.
    func readiness(for hubId: String) -> ShiftReadiness? {
        statuses[hubId].map { ShiftReadiness(status: $0, onBreak: onBreak) }
    }

    /// The most informative readiness across `hubIds`, or nil when no hub has answered.
    func readiness(across hubIds: [String]) -> ShiftReadiness? {
        ShiftReadiness.best(of: hubIds.compactMap(readiness(for:)))
    }

    /// Whether the server holds an active-shift row for this user in `hubId`. This — not
    /// readiness — decides whether the screen offers Clock In or Clock Out.
    func isClockedIn(to hubId: String) -> Bool {
        statuses[hubId]?.clockedIn ?? false
    }

    /// When the server says this user clocked in to `hubId`.
    func clockedInAt(for hubId: String) -> Date? {
        statuses[hubId]?.clockedInAt.flatMap(DateFormatting.parseISO)
    }

    /// The earliest clock-in among the hubs in `hubIds` that are ringing this user.
    func readySince(across hubIds: [String]) -> Date? {
        hubIds
            .filter { readiness(for: $0)?.isRingTarget == true }
            .compactMap(clockedInAt(for:))
            .min()
    }

    // MARK: - Loading

    /// Ask the server for the state of every hub in `hubIds` (and the break flag).
    ///
    /// A hub that does not answer loses its entry, so the screen shows "unknown" rather
    /// than a stale answer the server may no longer hold. Returns the first failure, for
    /// callers that surface one; the others are not lost to the user, only to the return.
    @discardableResult
    func refresh(hubIds: [String]) async -> Error? {
        async let breakResult: Bool? = fetchOnBreak()
        let answers = await withTaskGroup(of: (hubId: String, result: Result<MyStatusResponse, Error>).self) { group in
            for hubId in hubIds {
                group.addTask { [apiService] in
                    (hubId, await Self.fetchStatus(apiService: apiService, hubId: hubId))
                }
            }
            var collected: [(hubId: String, result: Result<MyStatusResponse, Error>)] = []
            for await answer in group { collected.append(answer) }
            return collected
        }
        if let onBreak = await breakResult { self.onBreak = onBreak }

        var firstFailure: Error?
        for answer in answers {
            switch answer.result {
            case .success(let status):
                statuses[answer.hubId] = status
            case .failure(let error):
                statuses[answer.hubId] = nil
                firstFailure = firstFailure ?? error
            }
        }
        return firstFailure
    }

    /// Forget everything — on logout or wipe, so the next user never sees this one's state.
    func reset() {
        statuses = [:]
        onBreak = false
    }

    // MARK: - Clock in / out

    /// Clock in to `hubId`, then read back what the server now holds. Clocking in again is
    /// idempotent server-side and keeps the original start.
    func clockIn(hubId: String) async throws {
        let _: OkResponse = try await apiService.request(
            method: "POST",
            path: APIService.hubPath(hubId, "/api/shifts/clock-in")
        )
        await refresh(hubIds: [hubId])
    }

    /// Clock out of `hubId`, then read back what the server now holds. The backend answers
    /// 404 when it holds no active shift for this user in the hub — the requested end state
    /// already holds, so that is success.
    func clockOut(hubId: String) async throws {
        do {
            let _: OkResponse = try await apiService.request(
                method: "POST",
                path: APIService.hubPath(hubId, "/api/shifts/clock-out")
            )
        } catch APIError.requestFailed(let statusCode, _) where statusCode == 404 {
            // Already clocked out server-side — the end state the caller asked for.
        }
        await refresh(hubIds: [hubId])
    }

    // MARK: - Private

    private nonisolated static func fetchStatus(apiService: APIService, hubId: String) async -> Result<MyStatusResponse, Error> {
        do {
            let status: MyStatusResponse = try await apiService.request(
                method: "GET",
                path: APIService.hubPath(hubId, "/api/shifts/my-status")
            )
            return .success(status)
        } catch {
            return .failure(error)
        }
    }

    private func fetchOnBreak() async -> Bool? {
        let me: AuthMeResponse? = try? await apiService.request(method: "GET", path: "/api/auth/me")
        return me?.onBreak
    }
}
