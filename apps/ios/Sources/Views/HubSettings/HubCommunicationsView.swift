import SwiftUI

// MARK: - HubCommunicationsView

/// Main hub communications settings view. Shows either:
/// - A "no provider configured" state with a button to start onboarding, or
/// - The current provider status, channel settings, and usage stats.
/// Permission-gated: only admins see the full settings panel.
struct HubCommunicationsView: View {
    @Environment(AppState.self) private var appState
    @State private var viewModelBox = ViewModelBox<HubCommunicationsViewModel>()

    private var vm: HubCommunicationsViewModel {
        if let existing = viewModelBox.value { return existing }
        let vm = HubCommunicationsViewModel(
            onboardAPI: HubOnboardAPI(api: appState.apiService),
            providerService: ProviderSetupService(api: appState.apiService),
            hubContext: appState.hubContext
        )
        viewModelBox.value = vm
        return vm
    }

    var body: some View {
        let vm = self.vm

        Group {
            if vm.isLoading && vm.setupStatus == nil {
                loadingView
            } else if !vm.isSetUp {
                noProviderView(vm: vm)
            } else {
                settingsView(vm: vm)
            }
        }
        .navigationTitle(NSLocalizedString("hub_onboarding_settings_title", comment: "Communications"))
        .navigationBarTitleDisplayMode(.large)
        .sheet(isPresented: Binding(
            get: { vm.showOnboardingSheet },
            set: { vm.showOnboardingSheet = $0 }
        )) {
            HubOnboardingSheet(viewModel: vm)
        }
        .task {
            await vm.loadAll()
        }
        .refreshable {
            await vm.loadAll()
        }
        .alert(
            NSLocalizedString("common_error", comment: "Error"),
            isPresented: .constant(vm.error != nil)
        ) {
            Button(NSLocalizedString("common_ok", comment: "OK")) {
                vm.error = nil
            }
        } message: {
            if let msg = vm.error {
                Text(msg)
            }
        }
    }

    // MARK: - Loading

