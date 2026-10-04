import SwiftUI
import AuthenticationServices

// MARK: - HubOnboardingSheet

/// Multi-step onboarding wizard presented as a sheet. Guides admins through:
/// 1. Template selection
/// 2. Channel checklist
/// 3. Provider connection (OAuth or API key)
/// 4. Phone number provisioning
/// 5. Additional channel setup
/// 6. Summary/review
/// 7. Completion
struct HubOnboardingSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppState.self) private var appState
    @Bindable var viewModel: HubCommunicationsViewModel

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Step indicator
                stepIndicator

                // Step content
                stepContent
                    .frame(maxWidth: .infinity, maxHeight: .infinity)

                // Navigation buttons
                bottomBar
            }
            .navigationTitle(NSLocalizedString("hub_onboarding_title", comment: "Hub Communications Setup"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("common_cancel", comment: "Cancel")) {
                        dismiss()
                    }
                    .accessibilityIdentifier("onboarding-cancel-btn")
                }
            }
            .task {
                await viewModel.loadTemplates()
            }
        }
        .interactiveDismissDisabled(viewModel.isCompletingStep)
        .accessibilityIdentifier("hub-onboarding-sheet")
    }

    // MARK: - Step Indicator

    private var stepIndicator: some View {
        VStack(spacing: 8) {
            // Progress bar
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color.brandMutedForeground.opacity(0.2))
                        .frame(height: 4)

                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color.brandPrimary)
                        .frame(
                            width: proxy.size.width * CGFloat(viewModel.currentStep.stepNumber) / CGFloat(OnboardingStep.totalSteps),
                            height: 4
                        )
                        .animation(.easeInOut(duration: 0.3), value: viewModel.currentStep)
                }
            }
            .frame(height: 4)

            // Step label
            Text(L10n.format(
                "hub_onboarding_step_of",
                comment: "Step %d of %d",
                viewModel.currentStep.stepNumber,
                OnboardingStep.totalSteps
            ))
            .font(.brand(.caption))
            .foregroundStyle(Color.brandMutedForeground)
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 4)
        .accessibilityIdentifier("onboarding-step-indicator")
    }

    // MARK: - Step Content

    @ViewBuilder
    private var stepContent: some View {
        switch viewModel.currentStep {
        case .template:
            ProviderTemplateListView(viewModel: viewModel)
        case .channels:
            ChannelChecklistView(viewModel: viewModel, isOnboarding: true)
        case .provider:
            providerConnectionStep
        case .phoneNumber:
            phoneNumberStep
        case .channelSetup:
            channelSetupStep
        case .summary:
            summaryStep
        case .complete:
            completeStep
        }
    }

    // MARK: - Provider Connection Step

    private var providerConnectionStep: some View {
        ScrollView {
            VStack(spacing: 20) {
                stepHeader(
                    title: NSLocalizedString("hub_onboarding_provider_connection_title", comment: "Connect Your Provider"),
                    description: NSLocalizedString("hub_onboarding_provider_connection_description", comment: ""),
                    icon: "link"
                )

                // If a template was selected, show the recommended provider
                if let template = viewModel.selectedTemplate {
                    HStack(spacing: 12) {
                        Image(systemName: template.providerType.iconName)
                            .font(.system(size: 24))
                            .foregroundStyle(Color.brandPrimary)
                            .frame(width: 44, height: 44)
                            .background(Color.brandPrimary.opacity(0.1))
                            .clipShape(RoundedRectangle(cornerRadius: 10))

                        VStack(alignment: .leading, spacing: 2) {
                            Text(template.providerType.displayName)
                                .font(.brand(.body))
                                .fontWeight(.semibold)
                            Text(NSLocalizedString("hub_onboarding_template_recommended", comment: "Recommended"))
                                .font(.brand(.caption))
                                .foregroundStyle(Color.brandPrimary)
                        }

                        Spacer()
                    }
                    .padding()
                    .background(Color.brandPrimary.opacity(0.05))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .padding(.horizontal, 16)
                }

                // Provider connection is delegated to the existing Phase 6 ProviderSetupView
                // For now, show a placeholder that the user connects via the provider setup flow
                VStack(spacing: 12) {
                    Image(systemName: "arrow.triangle.turn.up.right.diamond.fill")
                        .font(.system(size: 28))
                        .foregroundStyle(Color.brandMutedForeground)

                    Text(NSLocalizedString("hub_onboarding_provider_connection_description", comment: ""))
                        .font(.brand(.caption))
                        .foregroundStyle(Color.brandMutedForeground)
                        .multilineTextAlignment(.center)
                }
                .padding(.top, 20)
            }
        }
        .accessibilityIdentifier("onboarding-step-provider")
    }

    // MARK: - Phone Number Step

    private var phoneNumberStep: some View {
        ScrollView {
            VStack(spacing: 20) {
                stepHeader(
                    title: NSLocalizedString("hub_onboarding_phone_number_title", comment: "Select a Phone Number"),
                    description: NSLocalizedString("hub_onboarding_phone_number_description", comment: ""),
                    icon: "phone.badge.plus"
                )

                // Phone number selection is handled by the existing PhoneNumberSelectionView
                VStack(spacing: 12) {
                    Image(systemName: "phone.fill.badge.checkmark")
                        .font(.system(size: 28))
                        .foregroundStyle(Color.brandMutedForeground)

                    Text(NSLocalizedString("hub_onboarding_phone_number_description", comment: ""))
                        .font(.brand(.caption))
                        .foregroundStyle(Color.brandMutedForeground)
                        .multilineTextAlignment(.center)
                }
                .padding(.top, 20)
            }
        }
        .accessibilityIdentifier("onboarding-step-phone")
    }

    // MARK: - Channel Setup Step

    private var channelSetupStep: some View {
        ScrollView {
            VStack(spacing: 20) {
                stepHeader(
                    title: NSLocalizedString("hub_onboarding_channel_setup_title", comment: "Configure Additional Channels"),
                    description: NSLocalizedString("hub_onboarding_channel_setup_description", comment: ""),
                    icon: "gear.badge"
                )

                // List each enabled channel that needs configuration
                ForEach(viewModel.enabledChannels, id: \.self) { channel in
                    HStack(spacing: 12) {
                        Image(systemName: channel.iconName)
                            .font(.system(size: 16))
                            .foregroundStyle(Color.brandPrimary)
                            .frame(width: 36, height: 36)
                            .background(Color.brandPrimary.opacity(0.1))
                            .clipShape(Circle())

                        Text(channel.displayLabel)
                            .font(.brand(.body))

                        Spacer()

                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(Color.green)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                }
            }
        }
        .accessibilityIdentifier("onboarding-step-channel-setup")
    }

    // MARK: - Summary Step

    private var summaryStep: some View {
        ScrollView {
            VStack(spacing: 20) {
                stepHeader(
                    title: NSLocalizedString("hub_onboarding_summary_title", comment: "Review Your Configuration"),
                    description: NSLocalizedString("hub_onboarding_summary_description", comment: ""),
                    icon: "checklist.checked"
                )

                VStack(spacing: 16) {
                    // Template
                    if let template = viewModel.selectedTemplate {
                        summaryRow(
                            label: NSLocalizedString("hub_onboarding_step_template", comment: "Template"),
                            value: template.name,
                            icon: "doc.text"
                        )
                    }

                    // Provider
                    if let provider = viewModel.providerType {
                        summaryRow(
                            label: NSLocalizedString("hub_onboarding_step_provider", comment: "Provider"),
                            value: provider.displayName,
                            icon: "antenna.radiowaves.left.and.right"
                        )
                    }

                    // Channels
                    summaryRow(
                        label: NSLocalizedString("hub_onboarding_step_channels", comment: "Channels"),
                        value: viewModel.enabledChannels.map(\.displayLabel).joined(separator: ", "),
                        icon: "checklist"
                    )
                }
                .padding(.horizontal, 16)
            }
        }
        .accessibilityIdentifier("onboarding-step-summary")
    }

    // MARK: - Complete Step

    private var completeStep: some View {
        VStack(spacing: 24) {
            Spacer()

            ZStack {
                Circle()
                    .fill(Color.green.opacity(0.15))
                    .frame(width: 80, height: 80)
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 40))
                    .foregroundStyle(Color.green)
            }

            Text(NSLocalizedString("hub_onboarding_setup_complete", comment: "Setup complete!"))
                .font(.brand(.title3))
                .fontWeight(.semibold)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            Spacer()

            Button {
                dismiss()
            } label: {
                Text(NSLocalizedString("common_done", comment: "Done"))
                    .font(.brand(.body))
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.brandPrimary)
            .padding(.horizontal, 24)
            .padding(.bottom, 16)
            .accessibilityIdentifier("onboarding-done-btn")
        }
        .accessibilityIdentifier("onboarding-step-complete")
    }

    // MARK: - Bottom Bar

    private var bottomBar: some View {
        Group {
            if viewModel.currentStep != .complete {
                HStack(spacing: 16) {
                    if viewModel.canGoBack {
                        Button {
                            viewModel.goBack()
                        } label: {
                            HStack {
                                Image(systemName: "chevron.left")
                                Text(NSLocalizedString("common_back", comment: "Back"))
                            }
                            .font(.brand(.body))
                        }
                        .accessibilityIdentifier("onboarding-back-btn")
                    }

                    Spacer()

                    if viewModel.currentStep == .summary {
                        Button {
                            Task { await viewModel.completeCurrentStep() }
                        } label: {
                            HStack {
                                if viewModel.isCompletingStep {
                                    ProgressView()
                                        .controlSize(.small)
                                } else {
                                    Text(NSLocalizedString("hub_onboarding_complete_setup", comment: "Complete Setup"))
                                    Image(systemName: "checkmark")
                                }
                            }
                            .font(.brand(.body))
                            .fontWeight(.semibold)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Color.brandPrimary)
                        .disabled(viewModel.isCompletingStep)
                        .accessibilityIdentifier("onboarding-complete-btn")
                    } else if viewModel.currentStep != .template {
                        Button {
                            Task { await viewModel.completeCurrentStep() }
                        } label: {
                            HStack {
                                if viewModel.isCompletingStep {
                                    ProgressView()
                                        .controlSize(.small)
                                } else {
                                    Text(NSLocalizedString("common_next", comment: "Next"))
                                    Image(systemName: "chevron.right")
                                }
                            }
                            .font(.brand(.body))
                            .fontWeight(.semibold)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Color.brandPrimary)
                        .disabled(viewModel.isCompletingStep)
                        .accessibilityIdentifier("onboarding-next-btn")
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(Color.brandBackground)
            }
        }
    }

    // MARK: - Helpers

    private func stepHeader(title: String, description: String, icon: String) -> some View {
        VStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(Color.brandPrimary.opacity(0.1))
                    .frame(width: 56, height: 56)
                Image(systemName: icon)
                    .font(.system(size: 24))
                    .foregroundStyle(Color.brandPrimary)
            }
            .padding(.top, 20)

            Text(title)
                .font(.brand(.title3))
                .fontWeight(.semibold)
                .foregroundStyle(Color.brandForeground)

            Text(description)
                .font(.brand(.body))
                .foregroundStyle(Color.brandMutedForeground)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
        }
    }

    private func summaryRow(label: String, value: String, icon: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 16))
                .foregroundStyle(Color.brandPrimary)
                .frame(width: 32)

            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.brand(.caption))
                    .foregroundStyle(Color.brandMutedForeground)
                Text(value)
                    .font(.brand(.body))
                    .fontWeight(.medium)
            }

            Spacer()

            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(Color.green)
        }
        .padding()
        .background(Color.brandBackground.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Onboarding Sheet") {
    Text("Background")
        .sheet(isPresented: .constant(true)) {
            HubOnboardingSheet(
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
                )
            )
            .environment(AppState(hubContext: HubContext()))
        }
}
#endif
