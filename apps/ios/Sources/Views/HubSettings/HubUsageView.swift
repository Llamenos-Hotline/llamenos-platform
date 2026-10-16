import SwiftUI

// MARK: - HubUsageView

/// Displays current month usage statistics versus quota limits for the hub.
/// Shows call count, SMS count, Signal messages, WhatsApp messages, and
/// phone number usage against configured quotas.
struct HubUsageView: View {
    @Bindable var viewModel: HubCommunicationsViewModel

    var body: some View {
        List {
            // Current Usage
            if let usage = viewModel.usage {
                Section {
                    usageRow(
                        label: NSLocalizedString("hub_onboarding_usage_calls", comment: "Calls"),
                        icon: "phone.fill",
                        value: usage.callsReceived,
                        quota: viewModel.setupStatus?.quotas?.maxCallsPerMonth
                    )

                    usageRow(
                        label: NSLocalizedString("hub_onboarding_usage_sms", comment: "SMS"),
                        icon: "message.fill",
                        value: usage.smsSent,
                        quota: viewModel.setupStatus?.quotas?.maxSMSPerMonth
                    )

                    usageRow(
                        label: NSLocalizedString("hub_onboarding_usage_signal", comment: "Signal Messages"),
                        icon: "lock.shield.fill",
                        value: usage.signalMessagesSent,
                        quota: viewModel.setupStatus?.quotas?.maxSignalMessagesPerMonth
                    )

                    usageRow(
                        label: NSLocalizedString("hub_onboarding_usage_whats_app", comment: "WhatsApp Messages"),
                        icon: "bubble.left.and.bubble.right.fill",
                        value: usage.whatsAppMessagesSent,
                        quota: viewModel.setupStatus?.quotas?.maxWhatsAppMessagesPerMonth
                    )

                    usageRow(
                        label: NSLocalizedString("hub_onboarding_quota_phone_numbers", comment: "Phone Numbers"),
                        icon: "phone.badge.plus",
                        value: usage.phoneNumbers,
                        quota: viewModel.setupStatus?.quotas?.maxPhoneNumbers
                    )
                } header: {
                    Text(NSLocalizedString("hub_onboarding_usage_title", comment: "Usage This Month"))
                } footer: {
                    if let month = usage.month, let year = usage.year {
                        Text("\(month)/\(year)")
                    }
                }
            }

            // Quota Limits
            if let quotas = viewModel.setupStatus?.quotas {
                Section {
                    quotaRow(
                        label: NSLocalizedString("hub_onboarding_quota_calls", comment: "Calls / Month"),
                        value: quotas.maxCallsPerMonth
                    )

                    quotaRow(
                        label: NSLocalizedString("hub_onboarding_quota_sms", comment: "SMS / Month"),
                        value: quotas.maxSMSPerMonth
                    )

                    quotaRow(
                        label: NSLocalizedString("hub_onboarding_quota_phone_numbers", comment: "Phone Numbers"),
                        value: quotas.maxPhoneNumbers
                    )
                } header: {
                    Text(NSLocalizedString("hub_onboarding_quota_title", comment: "Quota Limits"))
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(NSLocalizedString("hub_onboarding_usage_title", comment: "Usage This Month"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("hub-usage-view")
    }

    // MARK: - Usage Row

    private func usageRow(label: String, icon: String, value: Int, quota: Int?) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 16))
                .foregroundStyle(Color.brandPrimary)
                .frame(width: 28)

            VStack(alignment: .leading, spacing: 4) {
                Text(label)
                    .font(.brand(.body))

                if let quota {
                    // Progress bar
                    GeometryReader { proxy in
                        ZStack(alignment: .leading) {
                            RoundedRectangle(cornerRadius: 2)
                                .fill(Color.brandMutedForeground.opacity(0.15))
                                .frame(height: 4)

                            RoundedRectangle(cornerRadius: 2)
                                .fill(usageColor(value: value, quota: quota))
                                .frame(
                                    width: max(0, min(proxy.size.width, proxy.size.width * CGFloat(value) / CGFloat(max(1, quota)))),
                                    height: 4
                                )
                        }
                    }
                    .frame(height: 4)
                }
            }

            Spacer()

            if let quota {
                Text("\(value) / \(quota)")
                    .font(.brandMono(.caption))
                    .foregroundStyle(usageColor(value: value, quota: quota))
            } else {
                Text("\(value)")
                    .font(.brandMono(.caption))
                    .foregroundStyle(Color.brandMutedForeground)
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: - Quota Row

    private func quotaRow(label: String, value: Int) -> some View {
        HStack {
            Text(label)
                .font(.brand(.body))
                .foregroundStyle(Color.brandMutedForeground)
            Spacer()
            Text("\(value)")
                .font(.brandMono(.body))
                .fontWeight(.medium)
        }
    }

    // MARK: - Helpers

    private func usageColor(value: Int, quota: Int) -> Color {
        let ratio = Double(value) / Double(max(1, quota))
        if ratio >= 0.9 { return .red }
        if ratio >= 0.7 { return .orange }
        return .green
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Hub Usage") {
    NavigationStack {
        HubUsageView(
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
