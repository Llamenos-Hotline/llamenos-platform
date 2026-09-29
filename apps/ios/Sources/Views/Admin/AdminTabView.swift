import SwiftUI

// MARK: - AdminTabView

/// Container view for admin management screens. Provides a list-based navigation
/// menu (replacing the segmented picker) for Volunteers, Ban List, Audit Log,
/// Invites, and Custom Fields.
struct AdminTabView: View {
    @Environment(AppState.self) private var appState
    @State private var viewModelBox = ViewModelBox<AdminViewModel>()

    var body: some View {
        let vm = resolvedViewModel

        List {
            NavigationLink {
                UsersView(viewModel: vm)
            } label: {
                Label(
                    NSLocalizedString("admin_tab_users", comment: "Volunteers"),
                    systemImage: "person.3.fill"
                )
            }
            .accessibilityIdentifier("admin-volunteers")

            NavigationLink {
                BanListView(viewModel: vm)
            } label: {
                Label(
                    NSLocalizedString("admin_tab_bans", comment: "Ban List"),
                    systemImage: "hand.raised.fill"
                )
            }
            .accessibilityIdentifier("admin-bans")

            NavigationLink {
                AuditLogView(viewModel: vm)
            } label: {
                Label(
                    NSLocalizedString("admin_tab_audit", comment: "Audit Log"),
                    systemImage: "list.clipboard.fill"
                )
            }
            .accessibilityIdentifier("admin-audit-log")

            NavigationLink {
                InviteView(viewModel: vm)
            } label: {
                Label(
                    NSLocalizedString("admin_tab_invites", comment: "Invites"),
                    systemImage: "envelope.open.fill"
                )
            }
            .accessibilityIdentifier("admin-invites")

            NavigationLink {
                CustomFieldsView(viewModel: vm)
            } label: {
                Label(
                    NSLocalizedString("admin_tab_fields", comment: "Custom Fields"),
                    systemImage: "list.bullet.rectangle.fill"
                )
            }
            .accessibilityIdentifier("admin-custom-fields")

            NavigationLink {
                SchemaBrowserView()
            } label: {
                Label(
                    NSLocalizedString("admin_schema_browser", comment: "Entity Types"),
                    systemImage: "doc.text.magnifyingglass"
                )
            }
            .accessibilityIdentifier("admin-schema-browser")

            NavigationLink {
                EventListView()
            } label: {
                Label(
                    NSLocalizedString("events_title", comment: "Events"),
                    systemImage: "calendar"
                )
            }
            .accessibilityIdentifier("admin-events")

            // MARK: - Provider Setup Section

            Section(header: Text(NSLocalizedString("admin_provider_setup", comment: "Provider Auto-Configuration"))) {
                NavigationLink {
                    ProviderSetupView(appState: appState)
                } label: {
                    Label(
                        NSLocalizedString("admin_provider_setup", comment: "Provider Auto-Configuration"),
                        systemImage: "antenna.radiowaves.left.and.right"
                    )
                }
                .accessibilityIdentifier("admin-provider-setup")

                NavigationLink {
                    SignalRegistrationView(appState: appState)
                } label: {
                    Label(
                        NSLocalizedString("admin_signal_registration", comment: "Signal Registration"),
                        systemImage: "bubble.left.and.exclamationmark.bubble.right.fill"
                    )
                }
                .accessibilityIdentifier("admin-signal-registration")
            }

            // MARK: - Recovery Section

            Section(header: Text(NSLocalizedString("admin_nav_items_recovery_group", comment: "Recovery Group"))) {
                NavigationLink {
                    RecoveryTeamConfigView(viewModel: vm)
                } label: {
                    Label(
                        NSLocalizedString("recovery_group_title", comment: "Recovery Team"),
                        systemImage: "person.badge.shield.checkmark.fill"
                    )
                }
                .accessibilityIdentifier("admin-recovery-team")

                NavigationLink {
                    RecoveryRequestsView(viewModel: vm)
                } label: {
                    Label(
                        NSLocalizedString("recovery_group_requests_title", comment: "Recovery Requests"),
                        systemImage: "arrow.counterclockwise.circle.fill"
                    )
                }
                .accessibilityIdentifier("admin-recovery-requests")
            }

            // MARK: - Settings Section

            Section(header: Text(NSLocalizedString("admin_settings_section", comment: "Settings"))) {
                NavigationLink {
                    ReportCategoriesView(viewModel: vm)
                } label: {
                    Label(
                        NSLocalizedString("admin_report_categories", comment: "Report Categories"),
                        systemImage: "tag.fill"
                    )
                }
                .accessibilityIdentifier("admin-report-categories")

                NavigationLink {
                    TelephonySettingsView(viewModel: vm)
                } label: {
                    Label(
                        NSLocalizedString("admin_telephony_settings", comment: "Telephony"),
                        systemImage: "phone.connection.fill"
                    )
                }
                .accessibilityIdentifier("admin-telephony-settings")

                NavigationLink {
                    CallSettingsView(viewModel: vm)
                } label: {
                    Label(
                        NSLocalizedString("admin_call_settings", comment: "Call Settings"),
                        systemImage: "slider.horizontal.3"
                    )
                }
                .accessibilityIdentifier("admin-call-settings")

                NavigationLink {
                    IvrSettingsView(viewModel: vm)
                } label: {
                    Label(
                        NSLocalizedString("admin_ivr_settings", comment: "IVR Languages"),
                        systemImage: "globe"
                    )
                }
                .accessibilityIdentifier("admin-ivr-settings")

                NavigationLink {
                    AdminTranscriptionSettingsView(viewModel: vm)
                } label: {
                    Label(
                        NSLocalizedString("admin_transcription_settings", comment: "Transcription"),
                        systemImage: "text.word.spacing"
                    )
                }
                .accessibilityIdentifier("admin-transcription-settings")

                NavigationLink {
                    SpamSettingsView(viewModel: vm)
                } label: {
                    Label(
                        NSLocalizedString("admin_spam_settings", comment: "Spam Settings"),
                        systemImage: "shield.lefthalf.filled"
                    )
                }
                .accessibilityIdentifier("admin-spam-settings")

                NavigationLink {
                    ErasureQueueView(viewModel: vm)
                } label: {
                    Label(
                        NSLocalizedString("erasure_admin_queue_title", comment: "Erasure Queue"),
                        systemImage: "person.crop.circle.badge.minus"
                    )
                }
                .accessibilityIdentifier("admin-erasure-queue")

                NavigationLink {
                    RetentionSettingsView(viewModel: vm)
                } label: {
                    Label(
                        NSLocalizedString("retention_title", comment: "Data Retention"),
                        systemImage: "clock.arrow.circlepath"
                    )
                }
                .accessibilityIdentifier("admin-retention-settings")

                NavigationLink {
                    SystemHealthView(viewModel: vm)
                } label: {
                    Label(
                        NSLocalizedString("admin_system_health", comment: "System Health"),
                        systemImage: "heart.text.square.fill"
                    )
                }
                .accessibilityIdentifier("admin-system-health")
            }
        }
        .navigationTitle(NSLocalizedString("admin_title", comment: "Admin"))
        .navigationBarTitleDisplayMode(.large)
        .alert(
            NSLocalizedString("admin_delete_confirm_title", comment: "Confirm Deletion"),
            isPresented: Binding(
                get: { vm.showDeleteConfirmation },
                set: { vm.showDeleteConfirmation = $0 }
            )
        ) {
            Button(NSLocalizedString("cancel", comment: "Cancel"), role: .cancel) {
                vm.cancelDelete()
            }
            Button(NSLocalizedString("delete", comment: "Delete"), role: .destructive) {
                Task { await vm.executeDelete() }
            }
        } message: {
            Text(NSLocalizedString(
                "admin_delete_confirm_message",
                comment: "Are you sure you want to delete this item? This action cannot be undone."
            ))
        }
        .tint(Color.brandPrimary)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("admin-tab-view")
    }

    // MARK: - ViewModel Resolution

    private var resolvedViewModel: AdminViewModel {
        if let vm = viewModelBox.value {
            return vm
        }
        let vm = AdminViewModel(
            apiService: appState.apiService,
            cryptoService: appState.cryptoService
        )
        viewModelBox.value = vm
        return vm
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Admin Panel") {
    NavigationStack {
        AdminTabView()
            .environment(AppState(hubContext: HubContext()))
    }
}
#endif
