import Foundation
import UIKit

/// View model for user-facing erasure request lifecycle.
///
/// `@MainActor` (#1920 audit): SwiftUI reads this `@Observable` state on the main thread,
/// so every write has to land there too. Unisolated, each `async` method ran on the global
/// executor under Swift 5.9 and wrote state from a GCD worker mid-render — the data race
/// Thread Sanitizer reported in #1918, #2049 and #1811. Network calls still suspend off the
/// main thread inside the API layer; only the state changes are pinned here.
@MainActor
@Observable
final class ErasureViewModel {
    private let apiService: APIService

    // MARK: - State

    /// Current erasure request status, nil if no active request.
    var activeRequest: AppErasureRequest?

    /// Whether the request is loading.
    var isLoading: Bool = false

    /// Whether a mutation (create/cancel) is in progress.
    var isMutating: Bool = false

    /// Error from last operation.
    var errorMessage: String?

    /// Success message.
    var successMessage: String?

    /// Show the confirmation dialog for requesting erasure.
    var showRequestConfirmation: Bool = false

    /// Show the confirmation dialog for cancelling erasure.
    var showCancelConfirmation: Bool = false

    // MARK: - Init

    init(apiService: APIService) {
        self.apiService = apiService
    }

    // MARK: - API

    /// Check current erasure request status.
    func loadStatus() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil

        do {
            let response: ErasureStatusResponse = try await apiService.request(
                method: "GET",
                path: "/api/erasure/me"
            )
            activeRequest = response.request
        } catch APIError.requestFailed(let statusCode, _) where statusCode == 404 {
            // 404 means no active request — that's fine
            activeRequest = nil
        } catch {
            errorMessage = error.localizedDescription
            activeRequest = nil
        }

        isLoading = false
    }

    /// Request account erasure.
    func requestErasure() async {
        isMutating = true
        errorMessage = nil
        successMessage = nil

        do {
            let response: ErasureStatusResponse = try await apiService.request(
                method: "POST",
                path: "/api/erasure/me"
            )
            activeRequest = response.request

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.warning)

            successMessage = NSLocalizedString(
                "erasure_status_scheduled",
                comment: "Erasure scheduled"
            )
        } catch {
            errorMessage = error.localizedDescription
        }

        isMutating = false
    }

    /// Cancel a pending erasure request.
    func cancelErasure() async {
        isMutating = true
        errorMessage = nil
        successMessage = nil

        do {
            try await apiService.request(
                method: "DELETE",
                path: "/api/erasure/me"
            )
            activeRequest = nil

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            successMessage = NSLocalizedString(
                "erasure_status_cancelled",
                comment: "Erasure cancelled"
            )
        } catch {
            errorMessage = error.localizedDescription
        }

        isMutating = false
    }

    // MARK: - Countdown

    /// Time remaining until erasure executes (nil if no active request).
    var timeRemaining: TimeInterval? {
        guard let request = activeRequest,
              let executeAt = request.executeAt else { return nil }
        let remaining = executeAt.timeIntervalSinceNow
        return remaining > 0 ? remaining : 0
    }
}

// MARK: - Models

struct AppErasureRequest: Codable, Sendable {
    let id: String
    let status: String
    let requestedAt: Date?
    let executeAt: Date?

    var statusDisplay: String {
        switch status {
        case "pending": return NSLocalizedString("erasure_status_pending", comment: "Pending")
        case "scheduled": return NSLocalizedString("erasure_status_scheduled", comment: "Scheduled")
        case "executing": return NSLocalizedString("erasure_status_executing", comment: "Executing")
        case "completed": return NSLocalizedString("erasure_status_completed", comment: "Completed")
        case "cancelled": return NSLocalizedString("erasure_status_cancelled", comment: "Cancelled")
        default: return status
        }
    }
}

struct ErasureStatusResponse: Codable, Sendable {
    let request: AppErasureRequest?
}
