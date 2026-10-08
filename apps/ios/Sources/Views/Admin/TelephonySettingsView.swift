import SwiftUI

// MARK: - TelephonySettingsView

/// Admin view for the hub's telephony provider: which provider answers calls,
/// its credentials, and the hotline number.
///
/// The provider list is the generated `SharedProviderType`, so it is exactly
/// the eight providers `telephonyProviderTypeSchema` accepts. Reading is
/// `GET /api/settings/telephony-provider` and writing is
/// `POST /api/provider-setup/configure` — the paths the server mounts and the
/// desktop client uses. This screen used to read and write
/// `/api/settings/telephony`, which answers 404 on every verb, over a
/// hand-written type matching neither the read nor the write shape (#1724).
struct TelephonySettingsView: View {
    @Bindable var viewModel: AdminViewModel

    var body: some View {
        Form {
            if viewModel.isLoadingTelephony {
                Section {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                }
            } else {
                providerSection
                credentialsSection
                saveSection

                if let error = viewModel.errorMessage {
                    Section {
                        Text(error)
                            .font(.brand(.footnote))
                            .foregroundStyle(Color.brandDestructive)
                            .accessibilityIdentifier("telephony-settings-error")
                    }
                }

                if let success = viewModel.successMessage {
                    Section {
                        Text(success)
                            .font(.brand(.footnote))
                            .foregroundStyle(.green)
                            .accessibilityIdentifier("telephony-settings-success")
                    }
                }
            }
        }
        .navigationTitle(NSLocalizedString("admin_telephony_settings", comment: "Telephony"))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await viewModel.loadTelephonySettings()
        }
        .accessibilityIdentifier("telephony-settings-view")
    }

    // MARK: - Provider Section

    private var providerSection: some View {
        Section {
            Picker(
                NSLocalizedString("admin_telephony_provider", comment: "Provider"),
                selection: $viewModel.telephonyProvider
            ) {
                ForEach(SharedProviderType.pickerOrder, id: \.self) { provider in
                    Text(provider.displayName)
                        .tag(provider)
                }
            }
            .accessibilityIdentifier("telephony-provider-picker")
        } header: {
            Text(NSLocalizedString("admin_telephony_provider_header", comment: "Voice Provider"))
        } footer: {
            // `provider_setup_description`, the key the desktop provider-setup
            // screen uses. The two footers that used to be here —
            // `admin_telephony_provider_footer` and
            // `admin_telephony_credentials_footer` — were never added to any
            // locale, so this screen rendered those key names as its own copy.
            // `bun run i18n:validate:ios` could not see them: both were written
            // as multi-line `NSLocalizedString(` calls and its patterns are
            // applied per line (#1725).
            Text(NSLocalizedString("provider_setup_description", comment: "Configure your telephony provider"))
                .font(.brand(.caption))
        }
    }

    // MARK: - Credentials Section

    private var credentialsSection: some View {
        Section {
            labelledField(
                title: NSLocalizedString("admin_telephony_account_sid", comment: "Account SID"),
                placeholder: NSLocalizedString(
                    "admin_telephony_account_sid_placeholder",
                    comment: "Enter account SID"
                ),
                identifier: "telephony-account-sid",
                text: $viewModel.telephonyAccountSid
            )

            VStack(alignment: .leading, spacing: 4) {
                fieldLabel(NSLocalizedString("admin_telephony_auth_token", comment: "Auth Token"))

                SecureField(
                    NSLocalizedString(
                        "admin_telephony_auth_token_placeholder",
                        comment: "Enter auth token"
                    ),
                    text: $viewModel.telephonyAuthToken
                )
                .font(.brandMono(.body))
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .accessibilityIdentifier("telephony-auth-token")
            }

            labelledField(
                title: NSLocalizedString("admin_telephony_phone_number", comment: "Phone Number"),
                placeholder: NSLocalizedString(
                    "admin_telephony_phone_placeholder",
                    comment: "+1234567890"
                ),
                identifier: "telephony-phone-number",
                text: $viewModel.telephonyPhoneNumber,
                keyboard: .phonePad
            )
        } header: {
            Text(NSLocalizedString("admin_telephony_credentials_header", comment: "Credentials"))
        }
    }

    private func fieldLabel(_ title: String) -> some View {
        Text(title)
            .font(.brand(.caption))
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
    }

    private func labelledField(
        title: String,
        placeholder: String,
        identifier: String,
        text: Binding<String>,
        keyboard: UIKeyboardType = .default
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            fieldLabel(title)

            TextField(placeholder, text: text)
                .font(.brandMono(.body))
                .keyboardType(keyboard)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .accessibilityIdentifier(identifier)
        }
    }

    // MARK: - Save Section

    private var saveSection: some View {
        Section {
            Button {
                Task { await viewModel.saveTelephonySettings() }
            } label: {
                HStack {
                    Spacer()
                    if viewModel.isSavingTelephony {
                        ProgressView()
                            .scaleEffect(0.8)
                    } else {
                        Text(NSLocalizedString("admin_save", comment: "Save"))
                            .fontWeight(.semibold)
                    }
                    Spacer()
                }
            }
            .disabled(viewModel.isSavingTelephony)
            .accessibilityIdentifier("telephony-save-button")
        }
    }
}
