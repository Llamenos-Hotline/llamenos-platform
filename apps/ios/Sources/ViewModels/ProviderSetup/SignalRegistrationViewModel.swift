import Foundation

// MARK: - SignalRegistrationViewModel

/// `@MainActor` (#1920 audit): SwiftUI reads this `@Observable` state on the main thread,
/// so every write has to land there too. Unisolated, each `async` method ran on the global
/// executor under Swift 5.9 and wrote state from a GCD worker mid-render — the data race
/// Thread Sanitizer reported in #1918, #2049 and #1811. Network calls still suspend off the
/// main thread inside the API layer; only the state changes are pinned here.
@MainActor
@Observable
final class SignalRegistrationViewModel {
    private let service: ProviderSetupService
    private let hubContext: HubContext

    var state: SignalRegistrationState?
    var isRegistering: Bool = false
    var verificationCode: String = ""
    var isVerifying: Bool = false
    var isUnregistering: Bool = false
    var error: String?

    /// Registration form inputs
    var bridgeURL: String = ""
    var bridgeAPIKey: String = ""
    var phoneNumber: String = ""
    var useVoice: Bool = false

    /// Exempt from main-actor isolation only so the nonisolated `deinit` can cancel it:
    /// a `Task` handle is `Sendable` and `cancel()` is thread-safe, every other read and
    /// write happens on the main actor, and `deinit` runs once the last reference is
    /// gone, so nothing can race it. Not observed — no view reads it.
    @ObservationIgnored nonisolated(unsafe) private var pollingTask: Task<Void, Never>?

    var hubId: String? { hubContext.activeHubId }

    init(service: ProviderSetupService, hubContext: HubContext) {
        self.service = service
        self.hubContext = hubContext
    }

    deinit {
        pollingTask?.cancel()
    }

    // MARK: - Computed

    var isPending: Bool {
        state?.status == .pending || state?.status == .registering
    }

    var isComplete: Bool {
        state?.status == .registered
    }

    var isFailed: Bool {
        state?.status == .failed || state?.status == .expired
    }

    var formValid: Bool {
        !bridgeURL.isEmpty && !bridgeAPIKey.isEmpty && !phoneNumber.isEmpty
    }

    // MARK: - Actions

    func startRegistration() async {
        guard formValid else {
            error = NSLocalizedString("signal_registration_incomplete_form", comment: "Fill in all required fields")
            return
        }
        isRegistering = true
        error = nil
        defer { isRegistering = false }
        do {
            let body = SignalRegisterBody(
                bridgeAPIKey: bridgeAPIKey,
                bridgeURL: bridgeURL,
                captcha: nil,
                phoneNumber: phoneNumber,
                useVoice: useVoice
            )
            state = try await service.startSignalRegistration(body: body, hubId: hubId)
            startPolling()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func checkStatus() async {
        do {
            state = try await service.getSignalStatus(hubId: hubId)
            if !isPending {
                pollingTask?.cancel()
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    func verifyCode() async {
        guard let registrationId = state?.id, !verificationCode.isEmpty else { return }
        isVerifying = true
        error = nil
        defer { isVerifying = false }
        pollingTask?.cancel()
        do {
            state = try await service.verifySignalCode(registrationId: registrationId, code: verificationCode)
        } catch {
            self.error = error.localizedDescription
            // Resume polling so the UI reflects updated state
            startPolling()
        }
    }

    func unregister() async {
        guard let registrationId = state?.id else { return }
        isUnregistering = true
        error = nil
        pollingTask?.cancel()
        defer { isUnregistering = false }
        do {
            try await service.unregisterSignal(registrationId: registrationId, hubId: hubId)
            state = nil
            verificationCode = ""
        } catch {
            self.error = error.localizedDescription
        }
    }

    func loadExistingState() async {
        do {
            state = try await service.getSignalStatus(hubId: hubId)
            if isPending {
                startPolling()
            }
        } catch {
            // No existing registration — that's fine
        }
    }

    // MARK: - Polling

    private func startPolling() {
        pollingTask?.cancel()
        pollingTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled else { return }
                await self.checkStatus()
                if !self.isPending { return }
            }
        }
    }
}
