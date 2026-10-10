import SwiftUI

// MARK: - RecoveryHolderCandidate

/// A hub member eligible to hold a recovery share: their account pubkey plus
/// the X25519 encryption pubkey of their most recently seen registered device,
/// mapped from the admin device overview.
struct RecoveryHolderCandidate: Identifiable {
    let pubkey: String
    let displayName: String?
    let encryptionPubkey: String
    let deviceVerified: Bool
    let lastSeen: String?

    var id: String { pubkey }
}

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
    @State private var candidates: [RecoveryHolderCandidate] = []
    @State private var selectedHolders: Set<String> = []

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
                rotateRecoveryGroup()
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

    private var holderCountValid: Bool { selectedHolders.count == totalShares }

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

                // Share holder picker
                holderPicker

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
                .disabled(isSaving || threshold > totalShares || !holderCountValid)
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

    // MARK: - Holder Picker

    private var holderPicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(NSLocalizedString("recovery_group_contacts", comment: "Recovery contacts"))
                .font(.brand(.caption))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)

            if !holderCountValid {
                Text(L10n.format("recovery_group_select_exactly", comment: "", totalShares))
                    .font(.brand(.caption))
                    .foregroundStyle(Color.brandMutedForeground)
            }

            if candidates.isEmpty {
                Text(NSLocalizedString("recovery_group_no_contacts", comment: ""))
                    .font(.brand(.footnote))
                    .foregroundStyle(Color.brandMutedForeground)
                    .padding(.vertical, 8)
            } else {
                ForEach(candidates) { candidate in
                    let isSelected = selectedHolders.contains(candidate.pubkey)
                    Button {
                        toggleHolder(candidate.pubkey)
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "person.fill")
                                .foregroundStyle(Color.brandMutedForeground)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(candidate.displayName ?? String(candidate.pubkey.prefix(16)) + "…")
                                    .font(.brand(.body))
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)
                                Text(String(candidate.pubkey.prefix(16)) + "…")
                                    .font(.brandMono(.caption))
                                    .foregroundStyle(Color.brandMutedForeground)
                                    .lineLimit(1)
                            }
                            Spacer()
                            Image(systemName: candidate.deviceVerified ? "checkmark.shield.fill" : "exclamationmark.triangle.fill")
                                .foregroundStyle(candidate.deviceVerified ? .green : .orange)
                                .accessibilityLabel(NSLocalizedString(
                                    candidate.deviceVerified ? "recovery_group_device_verified" : "recovery_group_device_unverified",
                                    comment: ""
                                ))
                            if isSelected {
                                Text(NSLocalizedString("recovery_group_selected", comment: "Selected"))
                                    .font(.brand(.caption))
                                    .fontWeight(.medium)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 2)
                                    .background(Color.brandPrimary.opacity(0.15))
                                    .foregroundStyle(Color.brandPrimary)
                                    .clipShape(Capsule())
                            }
                        }
                        .padding(10)
                        .background(isSelected ? Color.brandPrimary.opacity(0.08) : Color.clear)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("recovery-holder-\(candidate.pubkey.prefix(8))")
                }
            }
        }
        .padding()
        .background(Color.brandCard)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .accessibilityIdentifier("recovery-holder-picker")
    }

    private func toggleHolder(_ pubkey: String) {
        if selectedHolders.contains(pubkey) {
            selectedHolders.remove(pubkey)
        } else if selectedHolders.count < totalShares {
            selectedHolders.insert(pubkey)
        }
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
        async let candidatesFetch = loadCandidates(hubId: hubId)
        do {
            let info = try await appState.apiService.getRecoveryGroup(hubId: hubId)
            self.groupInfo = info
            self.isConfigured = true
        } catch APIError.requestFailed(let statusCode, _) where statusCode == 404 {
            self.isConfigured = false
            self.groupInfo = nil
        } catch {
            self.isConfigured = false
            self.groupInfo = nil
            self.errorMessage = error.localizedDescription
        }
        await candidatesFetch
        isLoading = false
    }

    private func loadCandidates(hubId: String) async {
        do {
            let overview = try await appState.apiService.getRecoveryGroupCandidates(hubId: hubId)
            self.candidates = overview.entries.compactMap { entry in
                // Wrap each share to the holder's most recently seen device that
                // registered an X25519 encryption key.
                let device = entry.devices
                    .filter { $0.x25519Pubkey != nil }
                    .sorted { ($0.lastSeenAt ?? $0.registeredAt) > ($1.lastSeenAt ?? $1.registeredAt) }
                    .first
                guard let encryptionPubkey = device?.x25519Pubkey else { return nil }
                return RecoveryHolderCandidate(
                    pubkey: entry.userPubkey,
                    displayName: entry.displayName,
                    encryptionPubkey: encryptionPubkey,
                    deviceVerified: entry.verified,
                    lastSeen: entry.lastSeenAt
                )
            }
        } catch {
            // Candidates are required for enrolment but not for viewing the
            // configured state — an admin without users:manage-devices still
            // gets the status screen.
            self.candidates = []
        }
    }

    private func setupRecoveryGroup() async {
        guard let hubId = hubContext.activeHubId else { return }
        let holders = candidates.filter { selectedHolders.contains($0.pubkey) }
        guard holders.count == totalShares else { return }
        isSaving = true
        errorMessage = nil
        do {
            let body = try buildEnrollBody(hubId: hubId, holders: holders)
            _ = try await appState.apiService.enrollRecoveryGroup(body)
            selectedHolders = []
            await loadRecoveryGroup()
        } catch {
            errorMessage = error.localizedDescription
        }
        isSaving = false
    }

    /// Build the enrol body exactly as desktop's recovery-group-section.tsx does:
    /// generate the group keypair in Rust, Shamir-split the private key (it never
    /// enters Swift), commit each share, HPKE-wrap one share per holder under
    /// LABEL_RECOVERY_GROUP_SHARE_WRAP, and anchor the enrolment in a sigchain
    /// link whose hash the server stores.
    private func buildEnrollBody(hubId: String, holders: [RecoveryHolderCandidate]) throws -> RecoveryGroupEnroll {
        let crypto = appState.cryptoService
        let isRotation = groupInfo != nil

        let keypair = crypto.recoveryGroupGenerateKeypair()
        let shares = try crypto.recoveryGroupSplitPrivateKey(
            handle: keypair.handle,
            total: UInt8(totalShares),
            threshold: UInt8(threshold)
        )
        let commitments = try shares.map { try crypto.shamirCommit(share: $0) }

        let shareEnvelopes = try zip(shares, holders).map { share, holder in
            let shareHex = String(format: "%02x", share.x) + share.yHex
            let envelope = try crypto.hpkeSeal(
                plaintextHex: shareHex,
                recipientPubkeyHex: holder.encryptionPubkey,
                label: CryptoLabels.LABEL_RECOVERY_GROUP_SHARE_WRAP,
                aadHex: ""
            )
            let envelopeJSON = String(decoding: try JSONEncoder().encode(envelope), as: UTF8.self)
            return ShareEnvelope(holderPubkey: holder.pubkey, shareEnvelope: envelopeJSON)
        }

        let sigchainPayload: [String: Any] = [
            "type": isRotation ? "recovery-group-rotate" : "recovery-group-enroll",
            "groupPublicKey": keypair.publicKeyHex,
            "shareHolderPubkeys": holders.map(\.pubkey),
            "threshold": threshold,
            "totalShares": totalShares,
        ]
        let payloadJSON = String(
            decoding: try JSONSerialization.data(withJSONObject: sigchainPayload),
            as: UTF8.self
        )
        let link = try crypto.createSigchainLink(
            id: UUID().uuidString,
            seq: 1,
            prevHash: nil,
            timestamp: ISO8601DateFormatter().string(from: Date()),
            payloadJson: payloadJSON
        )

        return RecoveryGroupEnroll(
            delayHours: delayHours,
            duressCommitments: nil,
            emergencyFloorHours: emergencyFloorHours,
            groupPublicKey: keypair.publicKeyHex,
            hubID: hubId,
            shareCommitments: commitments,
            shareEnvelopes: shareEnvelopes,
            sigchainLinkHash: link.entryHash,
            threshold: threshold,
            totalShares: totalShares
        )
    }

    /// Rotation replaces the group through the same enrol endpoint (as desktop
    /// does): prefill the form from the current group and let the admin confirm
    /// the holder set before the split/re-wrap runs.
    private func rotateRecoveryGroup() {
        guard let info = groupInfo else { return }
        threshold = Int(info.threshold)
        totalShares = Int(info.totalShares)
        delayHours = Int(info.delayHours)
        emergencyFloorHours = Int(info.emergencyFloorHours)
        selectedHolders = Set(info.shareHolderLiveness.map(\.holderPubkey))
        isConfigured = false
    }
}
