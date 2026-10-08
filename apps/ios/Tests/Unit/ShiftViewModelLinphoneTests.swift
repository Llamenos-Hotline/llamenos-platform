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

    func registerHubAccount(hubId: String, sipParams: SipTokenResponse) throws {
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
        // From the server's recorded bytes. This test used to build
        // `SipTokenResponse(username:domain:password:transport:expiry:)` in Swift and
        // passed for the whole life of a model that could not decode a single real
        // response (#1659) — see `SipTokenFixture`.
        await vm.onShiftStarted(hubId: "hub-uuid-001", sipParams: try SipTokenFixture.token())
        #expect(mock.registeredHubIds == ["hub-uuid-001"])
        #expect(vm.sipRegistrationError == nil)
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
        let params = try SipTokenFixture.token()
        await vm.onShiftStarted(hubId: "hub-aaa", sipParams: params)
        await vm.onShiftStarted(hubId: "hub-bbb", sipParams: params)
        vm.onShiftEnded(hubId: "hub-aaa")
        #expect(mock.registeredHubIds == ["hub-aaa", "hub-bbb"])
        #expect(mock.unregisteredHubIds == ["hub-aaa"])
    }

    @Test func shiftStartRecordsARegistrationFailureInsteadOfDiscardingIt() async throws {
        // This test used to assert the opposite — that the error is swallowed — and that
        // is exactly how a volunteer ends up on shift, shown as clocked in, and
        // unreachable. `registerHubAccount` now refuses an unencryptable media leg and an
        // unverifiable TLS chain, so the refusal has to survive to somewhere observable.
        let mock = MockLinphoneService()
        mock.shouldThrowOnRegister = true
        let (vm, _) = makeViewModel(mock: mock)

        // Still does not throw: clock-in itself succeeded, and the shift stands.
        await vm.onShiftStarted(hubId: "hub-uuid-001", sipParams: try SipTokenFixture.token())

        #expect(mock.registeredHubIds.isEmpty)
        #expect(vm.sipRegistrationError != nil, "a volunteer who cannot be rung must not look registered")
    }

    @Test func aSucceedingRegistrationClearsAPreviousFailure() async throws {
        let mock = MockLinphoneService()
        mock.shouldThrowOnRegister = true
        let (vm, _) = makeViewModel(mock: mock)
        let params = try SipTokenFixture.token()
        await vm.onShiftStarted(hubId: "hub-uuid-001", sipParams: params)
        #expect(vm.sipRegistrationError != nil)

        mock.shouldThrowOnRegister = false
        await vm.onShiftStarted(hubId: "hub-uuid-001", sipParams: params)
        #expect(vm.sipRegistrationError == nil, "a stale failure would keep reporting a working shift as broken")
    }
}
