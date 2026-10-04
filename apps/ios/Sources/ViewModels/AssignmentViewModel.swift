import Foundation

// MARK: - Volunteer suggestion model
// Suggestions decode to generated `SuggestAssigneesResponse` whose elements
// are generated `Suggestion` (packages/protocol/schemas/records.ts).

extension Suggestion: Identifiable {
    public var id: String { pubkey }
}

// MARK: - AssignmentViewModel

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
