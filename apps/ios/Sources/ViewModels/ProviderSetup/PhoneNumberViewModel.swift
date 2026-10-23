import Foundation

// MARK: - PhoneNumberViewModel

/// `@MainActor` (#1920 audit): SwiftUI reads this `@Observable` state on the main thread,
/// so every write has to land there too. Unisolated, each `async` method ran on the global
/// executor under Swift 5.9 and wrote state from a GCD worker mid-render — the data race
/// Thread Sanitizer reported in #1918, #2049 and #1811. Network calls still suspend off the
/// main thread inside the API layer; only the state changes are pinned here.
@MainActor
@Observable
final class PhoneNumberViewModel {
    private let service: ProviderSetupService
    private let hubContext: HubContext

    var ownedNumbers: [OwnedNumber] = []
    var searchResults: [AvailableNumber] = []
    var selectedNumber: OwnedNumber?
    var isLoadingOwned: Bool = false
    var isSearching: Bool = false
    var isProvisioning: Bool = false
    var error: String?

    /// Search form inputs
    var searchCountry: String = "US"
    var searchAreaCode: String = ""

    var hubId: String? { hubContext.activeHubId }

    init(service: ProviderSetupService, hubContext: HubContext) {
        self.service = service
        self.hubContext = hubContext
    }

    // MARK: - Actions

    func loadOwnedNumbers(provider: SharedProviderType) async {
        isLoadingOwned = true
        error = nil
        defer { isLoadingOwned = false }
        do {
            ownedNumbers = try await service.listPhoneNumbers(provider: provider, hubId: hubId)
        } catch {
            self.error = error.localizedDescription
        }
    }

    func searchNumbers(provider: SharedProviderType) async {
        isSearching = true
        error = nil
        searchResults = []
        defer { isSearching = false }
        do {
            let query = NumberSearchQuery(
                areaCode: searchAreaCode.isEmpty ? nil : searchAreaCode,
                capabilities: nil,
                contains: nil,
                countryCode: searchCountry,
                limit: 20,
                providerType: provider
            )
            searchResults = try await service.searchPhoneNumbers(query: query)
        } catch {
            self.error = error.localizedDescription
        }
    }

    func provision(phoneNumber: String, provider: SharedProviderType) async -> OwnedNumber? {
        isProvisioning = true
        error = nil
        defer { isProvisioning = false }
        do {
            let request = NumberProvisionRequest(
                autoConfigureWebhooks: true,
                friendlyName: nil,
                hubID: hubId,
                phoneNumber: phoneNumber,
                providerType: provider
            )
            let number = try await service.provisionPhoneNumber(request: request)
            ownedNumbers.append(number)
            selectedNumber = number
            return number
        } catch {
            self.error = error.localizedDescription
            return nil
        }
    }

    func selectOwned(_ number: OwnedNumber) {
        selectedNumber = number
    }
}
