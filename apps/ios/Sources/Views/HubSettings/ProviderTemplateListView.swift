import SwiftUI

// MARK: - ProviderTemplateListView

/// Template picker for the first step of hub onboarding. Lists available
/// provider templates from the API and a "start from scratch" option.
struct ProviderTemplateListView: View {
    @Bindable var viewModel: HubCommunicationsViewModel

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                // Header
                VStack(spacing: 12) {
                    ZStack {
                        Circle()
                            .fill(Color.brandPrimary.opacity(0.1))
                            .frame(width: 56, height: 56)
                        Image(systemName: "doc.text.magnifyingglass")
                            .font(.system(size: 24))
                            .foregroundStyle(Color.brandPrimary)
                    }
                    .padding(.top, 20)

                    Text(NSLocalizedString("hub_onboarding_select_template_title", comment: "Choose a Setup Template"))
                        .font(.brand(.title3))
                        .fontWeight(.semibold)
                        .foregroundStyle(Color.brandForeground)

                    Text(NSLocalizedString("hub_onboarding_select_template_description", comment: ""))
                        .font(.brand(.body))
                        .foregroundStyle(Color.brandMutedForeground)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                }

                // Template cards
                VStack(spacing: 12) {
                    ForEach(viewModel.templates, id: \.id) { template in
                        templateCard(template)
                    }

                    // Start from scratch option
                    fromScratchCard
                }
                .padding(.horizontal, 16)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("onboarding-template-list")
    }

    // MARK: - Template Card

    private func templateCard(_ template: ProviderTemplate) -> some View {
        Button {
            Task { await viewModel.selectTemplate(template) }
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Image(systemName: template.providerType.iconName)
                        .font(.system(size: 20))
                        .foregroundStyle(Color.brandPrimary)
                        .frame(width: 36, height: 36)
                        .background(Color.brandPrimary.opacity(0.1))
                        .clipShape(RoundedRectangle(cornerRadius: 8))

                    VStack(alignment: .leading, spacing: 2) {
                        Text(template.name)
                            .font(.brand(.body))
                            .fontWeight(.semibold)
                            .foregroundStyle(Color.brandForeground)

                        if let description = template.description, !description.isEmpty {
                            Text(description)
                                .font(.brand(.caption))
                                .foregroundStyle(Color.brandMutedForeground)
                                .lineLimit(2)
                        }
                    }

                    Spacer()

                    Image(systemName: "chevron.right")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.brandMutedForeground)
                }

                // Channel tags
                if !template.defaultChannels.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(template.defaultChannels, id: \.self) { channel in
                            HStack(spacing: 4) {
                                Image(systemName: channel.iconName)
                                    .font(.system(size: 10))
                                Text(channel.displayLabel)
                                    .font(.brand(.caption2))
                            }
                            .foregroundStyle(Color.brandPrimary)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color.brandPrimary.opacity(0.08))
                            .clipShape(Capsule())
                        }
                    }
                }

                // Provider type
                HStack(spacing: 4) {
                    Image(systemName: "server.rack")
                        .font(.system(size: 10))
                    Text(String(
                        format: NSLocalizedString("hub_onboarding_template_provider", comment: "Provider: %@"),
                        template.providerType.displayName
                    ))
                    .font(.brand(.caption))
                }
                .foregroundStyle(Color.brandMutedForeground)
            }
            .padding(16)
            .background(Color.brandBackground)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(
                        viewModel.selectedTemplate?.id == template.id
                            ? Color.brandPrimary
                            : Color.brandBorder,
                        lineWidth: viewModel.selectedTemplate?.id == template.id ? 2 : 1
                    )
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("template-card-\(template.slug)")
    }

    // MARK: - From Scratch Card

    private var fromScratchCard: some View {
        Button {
            Task { await viewModel.startFromScratch() }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "wrench.and.screwdriver")
                    .font(.system(size: 20))
                    .foregroundStyle(Color.brandMutedForeground)
                    .frame(width: 36, height: 36)
                    .background(Color.brandMutedForeground.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: 8))

                VStack(alignment: .leading, spacing: 2) {
                    Text(NSLocalizedString("hub_onboarding_start_from_scratch", comment: "Start from Scratch"))
                        .font(.brand(.body))
                        .fontWeight(.medium)
                        .foregroundStyle(Color.brandForeground)

                    Text(NSLocalizedString("hub_onboarding_start_from_scratch_description", comment: ""))
                        .font(.brand(.caption))
                        .foregroundStyle(Color.brandMutedForeground)
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.brandMutedForeground)
            }
            .padding(16)
            .background(Color.brandBackground)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(Color.brandBorder, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("template-from-scratch")
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Template List") {
    NavigationStack {
        ProviderTemplateListView(
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
    }
}
#endif
