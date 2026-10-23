import SwiftUI

// MARK: - RecoveryRequestsView

/// Admin view for managing account recovery requests.
/// Permission-gated: `recovery:view` for viewing, `recovery:hold-share` for approving.
struct RecoveryRequestsView: View {
    @Bindable var viewModel: AdminViewModel
    @Environment(HubContext.self) private var hubContext
    @Environment(AppState.self) private var appState

    @State private var sessions: [RecoverySessionStatusResponse] = []
    @State private var isLoading = true
    @State private var selectedSession: RecoverySessionStatusResponse?
    @State private var showUrgentSheet = false
    @State private var isApproving = false
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            if isLoading && sessions.isEmpty {
                loadingState
            } else if sessions.isEmpty {
                emptyState
            } else {
                requestList
            }
        }
        .navigationTitle(NSLocalizedString("recovery_group_requests_title", comment: "Account Recovery Requests"))
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $selectedSession) { session in
            RecoveryRequestDetailSheet(
                request: session,
                isApproving: $isApproving,
                errorMessage: $errorMessage,
                onApprove: { await approveRecovery(sessionId: session.sessionID) },
                onUrgent: { showUrgentSheet = true },
                onCancel: { await cancelRecovery(sessionId: session.sessionID) },
                onDismiss: { selectedSession = nil }
            )
        }
        .refreshable {
            await loadRecoveryRequests()
        }
        .task(id: hubContext.activeHubId) {
            await loadRecoveryRequests()
        }
    }

    // MARK: - Request List

    private var requestList: some View {
        List {
            let active = sessions.filter { ["pending", "verified", "active"].contains($0.status.rawValue) }
            if !active.isEmpty {
                Section {
                    ForEach(active) { request in
                        RecoveryRequestRow(request: request) {
                            selectedSession = request
                        }
                    }
                } header: {
                    Text(NSLocalizedString("recovery_group_requests_active", comment: "Active requests"))
                }
            }

            let history = sessions.filter { ["completed", "expired", "cancelled"].contains($0.status.rawValue) }
            if !history.isEmpty {
                Section {
                    ForEach(history) { request in
                        RecoveryRequestRow(request: request) {
                            selectedSession = request
                        }
                    }
                } header: {
                    Text(NSLocalizedString("recovery_group_requests_history", comment: "Request history"))
                }
            }
        }
        .listStyle(.insetGrouped)
        .accessibilityIdentifier("recovery-requests-list")
    }

    // MARK: - Empty / Loading

    private var emptyState: some View {
        ContentUnavailableView {
            Label(
                NSLocalizedString("recovery_group_requests_title", comment: "Account Recovery Requests"),
                systemImage: "person.badge.key"
            )
        } description: {
            Text(NSLocalizedString("recovery_group_no_team", comment: "No recovery team configured"))
        }
        .accessibilityIdentifier("recovery-requests-empty")
    }

    private var loadingState: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text(NSLocalizedString("loading", comment: "Loading..."))
                .font(.brand(.subheadline))
                .foregroundStyle(Color.brandMutedForeground)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("recovery-requests-loading")
    }

    // MARK: - Actions

    private func loadRecoveryRequests() async {
        do {
            let fetched = try await appState.apiService.listRecoverySessions()
            sessions = fetched
        } catch {
            // Non-fatal: show empty state rather than blocking the UI
            #if DEBUG
            print("[Recovery] Failed to load sessions: \(error.localizedDescription)")
            #endif
        }
        isLoading = false
    }

    private func approveRecovery(sessionId: String) async {
        isApproving = true
        errorMessage = nil
        do {
            guard let session = sessions.first(where: { $0.sessionID == sessionId }) else {
                errorMessage = NSLocalizedString("recovery_group_error_session_not_found", comment: "Session not found")
                isApproving = false
                return
            }

            let cryptoService = appState.cryptoService
            guard cryptoService.isUnlocked,
                  let signingPubkey = cryptoService.signingPubkeyHex else {
                errorMessage = NSLocalizedString("recovery_group_error_device_locked", comment: "Device must be unlocked")
                isApproving = false
                return
            }

            // Check if we already contributed
            if session.contributions.contains(where: { $0.contributorPubkey == signingPubkey }) {
                errorMessage = NSLocalizedString("recovery_group_error_already_approved", comment: "Already approved")
                isApproving = false
                return
            }

            // Fetch our encrypted share envelope from the server
            guard let hubId = hubContext.activeHubId else {
                errorMessage = NSLocalizedString("error_no_hub_url", comment: "No hub selected")
                isApproving = false
                return
            }

            let shareData = try await appState.apiService.getMyShareEnvelope(hubId: hubId)

            // Parse the HPKE envelope from the stored share
            let envelopeData = shareData.shareEnvelope.data(using: .utf8) ?? Data()
            let envelope = try JSONDecoder().decode(HpkeEnvelope.self, from: envelopeData)

            // Decrypt our stored Shamir share using HPKE
            let shareHex = try cryptoService.hpkeOpenKey(
                envelope: envelope,
                expectedLabel: CryptoLabels.LABEL_RECOVERY_GROUP_SHARE_WRAP,
                aadHex: ""
            )

            // Verify share against commitment if available
            if let commitment = shareData.shareCommitment {
                // Parse share: first byte is x-coordinate, rest is y-value
                let xByte = UInt8(shareHex.prefix(2), radix: 16) ?? 0
                let yHex = String(shareHex.dropFirst(2))
                let share = ShamirShare(x: xByte, yHex: yHex)
                let valid = try cryptoService.shamirVerify(share: share, commitment: commitment)
                if !valid {
                    errorMessage = NSLocalizedString("recovery_group_error_commitment_failed", comment: "Share commitment verification failed")
                    isApproving = false
                    return
                }
            }

            // HPKE-seal share to the recovering user's new device pubkey
            // AAD = sessionId:contributorPubkey (hex-encoded UTF-8)
            let aadString = "\(sessionId):\(signingPubkey)"
            let aadHex = aadString.data(using: .utf8)!.map { String(format: "%02x", $0) }.joined()

            let contribution = try cryptoService.hpkeSeal(
                plaintextHex: shareHex,
                recipientPubkeyHex: session.newDevicePubkey,
                label: CryptoLabels.LABEL_RECOVERY_SHARE_CONTRIBUTE,
                aadHex: aadHex
            )

            // Sign the contribution: ed25519Sign(JSON(envelope) + ":" + sessionId)
            let encoder = JSONEncoder()
            encoder.outputFormatting = .sortedKeys
            let contributionJSON = String(data: try encoder.encode(contribution), encoding: .utf8)!
            let sigPayload = "\(contributionJSON):\(sessionId)"
            let sigPayloadHex = sigPayload.data(using: .utf8)!.map { String(format: "%02x", $0) }.joined()
            let signature = try cryptoService.ed25519Sign(messageHex: sigPayloadHex)

            // Submit the contribution
            _ = try await appState.apiService.contributeRecoveryShare(
                sessionId: sessionId,
                encryptedShare: contributionJSON,
                contributorSignature: signature
            )
            await loadRecoveryRequests()
        } catch {
            errorMessage = error.localizedDescription
        }
        isApproving = false
    }

    private func cancelRecovery(sessionId: String) async {
        do {
            _ = try await appState.apiService.cancelRecoverySession(sessionId: sessionId)
            await loadRecoveryRequests()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - RecoveryRequestRow

struct RecoveryRequestRow: View {
    let request: RecoverySessionStatusResponse
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(String(request.userPubkey.prefix(16)) + "...")
                        .font(.brandMono(.body))
                        .lineLimit(1)
                    Spacer()
                    RecoveryStatusBadge(status: request.status.rawValue)
                }

                HStack(spacing: 16) {
                    Label {
                        Text("\(request.contributionCount) / \(request.threshold)")
                    } icon: {
                        Image(systemName: "person.fill.checkmark")
                            .font(.caption)
                    }
                    .font(.brand(.caption))
                    .foregroundStyle(Color.brandMutedForeground)

                    if request.delayRemainingMS > 0 {
                        let remaining = Int(request.delayRemainingMS)
                        Label {
                            Text(formatDelay(ms: Int(remaining)))
                        } icon: {
                            Image(systemName: "clock")
                                .font(.caption)
                        }
                        .font(.brand(.caption))
                        .foregroundStyle(Color.brandMutedForeground)
                    }
                }
            }
            .padding(.vertical, 4)
        }
        .accessibilityIdentifier("recovery-request-\(request.sessionID.prefix(8))")
    }

    private func formatDelay(ms: Int) -> String {
        let hours = ms / 3_600_000
        let minutes = (ms % 3_600_000) / 60_000
        if hours > 0 { return "\(hours)h \(minutes)m" }
        return "\(minutes)m"
    }
}

