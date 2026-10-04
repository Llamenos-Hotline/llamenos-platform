import SwiftUI

// MARK: - RecoveryTeamConfigView

/// Admin view for configuring the hub's recovery team.
/// Permission-gated: requires `recovery:manage`.
struct RecoveryTeamConfigView: View {
    @Bindable var viewModel: AdminViewModel
    @Environment(HubContext.self) private var hubContext
    @Environment(AppState.self) private var appState

    @State private var threshold: Int = 3
    @State private var totalShares: Int = 5
    @State private var delayHours: Int = 24
    @State private var emergencyFloorHours: Int = 4
    @State private var isConfigured = false
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var groupInfo: RecoveryGroupInfo?
    @State private var showRotateConfirmation = false

    var body: some View {
        ZStack {
            if isLoading {
                loadingState
            } else if isConfigured, let info = groupInfo {
                configuredState(info: info)
            } else {
                setupState
            }
        }
        .navigationTitle(NSLocalizedString("recovery_group_title", comment: "Recovery Team"))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: hubContext.activeHubId) {
            await loadRecoveryGroup()
        }
        .alert(
            NSLocalizedString("recovery_group_rotate", comment: "Rotate recovery team"),
            isPresented: $showRotateConfirmation
        ) {
            Button(NSLocalizedString("cancel", comment: "Cancel"), role: .cancel) {}
            Button(NSLocalizedString("recovery_group_rotate", comment: "Rotate"), role: .destructive) {
                Task { await rotateRecoveryGroup() }
            }
        } message: {
            Text(NSLocalizedString("recovery_group_requests_cancel_confirm", comment: ""))
        }
        .accessibilityIdentifier("recovery-team-config-view")
    }

    // MARK: - Loading State

    private var loadingState: some View {
        VStack(spacing: 16) {
            ProgressView()
                .controlSize(.large)
            Text(NSLocalizedString("loading", comment: "Loading..."))
                .font(.brand(.subheadline))
                .foregroundStyle(.secondary)
        }
        .accessibilityIdentifier("recovery-team-loading")
    }

    // MARK: - Setup State

    private var setupState: some View {
        ScrollView {
            VStack(spacing: 24) {
                // Header
                VStack(spacing: 8) {
                    Image(systemName: "person.3.fill")
                        .font(.largeTitle)
                        .foregroundStyle(Color.brandPrimary)
                    Text(NSLocalizedString("recovery_group_title", comment: "Recovery Team"))
                        .font(.brand(.title2))
                        .fontWeight(.bold)
                    Text(NSLocalizedString("recovery_group_description", comment: ""))
                        .font(.brand(.body))
                        .foregroundStyle(Color.brandMutedForeground)
                        .multilineTextAlignment(.center)
                }
                .padding(.top, 32)

                // Configuration form
                recoveryConfigForm

                // Setup button
                Button {
                    Task { await setupRecoveryGroup() }
                } label: {
                    if isSaving {
                        HStack(spacing: 8) {
                            ProgressView()
                                .tint(.white)
                            Text(NSLocalizedString("recovery_group_setting_up", comment: "Setting up..."))
                        }
                    } else {
                        Text(NSLocalizedString("recovery_group_setup", comment: "Set up recovery team"))
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(isSaving || threshold > totalShares)
                .accessibilityIdentifier("setup-recovery-team-button")

                if let errorMessage {
                    Text(errorMessage)
                        .font(.brand(.footnote))
                        .foregroundStyle(Color.brandDestructive)
                        .accessibilityIdentifier("recovery-error")
                }
            }
            .padding()
        }
        .accessibilityIdentifier("recovery-team-setup")
    }

    // MARK: - Configured State

    private func configuredState(info: RecoveryGroupInfo) -> some View {
        List {
            // Status section
            Section {
                LabeledContent(
                    NSLocalizedString("recovery_group_required_approvals", comment: ""),
                    value: "\(Int(info.threshold))"
                )
                .accessibilityIdentifier("recovery-threshold")

                LabeledContent(
                    NSLocalizedString("recovery_group_total_contacts", comment: ""),
                    value: "\(Int(info.totalShares))"
                )
                .accessibilityIdentifier("recovery-total-shares")

                LabeledContent(
                    NSLocalizedString("recovery_group_delay_config", comment: ""),
                    value: "\(Int(info.delayHours))h"
                )

                LabeledContent(
                    NSLocalizedString("recovery_group_emergency_floor_config", comment: ""),
                    value: "\(Int(info.emergencyFloorHours))h"
                )

                if let rotated = info.rotatedAt {
                    LabeledContent(
                        NSLocalizedString("recovery_group_last_rotated", comment: ""),
                        value: rotated
                    )
                }
            } header: {
                Text(NSLocalizedString("recovery_group_title", comment: "Recovery Team"))
            }

            // Contact health section
            Section {
                ForEach(info.shareHolderLiveness, id: \.holderPubkey) { holder in
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(String(holder.holderPubkey.prefix(16)) + "...")
                                .font(.brandMono(.body))
                                .lineLimit(1)

                            if holder.lastLivenessProof != nil {
                                Label(
                                    NSLocalizedString("recovery_group_liveness_ok", comment: "Share verified"),
                                    systemImage: "checkmark.shield.fill"
                                )
                                .font(.brand(.caption))
                                .foregroundStyle(.green)
                            } else {
                                Label(
                                    NSLocalizedString("recovery_group_liveness_stale", comment: "Share verification overdue"),
                                    systemImage: "exclamationmark.triangle.fill"
                                )
                                .font(.brand(.caption))
                                .foregroundStyle(.orange)
                            }
                        }
                        Spacer()
                    }
                    .accessibilityIdentifier("recovery-contact-\(holder.holderPubkey.prefix(8))")
                }
            } header: {
                Text(NSLocalizedString("recovery_group_contact_health", comment: "Contact status"))
            }

            // Geo warning
            Section {
                Label {
                    Text(NSLocalizedString("recovery_group_geo_warning", comment: ""))
                        .font(.brand(.footnote))
                        .foregroundStyle(Color.brandMutedForeground)
                } icon: {
                    Image(systemName: "globe")
                        .foregroundStyle(.orange)
                }
            }

            // Rotate button
            Section {
                Button(role: .destructive) {
                    showRotateConfirmation = true
                } label: {
                    HStack {
                        Image(systemName: "arrow.triangle.2.circlepath")
                        Text(NSLocalizedString("recovery_group_rotate", comment: "Rotate recovery team"))
                    }
                }
                .accessibilityIdentifier("rotate-recovery-team-button")
            }
        }
        .listStyle(.insetGrouped)
        .refreshable {
            await loadRecoveryGroup()
        }
        .accessibilityIdentifier("recovery-team-configured")
    }

    // MARK: - Config Form

    private var recoveryConfigForm: some View {
        VStack(spacing: 16) {
            // Threshold picker
            VStack(alignment: .leading, spacing: 4) {
                Text(NSLocalizedString("recovery_group_required_approvals", comment: "Required approvals"))
                    .font(.brand(.caption))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                Picker(
                    NSLocalizedString("recovery_group_required_approvals", comment: ""),
                    selection: $threshold
                ) {
                    ForEach(2...5, id: \.self) { n in
                        Text("\(n)").tag(n)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("recovery-threshold-picker")
            }

            // Total contacts picker
            VStack(alignment: .leading, spacing: 4) {
                Text(NSLocalizedString("recovery_group_total_contacts", comment: "Total recovery contacts"))
                    .font(.brand(.caption))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                Picker(
                    NSLocalizedString("recovery_group_total_contacts", comment: ""),
                    selection: $totalShares
                ) {
                    ForEach(3...5, id: \.self) { n in
                        Text("\(n)").tag(n)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("recovery-total-picker")
            }

            // Validation error
            if threshold > totalShares {
                Text(NSLocalizedString("recovery_group_error_threshold_exceeds_total", comment: ""))
                    .font(.brand(.caption))
                    .foregroundStyle(Color.brandDestructive)
            }

            // Delay config
            VStack(alignment: .leading, spacing: 4) {
                Text(NSLocalizedString("recovery_group_delay_config", comment: ""))
                    .font(.brand(.caption))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                Stepper(
                    "\(delayHours)h",
                    value: $delayHours,
                    in: 4...168,
                    step: 4
                )
                .accessibilityIdentifier("recovery-delay-stepper")
            }

            // Emergency floor config
            VStack(alignment: .leading, spacing: 4) {
                Text(NSLocalizedString("recovery_group_emergency_floor_config", comment: ""))
                    .font(.brand(.caption))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                Stepper(
                    "\(emergencyFloorHours)h",
                    value: $emergencyFloorHours,
                    in: 1...24,
                    step: 1
                )
                .accessibilityIdentifier("recovery-emergency-floor-stepper")
            }
        }
        .padding()
        .background(Color.brandCard)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Actions

    private func loadRecoveryGroup() async {
        guard let hubId = hubContext.activeHubId else {
            isLoading = false
            return
        }
        isLoading = true
        do {
            let info = try await appState.apiService.getRecoveryGroup(hubId: hubId)
            self.groupInfo = info
            self.isConfigured = true
        } catch {
            self.isConfigured = false
            self.groupInfo = nil
        }
        isLoading = false
    }

    private func setupRecoveryGroup() async {
        guard let hubId = hubContext.activeHubId else { return }
        isSaving = true
        errorMessage = nil
        do {
            let keypair = try appState.cryptoService.recoveryGroupGenerateKeypair()
            let body: [String: Any] = [
                "hubId": hubId,
                "publicKey": keypair.publicKeyHex,
                "threshold": threshold,
                "totalShares": totalShares,
                "delayHours": delayHours,
                "emergencyFloorHours": emergencyFloorHours,
            ]
            _ = try await appState.apiService.enrollRecoveryGroup(body)
            await loadRecoveryGroup()
        } catch {
            errorMessage = error.localizedDescription
        }
        isSaving = false
    }

    private func rotateRecoveryGroup() async {
        guard let info = groupInfo else { return }
        threshold = Int(info.threshold)
        totalShares = Int(info.totalShares)
        delayHours = Int(info.delayHours)
        emergencyFloorHours = Int(info.emergencyFloorHours)
        await setupRecoveryGroup()
    }
}
