import Foundation

// MARK: - OnboardingStep

/// The wizard screens for hub communications onboarding.
///
/// `serverStep` is the step in `ONBOARDING_STEPS`
/// (apps/worker/services/provider-setup/hub-onboard.ts) that the screen
/// completes. The server drives progression and refuses a step that is not the
/// one it is currently on, so the wizard never invents its own step names.
///
/// Two screens have no server step of their own: `channelSetup` and `summary`
/// both review what has been chosen, and together they occupy the server's
/// final `channel_setup` step — `summary` is the screen that completes it.
/// `complete` is terminal.
enum OnboardingStep: String, CaseIterable, Identifiable {
    case template
    case channels
    case provider
    case phoneNumber
    case channelSetup
    case summary
    case complete

    var id: String { rawValue }

    var serverStep: String? {
        switch self {
        case .template: return "template_selection"
        case .channels: return "channel_selection"
        case .provider: return "provider_connection"
        case .phoneNumber: return "phone_number"
        case .channelSetup: return nil
        case .summary: return "channel_setup"
        case .complete: return nil
        }
    }

    /// The screen to show for a step the server reports as current.
    static func forServerStep(_ step: String) -> OnboardingStep? {
        switch step {
        case "template_selection": return .template
        case "channel_selection": return .channels
        case "provider_connection": return .provider
        case "phone_number": return .phoneNumber
        case "channel_setup": return .channelSetup
        case "completion": return .complete
        default: return nil
        }
    }

    var stepNumber: Int {
        switch self {
        case .template: return 1
        case .channels: return 2
        case .provider: return 3
        case .phoneNumber: return 4
        case .channelSetup: return 5
        case .summary: return 6
        case .complete: return 7
        }
    }

    static let totalSteps = 7
}

// MARK: - HubCommunicationsViewModel

/// ViewModel for hub communications settings and onboarding wizard.
/// Uses @Observable macro (iOS 17+) per project conventions.
@Observable
final class HubCommunicationsViewModel {
    /// The channels the checklist manages, in display order. `HubChannelType`
    /// is codegen output and cannot synthesise `CaseIterable` from here.
    private static let manageableChannels: [HubChannelType] = [
        .voice, .sms, .email, .signal, .whatsapp, .telegram, .rcs,
    ]

    private let onboardAPI: HubOnboardAPI
    private let providerService: ProviderSetupService
    private let hubContext: HubContext

    // MARK: - State

    /// Whether the hub's communications are set up — drives the settings panel
    /// versus the "start the wizard" empty state.
    var isSetUp: Bool = false

    /// Current provider type (if configured).
    var providerType: SharedProviderType?

    /// Provider connection status.
    var providerStatus: ProviderStatus = .disconnected

    /// Hub onboarding state from the API.
    var onboardingState: HubOnboardingState?

    /// Provider and channel setup status from the API.
    var setupStatus: HubSetupStatus?

    /// Current usage stats.
    var usage: HubUsage?

    /// Available provider templates.
    var templates: [ProviderTemplate] = []

    /// Selected template during onboarding.
    var selectedTemplate: ProviderTemplate?

    /// Channel toggles during onboarding or settings.
    var channelVoice: Bool = false
    var channelSms: Bool = false
    var channelEmail: Bool = false
    var channelSignal: Bool = false
    var channelWhatsApp: Bool = false
    var channelTelegram: Bool = false
    var channelRcs: Bool = false

    /// Current onboarding wizard step.
    var currentStep: OnboardingStep = .template

    /// Whether the onboarding sheet is presented.
    var showOnboardingSheet: Bool = false

    /// Loading states.
    var isLoading: Bool = false
    var isSavingChannels: Bool = false
    var isCompletingStep: Bool = false

    /// Error message to display.
    var error: String?

    /// Success feedback message.
    var successMessage: String?