// MARK: - RecoveryStatusBadge

struct RecoveryStatusBadge: View {
    let status: String

    var body: some View {
        Text(statusText)
            .font(.brand(.caption2))
            .fontWeight(.medium)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(statusColor.opacity(0.15))
            .foregroundStyle(statusColor)
            .clipShape(Capsule())
    }

    private var statusText: String {
        switch status {
        case "pending": return NSLocalizedString("recovery_group_requests_status_pending", comment: "")
        case "verified": return NSLocalizedString("recovery_group_requests_status_verified", comment: "")
        case "active": return NSLocalizedString("recovery_group_requests_status_active", comment: "")
        case "completed": return NSLocalizedString("recovery_group_requests_status_completed", comment: "")
        case "expired": return NSLocalizedString("recovery_group_requests_status_expired", comment: "")
        case "cancelled": return NSLocalizedString("recovery_group_requests_status_cancelled", comment: "")
        default: return status
        }
    }

    private var statusColor: Color {
        switch status {
        case "pending": return .orange
        case "verified": return .blue
        case "active": return .green
        case "completed": return .green
        case "expired": return .gray
        case "cancelled": return .red
        default: return .gray
        }
    }
}

// MARK: - RecoveryRequestDetailSheet

struct RecoveryRequestDetailSheet: View {
    let request: RecoverySessionStatusResponse
    @Binding var isApproving: Bool
    @Binding var errorMessage: String?
    let onApprove: () async -> Void
    let onUrgent: () -> Void
    let onCancel: () async -> Void
    let onDismiss: () -> Void

