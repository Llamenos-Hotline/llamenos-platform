import Foundation

// MARK: - Volunteer suggestion model
// Suggestions decode to generated `SuggestAssigneesResponse` whose elements
// are generated `Suggestion` (packages/protocol/schemas/records.ts).

extension Suggestion: Identifiable {
    public var id: String { pubkey }
}

// MARK: - AssignmentViewModel

/// `@MainActor` (#1920 audit): SwiftUI reads this `@Observable` state on the main thread,
/// so every write has to land there too. Unisolated, each `async` method ran on the global
/// executor under Swift 5.9 and wrote state from a GCD worker mid-render — the data race
/// Thread Sanitizer reported in #1918, #2049 and #1811. Network calls still suspend off the
/// main thread inside the API layer; only the state changes are pinned here.
@MainActor
@Observable
final class AssignmentViewModel {
    private let apiService: APIService

    var suggestions: [Suggestion] = []
    var isLoading = false
    var isAssigning = false
    var errorMessage: String?

    init(apiService: APIService) {
        self.apiService = apiService
    }

    func loadSuggestions(for recordId: String, language: String? = nil) async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        do {
            var path = apiService.hp("/api/records/\(recordId)/suggest-assignees")
            if let lang = language {
                path += "?language=\(lang)"
            }
            let response: SuggestAssigneesResponse = try await apiService.request(method: "GET", path: path)
            suggestions = response.suggestions
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    func assign(recordId: String, pubkey: String) async -> Bool {
        isAssigning = true
        errorMessage = nil
        do {
            let body = ["pubkeys": [pubkey]]
            let _: SharedRecordListResponseRecord = try await apiService.request(
                method: "POST",
                path: apiService.hp("/api/records/\(recordId)/assign"),
                body: body
            )
            isAssigning = false
            return true
        } catch {
            errorMessage = error.localizedDescription
            isAssigning = false
            return false
        }
    }
}
