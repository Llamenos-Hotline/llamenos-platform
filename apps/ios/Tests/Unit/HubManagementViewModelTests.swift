import Foundation
import Testing
@testable import Llamenos

// MARK: - Mock Doubles

/// Closure-based mock conforming to HubAPIServiceProtocol.
/// APIService is final, so we use the narrow protocol for injection.
final class MockHubAPIService: HubAPIServiceProtocol {
    var hubKeyResult: Result<HubKeyEnvelopeResponse, Error>?
    /// Stub for request<T> — set to a closure returning any Decodable for loadHubs/createHub tests.
    var requestStub: ((String, String) throws -> Any)?
    /// The path from the most recent request<T> call — used to assert hub-scoped routing.
    var lastRequestPath: String?
    /// Active hub ID used by hp() to prefix paths.
    var activeHubId: String?

    func getHubKey(_ hubId: String) async throws -> HubKeyEnvelopeResponse {
        switch hubKeyResult {
        case .success(let response):
            return response
        case .failure(let error):
            throw error
        case nil:
            // Return a valid stub envelope by default
            // HubKeyEnvelopeResponse is generated in packages/protocol/generated/swift/Types.swift
            return HubKeyEnvelopeResponse(
                envelope: SharedAdminEnvelope(
                    ct: "ddeeff",
                    enc: "112233",
                    pubkey: "aabbcc"
                )
            )
        }
    }

    func hp(_ path: String) -> String {
        guard let hubId = activeHubId else { return path }
        return APIService.hubPath(hubId, path)
    }

    func request<T: Decodable>(method: String, path: String, body: (any Encodable)?) async throws -> T {
        lastRequestPath = path
        if let stub = requestStub, let result = try stub(method, path) as? T {
            return result
        }
        throw URLError(.unsupportedURL)
    }
}

/// State-tracking mock conforming to HubCryptoServiceProtocol.
/// CryptoService is final, so we use the narrow protocol for injection.
final class MockHubCryptoService: HubCryptoServiceProtocol {
    var hasHubKeyResult: Bool = true
    var loadedHubKeyId: String?
    var loadHubKeyError: Error?

    func hasHubKey(hubId: String) -> Bool { hasHubKeyResult }

    func loadHubKey(hubId: String, envelope: HubKeyEnvelopeResponse) throws {
        if let error = loadHubKeyError { throw error }
        loadedHubKeyId = hubId
    }
}

// MARK: - Helper

private func makeHub(id: String, slug: String = "test-hub") -> SharedHub {
    SharedHub(
        createdAt: "2026-01-01T00:00:00Z",
        createdBy: "pub001",
        description: nil,
        id: id,
        name: "Test Hub",
        phoneNumber: nil,
        slug: slug,
        status: .active,
        updatedAt: "2026-01-01T00:00:00Z"
    )
}

// MARK: - Tests

@MainActor
struct HubManagementViewModelTests {

    // MARK: isActive

    @Test func isActiveReturnsTrueForActiveHub() {
        let ctx = HubContext()
        ctx.setActiveHub("hub-uuid-001")
        let vm = HubManagementViewModel(
            apiService: MockHubAPIService(),
            cryptoService: MockHubCryptoService(),
            hubContext: ctx
        )
        let hub = makeHub(id: "hub-uuid-001", slug: "hub-a")
        #expect(vm.isActive(hub) == true)
        UserDefaults.standard.removeObject(forKey: "activeHubId")
    }

    @Test func isActiveReturnsFalseForInactiveHub() {
        let ctx = HubContext()
        ctx.setActiveHub("hub-uuid-001")
        let vm = HubManagementViewModel(
            apiService: MockHubAPIService(),
            cryptoService: MockHubCryptoService(),
            hubContext: ctx
        )
        let hub = makeHub(id: "hub-uuid-002", slug: "hub-b")
        #expect(vm.isActive(hub) == false)
        UserDefaults.standard.removeObject(forKey: "activeHubId")
    }

    // MARK: switchHub — success path

    @Test func switchHubUpdatesHubContextOnSuccess() async {
        let ctx = HubContext()
        let mockAPI = MockHubAPIService()
        let mockCrypto = MockHubCryptoService()
        mockCrypto.hasHubKeyResult = false   // force key fetch

        let vm = HubManagementViewModel(
            apiService: mockAPI,
            cryptoService: mockCrypto,
            hubContext: ctx
        )
        let hub = makeHub(id: "hub-uuid-002", slug: "new-hub")
        await vm.switchHub(to: hub)

        #expect(ctx.activeHubId == "hub-uuid-002")
        #expect(mockCrypto.loadedHubKeyId == "hub-uuid-002")
        #expect(vm.isSwitching == false)
        #expect(vm.error == nil)
        UserDefaults.standard.removeObject(forKey: "activeHubId")
    }

    // MARK: switchHub — failure path

    @Test func switchHubDoesNotUpdateContextOnKeyFetchFailure() async {
        let ctx = HubContext()
        ctx.setActiveHub("hub-uuid-001")

        let mockAPI = MockHubAPIService()
        mockAPI.hubKeyResult = .failure(URLError(.badServerResponse))

        let mockCrypto = MockHubCryptoService()
        mockCrypto.hasHubKeyResult = false  // force key fetch so error triggers

        let vm = HubManagementViewModel(
            apiService: mockAPI,
            cryptoService: mockCrypto,
            hubContext: ctx
        )
        let hub = makeHub(id: "hub-uuid-002", slug: "new-hub")
        await vm.switchHub(to: hub)

        #expect(ctx.activeHubId == "hub-uuid-001")
        #expect(mockCrypto.loadedHubKeyId == nil)
        #expect(vm.isSwitching == false)
        #expect(vm.error != nil)
        UserDefaults.standard.removeObject(forKey: "activeHubId")
    }
}
