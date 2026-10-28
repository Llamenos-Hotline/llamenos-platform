import SwiftUI

// MARK: - AutoLockTimeout

/// Auto-lock timeout options.
enum AutoLockTimeout: Int, CaseIterable, Identifiable {
    case oneMinute = 60
    case fiveMinutes = 300
    case fifteenMinutes = 900
    case thirtyMinutes = 1800

    var id: Int { rawValue }

    var displayName: String {
        switch self {
        case .oneMinute: return NSLocalizedString("settings_lock1min", comment: "1 minute")
        case .fiveMinutes: return NSLocalizedString("settings_lock5min", comment: "5 minutes")
        case .fifteenMinutes: return NSLocalizedString("settings_lock15min", comment: "15 minutes")
        case .thirtyMinutes: return NSLocalizedString("settings_lock30min", comment: "30 minutes")
        }
    }
}

// MARK: - SupportedLanguage

/// Supported languages for the app.
///
/// NOTE: This list must be kept in sync with the full locale set in
/// packages/i18n/languages.ts (the source of truth) — it previously only
/// listed 13 of the 22 locales that actually ship complete translations
/// (packages/i18n/locales/*.json), which meant the app's language picker
/// silently made 9 fully-translated locales unreachable in the UI:
/// am, fa, ku, mix, my, quc, so, tr, uk. Ideally this array is generated
/// from packages/i18n/languages.ts rather than hand-maintained; tracked as
/// a follow-up (see fix(i18n): derive locale lists dynamically PR).
struct SupportedLanguage: Identifiable, Hashable {
    let id: String  // locale code
    let name: String

    static let all: [SupportedLanguage] = [
        SupportedLanguage(id: "en", name: "English"),
        SupportedLanguage(id: "es", name: "Espa\u{00F1}ol"),
        SupportedLanguage(id: "zh", name: "\u{4E2D}\u{6587}"),
        SupportedLanguage(id: "tl", name: "Tagalog"),
        SupportedLanguage(id: "vi", name: "Ti\u{1EBF}ng Vi\u{1EC7}t"),
        SupportedLanguage(id: "ar", name: "\u{0627}\u{0644}\u{0639}\u{0631}\u{0628}\u{064A}\u{0629}"),
        SupportedLanguage(id: "fr", name: "Fran\u{00E7}ais"),
        SupportedLanguage(id: "ht", name: "Krey\u{00F2}l Ayisyen"),
        SupportedLanguage(id: "ko", name: "\u{D55C}\u{AD6D}\u{C5B4}"),
        SupportedLanguage(id: "ru", name: "\u{0420}\u{0443}\u{0441}\u{0441}\u{043A}\u{0438}\u{0439}"),
        SupportedLanguage(id: "hi", name: "\u{0939}\u{093F}\u{0928}\u{094D}\u{0926}\u{0940}"),
        SupportedLanguage(id: "pt", name: "Portugu\u{00EA}s"),
        SupportedLanguage(id: "de", name: "Deutsch"),
        SupportedLanguage(id: "uk", name: "\u{0423}\u{043A}\u{0440}\u{0430}\u{0457}\u{043D}\u{0441}\u{044C}\u{043A}\u{0430}"),
        SupportedLanguage(id: "fa", name: "\u{0641}\u{0627}\u{0631}\u{0633}\u{06CC}"),
        SupportedLanguage(id: "tr", name: "T\u{00FC}rk\u{00E7}e"),
        SupportedLanguage(id: "ku", name: "Kurd\u{00EE}"),
        SupportedLanguage(id: "so", name: "Soomaali"),
        SupportedLanguage(id: "am", name: "\u{12A0}\u{121B}\u{122D}\u{129B}"),
        SupportedLanguage(id: "my", name: "\u{1019}\u{103C}\u{1014}\u{103A}\u{1019}\u{102C}"),
        SupportedLanguage(id: "quc", name: "K'iche'"),
        SupportedLanguage(id: "mix", name: "Tu'un savi"),
    ]
}