    var body: some View {
        NavigationStack {
            List {
                // Status
                Section {
                    LabeledContent("Status") {
                        RecoveryStatusBadge(status: request.status.rawValue)
                    }
                    LabeledContent(
                        NSLocalizedString("recovery_group_requests_approval_progress", comment: ""),
                        value: "\(request.contributionCount) / \(request.threshold)"
                    )
                    if request.delayRemainingMS > 0 {
                        let remaining = Int(request.delayRemainingMS)
                        let hours = remaining / 3_600_000
                        let minutes = (remaining % 3_600_000) / 60_000
                        LabeledContent(
                            NSLocalizedString("recovery_group_requests_time_remaining", comment: ""),
                            value: hours > 0 ? "\(hours)h \(minutes)m" : "\(minutes)m"
                        )
                    }
                }

                // User info
                Section {
                    LabeledContent("User", value: String(request.userPubkey.prefix(24)) + "...")
                    LabeledContent("New Device", value: String(request.newDevicePubkey.prefix(24)) + "...")
                    LabeledContent("Session", value: request.sessionID)
                }

                // Actions
                if ["verified", "active"].contains(request.status.rawValue) {
                    Section {
                        Button {
                            Task { await onApprove() }
                        } label: {
                            HStack {
                                Image(systemName: "checkmark.shield.fill")
                                if isApproving {
                                    Text(NSLocalizedString("recovery_group_requests_approving", comment: ""))
                                    ProgressView()
                                } else {
                                    Text(NSLocalizedString("recovery_group_requests_approve", comment: "Approve recovery"))
                                }
                            }
                        }
                        .disabled(isApproving)
                        .accessibilityIdentifier("approve-recovery-button")

                        Button {
                            onUrgent()
                        } label: {
                            HStack {
                                Image(systemName: "bolt.fill")
                                Text(NSLocalizedString("recovery_group_urgent_enable", comment: "Enable urgent recovery"))
                            }
                        }
                        .foregroundStyle(.orange)
                        .accessibilityIdentifier("urgent-recovery-button")

                        Button(role: .destructive) {
                            Task { await onCancel() }
                        } label: {
                            HStack {
                                Image(systemName: "xmark.circle.fill")
                                Text(NSLocalizedString("recovery_group_requests_cancel", comment: "Cancel request"))
                            }
                        }
                        .accessibilityIdentifier("cancel-recovery-button")
                    }
                }

                // Error
                if let error = errorMessage {
                    Section {
                        Text(error)
                            .font(.brand(.footnote))
                            .foregroundStyle(Color.brandDestructive)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(NSLocalizedString("recovery_group_requests_title", comment: ""))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("cancel", comment: "Cancel")) {
                        onDismiss()
                    }
                }
            }
        }
    }
}