    /// The channel config as the server last reported it, so saving sends only
    /// what changed — `PUT /onboard/channels` takes one channel at a time.
    private var serverChannels = ChannelConfig(
        email: false, rcs: false, signal: false, sms: false,
        telegram: false, voice: false, whatsapp: false
    )

    // MARK: - Init

    init(onboardAPI: HubOnboardAPI, providerService: ProviderSetupService, hubContext: HubContext) {
        self.onboardAPI = onboardAPI
        self.providerService = providerService
        self.hubContext = hubContext
    }

    var hubId: String? { hubContext.activeHubId }

    // MARK: - Data Loading

    /// Load hub provider status, usage, and onboarding state.
    func loadAll() async {
        guard let hubId else { return }
        isLoading = true
        error = nil
        defer { isLoading = false }

        do {
            async let statusTask = onboardAPI.getProviderStatus(hubId: hubId)
            async let usageTask = onboardAPI.getUsage(hubId: hubId)

            let status = try await statusTask
            // Usage is supplementary — a failure here must not blank the screen.
            let usageResult = try? await usageTask

            setupStatus = status
            usage = usageResult
            providerType = status.providerType
            providerStatus = status.providerConnected ? .connected : .disconnected
            isSetUp = status.onboardingComplete || status.providerConnected

            // Sync channel toggles from server state
            applyChannels(channelConfig(from: status))

            // If not set up, record whether onboarding was ever started — it
            // decides between "Start Setup" and "Resume Setup". The wizard's
            // step is deliberately NOT taken from here: `POST /onboard` resets
            // progress to the first step, so the sheet always opens on the
            // template picker and drives the server from there.
            if !isSetUp {
                onboardingState = try await onboardAPI.getOnboardingStatus(hubId: hubId)
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Load provider templates.
    func loadTemplates() async {
        do {
            templates = try await onboardAPI.getProviderTemplates().filter(\.isActive)
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: - Onboarding Actions

    /// Present the wizard from its first screen. `POST /onboard` resets the
    /// server's progress, so opening the sheet anywhere else would show a step
    /// the server is about to discard.
    func presentOnboardingSheet() {
        currentStep = .template
        selectedTemplate = nil
        showOnboardingSheet = true
    }

    /// Start onboarding, optionally with a template.
    ///
    /// Choosing a template (or starting from scratch) *is* the server's first
    /// step, `template_selection`, so it is completed in the same action —
    /// otherwise the wizard's second screen would have no server step behind it.
    func startOnboarding(templateId: String? = nil) async {
        guard let hubId else { return }
        isCompletingStep = true
        error = nil
        defer { isCompletingStep = false }

        do {
            _ = try await onboardAPI.startOnboarding(hubId: hubId, templateId: templateId)
            let state = try await onboardAPI.completeStep(
                hubId: hubId,
                step: OnboardingStep.template.serverStep!
            )
            apply(state)
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Select a template and start onboarding with it.
    func selectTemplate(_ template: ProviderTemplate) async {
        selectedTemplate = template
        await startOnboarding(templateId: template.id)
    }

    /// Start from scratch (no template).
    func startFromScratch() async {
        selectedTemplate = nil
        await startOnboarding(templateId: nil)
    }

    /// Complete the current onboarding step and advance.
    func completeCurrentStep() async {
        guard let hubId else { return }

        // Screens the server has no step for advance on their own.
        guard let serverStep = currentStep.serverStep else {
            advanceLocally()
            return
        }

        // Re-advancing after a back navigation: the server has already recorded
        // this step and rejects completing it twice.
        if onboardingState?.completedSteps.contains(serverStep) == true {
            advanceLocally()
            return
        }

        isCompletingStep = true
        error = nil
        defer { isCompletingStep = false }

        do {
            let state = try await onboardAPI.completeStep(
                hubId: hubId,
                step: serverStep,
                channelConfig: currentStep == .channels ? channelConfigFromToggles() : nil
            )
            apply(state)

            if state.isComplete {
                isSetUp = true
                showOnboardingSheet = false
                successMessage = NSLocalizedString("hub_onboarding_setup_complete", comment: "Setup complete")
                // Reload settings
                await loadAll()
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Navigate to a specific step (for back navigation).
    func goToStep(_ step: OnboardingStep) {
        currentStep = step
    }

    /// Go back one step in the wizard.
    func goBack() {
        let allSteps = OnboardingStep.allCases
        guard let currentIndex = allSteps.firstIndex(of: currentStep), currentIndex > 0 else { return }
        currentStep = allSteps[currentIndex - 1]
    }

    /// Whether we can go back from the current step.
    var canGoBack: Bool {
        currentStep != .template
    }

    // MARK: - Channel Management

    /// Persist the channel toggles. The server enables or disables one channel
    /// per request, so only the channels that actually changed are sent.
    func saveChannels() async {
        guard let hubId else { return }
        isSavingChannels = true
        error = nil
        defer { isSavingChannels = false }

        let desired = channelConfigFromToggles()
        var latest = serverChannels

        do {
            for channel in Self.manageableChannels where enabled(desired, channel) != enabled(latest, channel) {
                latest = try await onboardAPI.updateChannel(
                    hubId: hubId,
                    channel: channel.rawValue,
                    enabled: enabled(desired, channel)
                )
            }
        } catch {
            self.error = error.localizedDescription
        }

        // Whether or not every write landed, show what the server now holds.
        applyChannels(latest)
    }

    // MARK: - Private Helpers

    private func advanceLocally() {
        let allSteps = OnboardingStep.allCases
        guard let index = allSteps.firstIndex(of: currentStep), index + 1 < allSteps.count else { return }
        currentStep = allSteps[index + 1]
    }

    /// Adopt an onboarding state the server returned: its step and its channels.
    private func apply(_ state: HubOnboardingState) {
        onboardingState = state
        if let step = OnboardingStep.forServerStep(state.currentStep) {
            currentStep = step
        }
        applyChannels(ChannelConfig(
            email: state.channelConfig.email,
            rcs: state.channelConfig.rcs,
            signal: state.channelConfig.signal,
            sms: state.channelConfig.sms,
            telegram: state.channelConfig.telegram,
            voice: state.channelConfig.voice,
            whatsapp: state.channelConfig.whatsapp
        ))
    }

    private func applyChannels(_ config: ChannelConfig) {
        serverChannels = config
        channelVoice = config.voice
        channelSms = config.sms
        channelEmail = config.email
        channelSignal = config.signal
        channelWhatsApp = config.whatsapp
        channelTelegram = config.telegram
        channelRcs = config.rcs
    }

    private func channelConfigFromToggles() -> ChannelConfig {
        ChannelConfig(
            email: channelEmail,
            rcs: channelRcs,
            signal: channelSignal,
            sms: channelSms,
            telegram: channelTelegram,
            voice: channelVoice,
            whatsapp: channelWhatsApp
        )
    }

    private func channelConfig(from status: HubSetupStatus) -> ChannelConfig {
        let on = Set(status.channelsConfigured)
        return ChannelConfig(
            email: on.contains(.email),
            rcs: on.contains(.rcs),
            signal: on.contains(.signal),
            sms: on.contains(.sms),
            telegram: on.contains(.telegram),
            voice: on.contains(.voice),
            whatsapp: on.contains(.whatsapp)
        )
    }

    private func enabled(_ config: ChannelConfig, _ channel: HubChannelType) -> Bool {
        switch channel {
        case .voice: return config.voice
        case .sms: return config.sms
        case .email: return config.email
        case .signal: return config.signal
        case .whatsapp: return config.whatsapp
        case .telegram: return config.telegram
        case .rcs: return config.rcs
        }
    }

    /// List of currently enabled channels for display.
    var enabledChannels: [HubChannelType] {
        Self.manageableChannels.filter { enabled(channelConfigFromToggles(), $0) }
    }
}
