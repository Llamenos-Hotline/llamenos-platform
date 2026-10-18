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

        // loadNotes() fires its notes and custom-fields fetches concurrently, so assert
        // on every request rather than on whichever one happened to land last.
        let paths = mockAPI.requestedPaths
        #expect(!paths.isEmpty)
        #expect(paths.allSatisfy { $0.hasPrefix("/api/hubs/hub-uuid-001/") })
        UserDefaults.standard.removeObject(forKey: "activeHubId")
    }

    @Test func hubChangeProducesNewApiPath() async throws {
        let ctx = HubContext()
        ctx.setActiveHub("hub-uuid-001")
        let mockAPI = MockHubAPIService()
        mockAPI.activeHubId = ctx.activeHubId
        let vm = NotesViewModel(apiService: mockAPI, cryptoService: CryptoService())

        await vm.loadNotes()
        let firstPaths = mockAPI.requestedPaths

        ctx.setActiveHub("hub-uuid-002")
        mockAPI.activeHubId = ctx.activeHubId
        mockAPI.resetRequestedPaths()
        await vm.loadNotes()
        let secondPaths = mockAPI.requestedPaths

        #expect(!firstPaths.isEmpty)
        #expect(!secondPaths.isEmpty)
        #expect(firstPaths.allSatisfy { $0.hasPrefix("/api/hubs/hub-uuid-001/") })
        #expect(secondPaths.allSatisfy { $0.hasPrefix("/api/hubs/hub-uuid-002/") })
        #expect(Set(firstPaths).isDisjoint(with: secondPaths))
        UserDefaults.standard.removeObject(forKey: "activeHubId")
    }
}
