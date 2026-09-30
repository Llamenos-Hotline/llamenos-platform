import SwiftUI

// MARK: - ChannelChecklistView

/// Channel toggle view used both during onboarding and in the settings panel.
/// Each channel gets a toggle row with icon and label. When used in settings
/// (not onboarding), includes a save button.
struct ChannelChecklistView: View {
    @Bindable var viewModel: HubCommunicationsViewModel
    let isOnboarding: Bool

    var body: some View {
        List {
            Section {
                channelToggle(
                    label: NSLocalizedString("hub_onboarding_channel_voice", comment: "Voice Calls"),
                    icon: "phone.fill",
                    isOn: Binding(
                        get: { viewModel.channelVoice },
                        set: { viewModel.channelVoice = $0 }
                    ),
                    accessibilityId: "channel-toggle-voice"
                )

                channelToggle(
                    label: NSLocalizedString("hub_onboarding_channel_sms", comment: "SMS"),
                    icon: "message.fill",
                    isOn: Binding(
                        get: { viewModel.channelSms },
                        set: { viewModel.channelSms = $0 }
                    ),
                    accessibilityId: "channel-toggle-sms"
                )

                channelToggle(
                    label: NSLocalizedString("hub_onboarding_channel_email", comment: "Email"),
                    icon: "envelope.fill",
                    isOn: Binding(
                        get: { viewModel.channelEmail },
                        set: { viewModel.channelEmail = $0 }
                    ),
                    accessibilityId: "channel-toggle-email"
                )
            } header: {
                Text(NSLocalizedString("hub_onboarding_channel_checklist_title", comment: "Select Communication Channels"))
            } footer: {
                Text(NSLocalizedString("hub_onboarding_channel_checklist_description", comment: ""))
            }

            Section {
                channelToggle(
                    label: NSLocalizedString("hub_onboarding_channel_signal", comment: "Signal"),
                    icon: "lock.shield.fill",
                    isOn: Binding(
                        get: { viewModel.channelSignal },
                        set: { viewModel.channelSignal = $0 }
                    ),
                    accessibilityId: "channel-toggle-signal"
                )

                channelToggle(
                    label: NSLocalizedString("hub_onboarding_channel_whats_app", comment: "WhatsApp"),
                    icon: "bubble.left.and.bubble.right.fill",
                    isOn: Binding(
                        get: { viewModel.channelWhatsApp },
                        set: { viewModel.channelWhatsApp = $0 }
                    ),
                    accessibilityId: "channel-toggle-whatsapp"
                )

                channelToggle(
                    label: NSLocalizedString("hub_onboarding_channel_telegram", comment: "Telegram"),
                    icon: "paperplane.fill",
                    isOn: Binding(
                        get: { viewModel.channelTelegram },
                        set: { viewModel.channelTelegram = $0 }
                    ),
                    accessibilityId: "channel-toggle-telegram"
                )

                channelToggle(
                    label: NSLocalizedString("hub_onboarding_channel_rcs", comment: "RCS"),
                    icon: "bubble.left.fill",
                    isOn: Binding(
                        get: { viewModel.channelRcs },
                        set: { viewModel.channelRcs = $0 }
                    ),
                    accessibilityId: "channel-toggle-rcs"
                )
            } header: {
                Text(NSLocalizedString("hub_onboarding_channel_setup_title", comment: "Additional Channels"))
            }

            // Save button for settings mode (not onboarding)
            if !isOnboarding {
                Section {
                    Button {
                        Task { await viewModel.saveChannels() }
                    } label: {
                        HStack {
                            Spacer()
                            if viewModel.isSavingChannels {
                                ProgressView()
                                    .controlSize(.small)
                            } else {
                                Text(NSLocalizedString("common_save", comment: "Save"))
                                    .fontWeight(.semibold)
                            }
                            Spacer()
                        }
                    }
                    .disabled(viewModel.isSavingChannels)
                    .accessibilityIdentifier("channel-save-btn")
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(NSLocalizedString("hub_onboarding_channel_settings_title", comment: "Channel Settings"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("channel-checklist")
    }

    // MARK: - Channel Toggle Row

    private func channelToggle(label: String, icon: String, isOn: Binding<Bool>, accessibilityId: String) -> some View {
        Toggle(isOn: isOn) {
            Label {
                Text(label)
                    .font(.brand(.body))
            } icon: {
                Image(systemName: icon)
                    .foregroundStyle(isOn.wrappedValue ? Color.brandPrimary : Color.brandMutedForeground)
            }
        }
        .tint(Color.brandPrimary)
        .accessibilityIdentifier(accessibilityId)
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Channel Checklist") {
    NavigationStack {
        ChannelChecklistView(
            viewModel: HubCommunicationsViewModel(
                onboardAPI: HubOnboardAPI(api: APIService(
                    cryptoService: CryptoService(),
                    hubContext: HubContext()
                )),
                providerService: ProviderSetupService(api: APIService(
                    cryptoService: CryptoService(),
                    hubContext: HubContext()
                )),
                hubContext: HubContext()
            ),
            isOnboarding: true
        )
    }
}
#endif