// MARK: - SettingsView

/// Settings navigation hub. Sub-pages handle Account and Preferences details.
struct SettingsView: View {
    @Environment(AppState.self) private var appState

    @State private var showLogoutConfirmation: Bool = false

    var body: some View {
        NavigationStack {
            List {
                #if DEBUG
                // Test-only navigation shortcut for elements deep in the list.
                // SwiftUI List cell recycling breaks NavigationLink taps via XCUITest
                // for cells that require scrolling. This provides a reliable tap target.
                if ProcessInfo.processInfo.arguments.contains("--test-authenticated") {
                    Section {
                        NavigationLink(value: "panic-wipe") {
                            Label {
                                Text(NSLocalizedString("settings_panic_wipe", comment: "Emergency Wipe"))
                                    .foregroundStyle(.red)
                            } icon: {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .foregroundStyle(.red)
                            }
                        }
                        .accessibilityIdentifier("test-panic-wipe")
                    }
                }
                #endif

                // Identity card summary
                identityCardSection

                // Navigation links to sub-pages
                navigationSection

                // Actions section (lock, logout)
                actionsSection

                // Emergency section
                emergencySection

                // App info section
                appInfoSection
            }
            .listStyle(.insetGrouped)
            .navigationTitle(NSLocalizedString("settings_title", comment: "Settings"))
            .navigationBarTitleDisplayMode(.large)
            .alert(
                NSLocalizedString("logout_confirm_title", comment: "Logout"),
                isPresented: $showLogoutConfirmation
            ) {
                Button(NSLocalizedString("cancel", comment: "Cancel"), role: .cancel) {}
                Button(NSLocalizedString("logout_confirm_action", comment: "Logout"), role: .destructive) {
                    Task { await appState.logOut() }
                }
            } message: {
                Text(NSLocalizedString(
                    "logout_confirm_message",
                    comment: "This will remove your identity from this device. Make sure you have backed up your secret key."
                ))
            }
            .navigationDestination(for: String.self) { destination in
                switch destination {
                case "hubs":
                    HubManagementView()
                case "communications":
                    HubCommunicationsView()
                case "account":
                    AccountSettingsView()
                case "preferences":
                    PreferencesSettingsView()
                case "transcription":
                    TranscriptionSettingsView(transcriptionService: appState.transcriptionService)
                case "diagnostics":
                    DiagnosticsSettingsView()
                case "admin":
                    AdminTabView()
                case "help":
                    HelpView()
                case "panic-wipe":
                    PanicWipeConfirmationView()
                case "reports":
                    ReportsView()
                case "security-devices":
                    DeviceListView()
                case "security-sessions":
                    SessionListView()
                case "security-history":
                    SecurityEventsView()
                default:
                    EmptyView()
                }
            }
        }
    }

    // MARK: - Identity Card Section

    private var identityCardSection: some View {
        Section {
            HStack(spacing: 14) {
                if let signingPubkey = appState.cryptoService.signingPubkeyHex {
                    GeneratedAvatar(hash: signingPubkey, size: 48)
                } else {
                    GeneratedAvatar(hash: "unknown", size: 48)
                }

                VStack(alignment: .leading, spacing: 4) {
                    if let signingPubkey = appState.cryptoService.signingPubkeyHex {
                        Text(signingPubkey.truncatedPubkey())
                            .font(.brandMono(.subheadline))
                            .foregroundStyle(Color.brandForeground)
                            .lineLimit(1)
                            .accessibilityIdentifier("settings-signing-pubkey")
                    }

                    HStack(spacing: 8) {
                        BadgeView(
                            text: appState.userRole.displayName,
                            icon: appState.isAdmin ? "shield.fill" : "person.fill",
                            color: appState.isAdmin ? Color.brandDarkTeal : Color.brandPrimary,
                            style: .subtle
                        )
                        .accessibilityIdentifier("settings-role")

                        if let hubURL = appState.authService.hubURL {
                            Text(hubURL)
                                .font(.brand(.caption2))
                                .foregroundStyle(Color.brandMutedForeground)
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .accessibilityIdentifier("settings-hub-url")
                        }
                    }
                }

                Spacer()

                HStack(spacing: 6) {
                    Circle()
                        .fill(appState.webSocketService.connectionState.color)
                        .frame(width: 8, height: 8)
                    Text(appState.webSocketService.connectionState.displayText)
                        .font(.brand(.caption2))
                        .foregroundStyle(Color.brandMutedForeground)
                }
                .accessibilityIdentifier("settings-connection")
            }
            .padding(.vertical, 4)
        }
    }

