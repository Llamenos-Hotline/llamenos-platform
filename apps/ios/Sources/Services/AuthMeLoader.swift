import Foundation
import os

// MARK: - AuthMeLoader

/// Loads the signed-in user's profile and permissions from `GET /api/auth/me`, and keeps
/// trying until the server gives an answer.
///
/// Only a server *answer* may change what the user can do. A 403 is an answer: the
/// permission set becomes empty. A timeout, a dropped connection, a 5xx, a 401 (the auth
/// layer reports "could not check" as 401 while the database is down, #2173) or an
/// undecodable body is not — it says nothing about the user's authority, so the last
/// known permissions stay in force, the failure is surfaced through
/// `PermissionService.refreshFailure`, and the request is retried with backoff.
///
/// The old behaviour answered every failure by presenting the user as a volunteer with
/// no permissions, so one wobbling request took admin UI away from an admin mid-shift.
@MainActor
final class AuthMeLoader {

    /// What a refresh settled on. There is no "failed" case: failures are retried.
    enum Outcome {
        /// The server answered; its permissions are now in the `PermissionService`.
        case loaded(AuthMeResponse)
        /// The server answered 403: this user holds no permissions. Applied.
        case denied
        /// Superseded by `cancel()` or a newer `refresh()`; nothing was applied.
        case cancelled
    }

    private static let log = Logger(subsystem: "org.llamenos.hotline", category: "AuthMe")

    private let apiService: APIService
    private let permissionService: PermissionService

    /// Waits between failed attempts; the last one repeats.
    private let retryDelays: [Duration]

    /// Bumped by every `refresh()` and `cancel()` so a superseded loop applies nothing.
    private var generation = 0

    init(
        apiService: APIService,
        permissionService: PermissionService,
        retryDelays: [Duration] = [.seconds(2), .seconds(5), .seconds(15), .seconds(30), .seconds(60)]
    ) {
        self.apiService = apiService
        self.permissionService = permissionService
        self.retryDelays = retryDelays
    }

    /// Abandon any refresh in flight (lock, logout). Permissions are left as they are.
    func cancel() {
        generation += 1
    }

    /// Ask the server who this user is, retrying until it answers.
    func refresh() async -> Outcome {
        generation += 1
        let mine = generation
        var failures = 0
        while !Task.isCancelled, mine == generation {
            do {
                let response: AuthMeResponse = try await apiService.request(method: "GET", path: "/api/auth/me")
                guard mine == generation else { return .cancelled }
                permissionService.update(permissions: response.permissions ?? [])
                return .loaded(response)
            } catch is CancellationError {
                return .cancelled
            } catch {
                guard mine == generation else { return .cancelled }
                if Self.isAnswerDenyingAccess(error) {
                    permissionService.update(permissions: [])
                    return .denied
                }
                permissionService.recordRefreshFailure()
                Self.log.error("Permission refresh failed (attempt \(failures + 1)): \(error.localizedDescription, privacy: .public)")
                let delay = retryDelays.isEmpty ? .seconds(60) : retryDelays[min(failures, retryDelays.count - 1)]
                failures += 1
                do { try await Task.sleep(for: delay) } catch { return .cancelled }
            }
        }
        return .cancelled
    }

    /// A 403 is the one failure that is an answer about the user's authority.
    static func isAnswerDenyingAccess(_ error: Error) -> Bool {
        if case APIError.requestFailed(let status, _) = error { return status == 403 }
        return false
    }
}
