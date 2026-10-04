import Foundation
import Testing
@testable import Llamenos

// MARK: - MockLinphoneService

/// Test double for LinphoneServiceProtocol that records registration calls without
/// touching any real SIP or Linphone state.
final class MockLinphoneService: LinphoneServiceProtocol {
    private(set) var registeredHubIds: [String] = []
    private(set) var unregisteredHubIds: [String] = []
    var shouldThrowOnRegister: Bool = false

    func registerHubAccount(hubId: String, sipParams: SIPTokenResponse) throws {
        if shouldThrowOnRegister {
            throw LinphoneError.accountRegistrationFailed("mock error")
        }
        registeredHubIds.append(hubId)
    }

    func unregisterHubAccount(hubId: String) {
        unregisteredHubIds.append(hubId)
    }

    func handleVoipPush(callId: String, hubId: String) {
        // Not exercised in ShiftsViewModel tests
    }
}

// MARK: - ShiftViewModelLinphoneTests

/// Tests that ShiftsViewModel correctly integrates with LinphoneService on clock in/out.
/// Uses MockLinphoneService to verify SIP registration calls without network or Linphone Core.
@MainActor
struct ShiftViewModelLinphoneTests {

    // Creates a ShiftsViewModel wired with the given mock, using a stub APIService and HubContext.
    private func makeViewModel(
        mock: MockLinphoneService,
        hubId: String? = "hub-uuid-001"
    ) -> (ShiftsViewModel, HubContext) {
        let hubContext = HubContext()
        if let hubId {
            hubContext.setActiveHub(hubId)
        }
        let crypto = CryptoService()
        let api = APIService(cryptoService: crypto, hubContext: hubContext)
        let vm = ShiftsViewModel(
            apiService: api,
            cryptoService: crypto,
            hubContext: hubContext,
            linphoneService: mock
        )
        return (vm, hubContext)
    }

    @Test func shiftStartRegistersLinphoneAccountForHub() async throws {
        let mock = MockLinphoneService()
        let (vm, _) = makeViewModel(mock: mock)
        await vm.onShiftStarted(
            hubId: "hub-uuid-001",
            sipParams: SIPTokenResponse(
                domain: "sip.example.org", encryption: nil, iceServers: nil,
                password: "secret", transport: "tls", username: "testuser"
            )
        )
        #expect(mock.registeredHubIds == ["hub-uuid-001"])
    }

    @Test func shiftEndUnregistersLinphoneAccountForHub() {
        let mock = MockLinphoneService()
        let (vm, _) = makeViewModel(mock: mock)
        vm.onShiftEnded(hubId: "hub-uuid-001")
        #expect(mock.unregisteredHubIds == ["hub-uuid-001"])
    }

    @Test func multipleHubsRegisteredAndUnregisteredIndependently() async throws {
        let mock = MockLinphoneService()
        let (vm, _) = makeViewModel(mock: mock)
        let params = SIPTokenResponse(
            domain: "sip.example.org", encryption: nil, iceServers: nil,
            password: "pass", transport: "tls", username: "user"
        )
        await vm.onShiftStarted(hubId: "hub-aaa", sipParams: params)
        await vm.onShiftStarted(hubId: "hub-bbb", sipParams: params)
        vm.onShiftEnded(hubId: "hub-aaa")
        #expect(mock.registeredHubIds == ["hub-aaa", "hub-bbb"])
        #expect(mock.unregisteredHubIds == ["hub-aaa"])
    }

    @Test func shiftStartSilentlyHandlesLinphoneRegistrationError() async {
        let mock = MockLinphoneService()
        mock.shouldThrowOnRegister = true
        let (vm, _) = makeViewModel(mock: mock)
        // Should not throw — errors are logged, not surfaced to the caller
        await vm.onShiftStarted(
            hubId: "hub-uuid-001",
            sipParams: SIPTokenResponse(
                domain: "sip.example.org", encryption: nil, iceServers: nil,
                password: "pass", transport: "tls", username: "user"
            )
        )
        #expect(mock.registeredHubIds.isEmpty)
    }
}