    // MARK: - Navigation Section

    private var navigationSection: some View {
        Section {
            NavigationLink(value: "hubs") {
                Label {
                    Text(NSLocalizedString("hubs_title", comment: "Hubs"))
                        .foregroundStyle(.primary)
                } icon: {
                    Image(systemName: "building.2.fill")
                        .foregroundStyle(Color.brandPrimary)
                }
            }
            .accessibilityIdentifier("settings-hubs-link")

            if appState.hasPermission("settings:read") {
                NavigationLink(value: "communications") {
                    Label {
                        Text(NSLocalizedString("hub_onboarding_settings_title", comment: "Communications"))
                            .foregroundStyle(.primary)
                    } icon: {
                        Image(systemName: "phone.badge.waveform")
                            .foregroundStyle(Color.brandPrimary)
                    }
                }
                .accessibilityIdentifier("settings-communications-link")
            }

            NavigationLink(value: "account") {
                Label {
                    Text(NSLocalizedString("settings_account_title", comment: "Account"))
                        .foregroundStyle(.primary)
                } icon: {
                    Image(systemName: "person.crop.circle")
                        .foregroundStyle(Color.brandPrimary)
                }
            }
            .accessibilityIdentifier("settings-account-link")

            NavigationLink(value: "preferences") {
                Label {
                    Text(NSLocalizedString("settings_preferences_title", comment: "Preferences"))
                        .foregroundStyle(.primary)
                } icon: {
                    Image(systemName: "gearshape")
                        .foregroundStyle(Color.brandPrimary)
                }
            }
            .accessibilityIdentifier("settings-preferences-link")

            NavigationLink(value: "transcription") {
                Label {
                    Text(NSLocalizedString("transcription_title", comment: "Transcription"))
                        .foregroundStyle(.primary)
                } icon: {
                    Image(systemName: "waveform")
                        .foregroundStyle(Color.brandPrimary)
                }
            }
            .accessibilityIdentifier("settings-transcription-link")

            if appState.hasPermission("audit:read") {
                NavigationLink(value: "admin") {
                    Label {
                        Text(NSLocalizedString("settings_admin", comment: "Admin Panel"))
                            .foregroundStyle(.primary)
                    } icon: {
                        Image(systemName: "shield.lefthalf.filled")
                            .foregroundStyle(Color.brandDarkTeal)
                    }
                }
                .accessibilityIdentifier("settings-admin-link")
            }

            // EP02: Security sub-pages
            NavigationLink(value: "security-devices") {
                Label {
                    Text(NSLocalizedString("security_tabs_devices", comment: "Devices"))
                        .foregroundStyle(.primary)
                } icon: {
                    Image(systemName: "iphone")
                        .foregroundStyle(Color.brandPrimary)
                }
            }
            .accessibilityIdentifier("settings-security-devices-link")

            NavigationLink(value: "security-sessions") {
                Label {
                    Text(NSLocalizedString("security_tabs_sessions", comment: "Sessions"))
                        .foregroundStyle(.primary)
                } icon: {
                    Image(systemName: "key.fill")
                        .foregroundStyle(Color.brandPrimary)
                }
            }
            .accessibilityIdentifier("settings-security-sessions-link")

            NavigationLink(value: "security-history") {
                Label {
                    Text(NSLocalizedString("security_history_title", comment: "Security History"))
                        .foregroundStyle(.primary)
                } icon: {
                    Image(systemName: "clock.fill")
                        .foregroundStyle(Color.brandPrimary)
                }
            }
            .accessibilityIdentifier("settings-security-history-link")

            NavigationLink(value: "diagnostics") {
                Label {
                    Text(NSLocalizedString("crash_reporting_settings_title", comment: "Diagnostics"))
                        .foregroundStyle(.primary)
                } icon: {
                    Image(systemName: "ant.fill")
                        .foregroundStyle(Color.brandPrimary)
                }
            }
            .accessibilityIdentifier("settings-diagnostics-link")

            NavigationLink(value: "help") {
                Label {
                    Text(NSLocalizedString("settings_help", comment: "Help & FAQ"))
                        .foregroundStyle(.primary)
                } icon: {
                    Image(systemName: "questionmark.circle")
                        .foregroundStyle(Color.brandPrimary)
                }
            }
            .accessibilityIdentifier("settings-help")
        }
    }