    private var loadingView: some View {
        VStack {
            Spacer()
            ProgressView()
            Text(NSLocalizedString("hub_onboarding_loading", comment: "Loading hub configuration..."))
                .font(.brand(.caption))
                .foregroundStyle(Color.brandMutedForeground)
                .padding(.top, 8)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("hub-comms-loading")
    }

    // MARK: - No Provider Configured

    private func noProviderView(vm: HubCommunicationsViewModel) -> some View {
        VStack(spacing: 24) {
            Spacer()

            ZStack {
                Circle()
                    .fill(Color.brandPrimary.opacity(0.1))
                    .frame(width: 80, height: 80)
                Image(systemName: "phone.badge.waveform")
                    .font(.system(size: 32))
                    .foregroundStyle(Color.brandPrimary)
            }

            VStack(spacing: 8) {
                Text(NSLocalizedString("hub_onboarding_no_provider_configured", comment: "No provider configured"))
                    .font(.brand(.title3))
                    .fontWeight(.semibold)
                    .foregroundStyle(Color.brandForeground)

                Text(NSLocalizedString("hub_onboarding_no_provider_description", comment: ""))
                    .font(.brand(.body))
                    .foregroundStyle(Color.brandMutedForeground)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }

            if appState.hasPermission("settings:manage-messaging") {
                Button {
                    vm.presentOnboardingSheet()
                } label: {
                    HStack {
                        Image(systemName: "wand.and.stars")
                        Text(vm.onboardingState != nil
                            ? NSLocalizedString("hub_onboarding_resume_setup", comment: "Resume Setup")
                            : NSLocalizedString("hub_onboarding_start_setup", comment: "Start Setup")
                        )
                    }
                    .font(.brand(.body))
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.brandPrimary)
                .padding(.horizontal, 40)
                .accessibilityIdentifier("hub-comms-start-setup-btn")
            }

            Spacer()
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("hub-comms-no-provider")
    }

    // MARK: - Settings (Provider Configured)

    private func settingsView(vm: HubCommunicationsViewModel) -> some View {
        List {
            // Provider Status
            Section {
                HStack {
                    Label(
                        NSLocalizedString("hub_onboarding_provider_status", comment: "Provider Status"),
                        systemImage: "antenna.radiowaves.left.and.right"
                    )
                    Spacer()
                    HStack(spacing: 6) {
                        Circle()
                            .fill(vm.providerStatus == .connected ? Color.green : Color.red)
                            .frame(width: 8, height: 8)
                        Text(vm.providerStatus == .connected
                            ? NSLocalizedString("hub_onboarding_provider_connected", comment: "Connected")
                            : NSLocalizedString("hub_onboarding_provider_disconnected", comment: "Disconnected")
                        )
                        .font(.brand(.caption))
                        .foregroundStyle(Color.brandMutedForeground)
                    }
                }
                .accessibilityIdentifier("hub-comms-provider-status")

                if let providerType = vm.providerType {
                    HStack {
                        Text(NSLocalizedString("hub_onboarding_step_provider", comment: "Provider"))
                            .foregroundStyle(Color.brandMutedForeground)
                        Spacer()
                        Text(providerType.displayName)
                            .font(.brand(.body))
                            .fontWeight(.medium)
                    }
                }
            } header: {
                Text(NSLocalizedString("hub_onboarding_step_provider", comment: "Provider"))
            }

            // Channel Settings
            Section {
                NavigationLink {
                    ChannelChecklistView(viewModel: vm, isOnboarding: false)
                } label: {
                    Label(
                        NSLocalizedString("hub_onboarding_channel_settings_title", comment: "Channel Settings"),
                        systemImage: "checklist"
                    )
                }
                .accessibilityIdentifier("hub-comms-channel-settings-link")

                // Show enabled channels summary
                if !vm.enabledChannels.isEmpty {
                    HStack {
                        ForEach(vm.enabledChannels, id: \.self) { channel in
                            BadgeView(
                                text: channel.displayLabel,
                                icon: nil,
                                color: .green,
                                style: .subtle
                            )
                        }
                    }
                }
            } header: {
                Text(NSLocalizedString("hub_onboarding_step_channels", comment: "Channels"))
            }

            // Usage
            if let usage = vm.usage {
                Section {
                    NavigationLink {
                        HubUsageView(viewModel: vm)
                    } label: {
                        Label(
                            NSLocalizedString("hub_onboarding_usage_title", comment: "Usage This Month"),
                            systemImage: "chart.bar"
                        )
                    }
                    .accessibilityIdentifier("hub-comms-usage-link")
                } header: {
                    Text(NSLocalizedString("hub_onboarding_usage_title", comment: "Usage"))
                }
            }

            // Phone Numbers
            Section {
                Label(
                    NSLocalizedString("hub_onboarding_phone_numbers", comment: "Phone Numbers"),
                    systemImage: "phone.fill"
                )
                .accessibilityIdentifier("hub-comms-phone-numbers")
            } header: {
                Text(NSLocalizedString("hub_onboarding_phone_numbers", comment: "Phone Numbers"))
            }
        }
        .listStyle(.insetGrouped)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("hub-comms-settings-list")
    }
}

// MARK: - HubChannelType + Display

extension HubChannelType {
    var displayLabel: String {
        switch self {
        case .voice: return NSLocalizedString("hub_onboarding_channel_voice", comment: "Voice")
        case .sms: return NSLocalizedString("hub_onboarding_channel_sms", comment: "SMS")
        case .email: return NSLocalizedString("hub_onboarding_channel_email", comment: "Email")
        case .signal: return NSLocalizedString("hub_onboarding_channel_signal", comment: "Signal")
        case .whatsapp: return NSLocalizedString("hub_onboarding_channel_whats_app", comment: "WhatsApp")
        case .telegram: return NSLocalizedString("hub_onboarding_channel_telegram", comment: "Telegram")
        case .rcs: return NSLocalizedString("hub_onboarding_channel_rcs", comment: "RCS")
        }
    }

    var iconName: String {
        switch self {
        case .voice: return "phone.fill"
        case .sms: return "message.fill"
        case .email: return "envelope.fill"
        case .signal: return "lock.shield.fill"
        case .whatsapp: return "bubble.left.and.bubble.right.fill"
        case .telegram: return "paperplane.fill"
        case .rcs: return "bubble.left.fill"
        }
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Hub Communications") {
    NavigationStack {
        HubCommunicationsView()
            .environment(AppState(hubContext: HubContext()))
    }
}
#endif
