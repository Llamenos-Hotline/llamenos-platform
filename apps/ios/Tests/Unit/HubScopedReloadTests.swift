import Foundation
import Testing
@testable import Llamenos

// MARK: - HubScopedReloadTests

/// Verifies that NotesViewModel uses hp() to route API requests through the active hub path,
/// and that switching hubs produces a different API path.
@MainActor
struct HubScopedReloadTests {

    @Test func loadNotesUsesActiveHubPath() async throws {
        let ctx = HubContext()
        ctx.setActiveHub("hub-uuid-001")
        let mockAPI = MockHubAPIService()
        mockAPI.activeHubId = ctx.activeHubId
        let vm = NotesViewModel(apiService: mockAPI, cryptoService: CryptoService())

        await vm.loadNotes()

        #expect(mockAPI.lastRequestPath?.contains("hub-uuid-001") == true)
        #expect(mockAPI.lastRequestPath?.hasPrefix("/api/hubs/hub-uuid-001/") == true)
        UserDefaults.standard.removeObject(forKey: "activeHubId")
    }

    @Test func hubChangeProducesNewApiPath() async throws {
        let ctx = HubContext()
        ctx.setActiveHub("hub-uuid-001")
        let mockAPI = MockHubAPIService()
        mockAPI.activeHubId = ctx.activeHubId
        let vm = NotesViewModel(apiService: mockAPI, cryptoService: CryptoService())

        await vm.loadNotes()
        let firstPath = mockAPI.lastRequestPath

        ctx.setActiveHub("hub-uuid-002")
        mockAPI.activeHubId = ctx.activeHubId
        await vm.loadNotes()
        let secondPath = mockAPI.lastRequestPath

        #expect(firstPath?.contains("hub-uuid-001") == true)
        #expect(secondPath?.contains("hub-uuid-002") == true)
        #expect(firstPath != secondPath)
        UserDefaults.standard.removeObject(forKey: "activeHubId")
    }
}