    // MARK: - Actions Section

    private var actionsSection: some View {
        Section {
            Button {
                appState.lockApp()
            } label: {
                Label {
                    Text(NSLocalizedString("settings_lock", comment: "Lock App"))
                        .foregroundStyle(.primary)
                } icon: {
                    Image(systemName: "lock.fill")
                        .foregroundStyle(Color.brandAccent)
                }
            }
            .accessibilityIdentifier("settings-lock-app")

            Button(role: .destructive) {
                showLogoutConfirmation = true
            } label: {
                Label {
                    Text(NSLocalizedString("settings_logout", comment: "Logout"))
                } icon: {
                    Image(systemName: "rectangle.portrait.and.arrow.right")
                        .foregroundStyle(.red)
                }
            }
            .accessibilityIdentifier("settings-logout")
        } header: {
            Text(NSLocalizedString("settings_actions_header", comment: "Actions"))
        }
    }

    // MARK: - Emergency Section

    private var emergencySection: some View {
        Section {
            NavigationLink(value: "panic-wipe") {
                Label {
                    Text(NSLocalizedString("settings_panic_wipe", comment: "Emergency Wipe"))
                        .foregroundStyle(Color.brandDestructive)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Color.brandDestructive)
                }
            }
            .accessibilityIdentifier("settings-panic-wipe")
        } footer: {
            Text(NSLocalizedString(
                "settings_emergency_footer",
                comment: "Permanently deletes all data from this device including your identity keys."
            ))
        }
    }

    // MARK: - App Info Section

    private var appInfoSection: some View {
        Section {
            LabeledContent {
                Text(appVersion)
                    .font(.brand(.subheadline))
                    .foregroundStyle(.secondary)
            } label: {
                Label {
                    Text(NSLocalizedString("settings_version", comment: "Version"))
                } icon: {
                    Image(systemName: "info.circle")
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityIdentifier("settings-version")

            LabeledContent {
                Text(buildNumber)
                    .font(.brand(.subheadline))
                    .foregroundStyle(.tertiary)
            } label: {
                Label {
                    Text(NSLocalizedString("settings_build", comment: "Build"))
                } icon: {
                    Image(systemName: "hammer")
                        .foregroundStyle(.tertiary)
                }
            }
        } header: {
            Text(NSLocalizedString("settings_about_header", comment: "About"))
        } footer: {
            Text(NSLocalizedString("settings_footer", comment: "Llamenos - Secure Crisis Response"))
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.top, 8)
        }
    }

    // MARK: - Helpers

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0"
    }

    private var buildNumber: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Settings") {
    SettingsView()
        .environment(AppState(hubContext: HubContext()))
}
#endif
