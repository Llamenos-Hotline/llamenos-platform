import SwiftUI

// MARK: - APIKeyProviderView

/// Manual credential entry for API-key based providers.
struct APIKeyProviderView: View {
    @Bindable var viewModel: ProviderSetupViewModel
    let provider: ProviderInfo
    let onConnected: () -> Void

    var body: some View {
        Form {
            providerHeaderSection
            credentialFieldsSection
            actionsSection
            if let testResult = viewModel.testResult {
                testResultSection(testResult)
            }
            if let error = viewModel.error {
                Section {
                    Label(error, systemImage: "exclamationmark.circle")
                        .font(.brand(.footnote))
                        .foregroundStyle(Color.brandDestructive)
                }
            }
            if viewModel.connectionStatus == .connected {
                connectedActionsSection
            }
        }
        .navigationTitle(provider.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await viewModel.loadStatus()
        }
        .accessibilityIdentifier("api-key-provider-view")
    }

    // MARK: - Sections

    private var providerHeaderSection: some View {
        Section {
            HStack(spacing: 16) {
                Image(systemName: provider.icon)
                    .font(.largeTitle)
                    .foregroundStyle(Color.brandPrimary)

                VStack(alignment: .leading, spacing: 4) {
                    Text(provider.displayName)
                        .font(.brand(.headline))
                    ProviderStatusIndicator(status: viewModel.connectionStatus)
                }
                Spacer()
            }
            .padding(.vertical, 4)
        }
    }

    private var credentialFieldsSection: some View {
        Section {
            ForEach(viewModel.credentialFields, id: \.key) { field in
                VStack(alignment: .leading, spacing: 4) {
                    Text(field.label)
                        .font(.brand(.caption))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)

                    if field.isSecret {
                        SecureField(
                            field.label,
                            text: Binding(
                                get: { viewModel.credentials[field.key] ?? "" },
                                set: { viewModel.credentials[field.key] = $0 }
                            )
                        )
                        .font(.brandMono(.body))
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .accessibilityIdentifier("credential-\(field.key)")
                    } else {
                        TextField(
                            field.label,
                            text: Binding(
                                get: { viewModel.credentials[field.key] ?? "" },
                                set: { viewModel.credentials[field.key] = $0 }
                            )
                        )
                        .font(.brandMono(.body))
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .keyboardType(field.key.lowercased().contains("url") ? .URL : .default)
                        .accessibilityIdentifier("credential-\(field.key)")
                    }
                }
            }
        } header: {
            Text(NSLocalizedString("provider_credentials_header", comment: "API Credentials"))
        } footer: {
            Text(NSLocalizedString("provider_credentials_footer", comment: "Credentials are stored securely and never shared."))
                .font(.brand(.caption))
        }
    }

    private var actionsSection: some View {
        Section {
            Button {
                Task { await viewModel.configureWithCredentials() }
            } label: {
                HStack {
                    if viewModel.isConnecting {
                        ProgressView().scaleEffect(0.8).padding(.trailing, 4)
                    }
                    Text(NSLocalizedString("provider_save_and_test", comment: "Save & Connect"))
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(viewModel.isConnecting || !viewModel.credentialsComplete)
            .accessibilityIdentifier("api-key-save-button")

            Button {
                Task { await viewModel.testConnection() }
            } label: {
                HStack {
                    if viewModel.isTesting {
                        ProgressView().scaleEffect(0.8)
                    } else {
                        Image(systemName: "network")
                    }
                    Text(NSLocalizedString("provider_test_connection", comment: "Test Connection"))
                }
            }
            .disabled(viewModel.isTesting || viewModel.connectionStatus == .disconnected)
            .accessibilityIdentifier("api-key-test-button")
        }
    }

    private func testResultSection(_ result: TestConnectionResult) -> some View {
        Section {
            if result.connected {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(NSLocalizedString("provider_test_success", comment: "Connection successful"))
                            .font(.brand(.body))
                        if let name = result.accountName {
                            Text(name)
                                .font(.brand(.caption))
                                .foregroundStyle(.secondary)
                        }
                        if let ms = result.latencyMs {
                            // `ms` is a Double: L10n.format takes only stringifiable arguments, so the
                            // precision is chosen here rather than inferred from the format string.
                            Text(L10n.format(
                                "provider_test_latency",
                                comment: "Latency: {{ms}}ms",
                                String(format: "%.0f", ms)
                            ))
                                .font(.brand(.caption2))
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } else {
                HStack(spacing: 8) {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(Color.brandDestructive)
                    Text(result.error ?? NSLocalizedString("provider_test_failed", comment: "Connection failed"))
                        .font(.brand(.body))
                        .foregroundStyle(Color.brandDestructive)
                }
            }
        }
    }

    private var connectedActionsSection: some View {
        Section {
            Button {
                onConnected()
            } label: {
                Label(
                    NSLocalizedString("provider_select_phone_number", comment: "Select Phone Number"),
                    systemImage: "phone.badge.plus"
                )
            }
            .accessibilityIdentifier("api-key-select-number-button")
        } header: {
            Text(NSLocalizedString("provider_next_steps_header", comment: "Next Steps"))
        }
    }
}
