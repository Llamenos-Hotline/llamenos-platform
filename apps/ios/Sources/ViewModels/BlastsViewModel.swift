import Foundation

// MARK: - BlastsViewModel

/// `@MainActor` (#1920 audit): SwiftUI reads this `@Observable` state on the main thread,
/// so every write has to land there too. Unisolated, each `async` method ran on the global
/// executor under Swift 5.9 and wrote state from a GCD worker mid-render — the data race
/// Thread Sanitizer reported in #1918, #2049 and #1811. Network calls still suspend off the
/// main thread inside the API layer; only the state changes are pinned here.
@MainActor
@Observable
final class BlastsViewModel {
    private let apiService: APIService

    var blasts: [AppBlast] = []
    var subscriberStats: BlastSubscriberStats?
    var isLoading = false
    var isSending = false
    var errorMessage: String?
    var showCreateSheet = false

    init(apiService: APIService) {
        self.apiService = apiService
    }

    // MARK: - Load Blasts

    func loadBlasts() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil

        do {
            let response: AppBlastsListResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/blasts")
            )
            blasts = response.blasts
        } catch {
            if blasts.isEmpty {
                errorMessage = error.localizedDescription
            }
        }

        isLoading = false
    }

    // MARK: - Load Subscriber Stats

    func loadSubscriberStats() async {
        do {
            subscriberStats = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/blasts/subscribers/stats")
            )
        } catch {
            // Non-critical — stats may not be available
        }
    }

    // MARK: - Create Blast

    func createBlast(name: String, message: String, channels: [String]) async -> Bool {
        isSending = true
        defer { isSending = false }

        do {
            let channelContent = Dictionary(uniqueKeysWithValues: channels.map { ($0, message) })
            let body = CreateBlastRequest(
                name: name,
                content: ["en": channelContent],
                targetChannels: channels,
                targetTags: [],
                targetLanguages: ["en"]
            )
            let _: AppBlast = try await apiService.request(
                method: "POST",
                path: apiService.hp("/api/blasts"),
                body: body
            )
            await loadBlasts()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    // MARK: - Send Blast

    func sendBlast(id: String) async {
        isSending = true
        defer { isSending = false }

        do {
            let _: EmptyResponse = try await apiService.request(
                method: "POST",
                path: apiService.hp("/api/blasts/\(id)/send")
            )
            await loadBlasts()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Schedule Blast

    func scheduleBlast(id: String, at date: Date) async {
        isSending = true
        defer { isSending = false }

        do {
            let body = ScheduleBlastRequest(scheduledAt: ISO8601DateFormatter().string(from: date))
            let _: EmptyResponse = try await apiService.request(
                method: "POST",
                path: apiService.hp("/api/blasts/\(id)/schedule"),
                body: body
            )
            await loadBlasts()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Refresh

    func refresh() async {
        await loadBlasts()
        await loadSubscriberStats()
    }
}
