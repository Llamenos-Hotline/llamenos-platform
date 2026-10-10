import SwiftUI

// MARK: - RecoveryRequestsView

/// Admin view for managing account recovery requests.
/// Permission-gated: `recovery:view` for viewing, `recovery:hold-share` for approving.
struct RecoveryRequestsView: View {
    @Bindable var viewModel: AdminViewModel
    @Environment(HubContext.self) private var hubContext
    @Environment(AppState.self) private var appState

    @State private var sessions: [RecoverySessionSummary] = []
    @State private var isLoading = true
    @State private var selectedSession: RecoverySessionSummary?
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
                summary: session,
                loadSession: { try await appState.apiService.getRecoverySession(sessionId: session.sessionId) },
                isApproving: $isApproving,
                errorMessage: $errorMessage,
                onApprove: { await approveRecovery(sessionId: session.sessionId) },
                onUrgent: { showUrgentSheet = true },
                onCancel: { await cancelRecovery(sessionId: session.sessionId) },
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
            let active = sessions.filter { ["pending", "verified", "active"].contains($0.status) }
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

            let history = sessions.filter { ["completed", "expired", "cancelled"].contains($0.status) }
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
        guard let hubId = hubContext.activeHubId else {
            isLoading = false
            return
        }
        do {
            let fetched = try await appState.apiService.listRecoverySessions(hubId: hubId)
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
            let cryptoService = appState.cryptoService
            guard cryptoService.isUnlocked,
                  let signingPubkey = cryptoService.signingPubkeyHex else {
                errorMessage = NSLocalizedString("recovery_group_error_device_locked", comment: "Device must be unlocked")
                isApproving = false
                return
            }

            // The summary row omits contributions; the approve flow needs the
            // full session record.
            let session = try await appState.apiService.getRecoverySession(sessionId: sessionId)

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

            // Decrypt our stored Shamir share using HPKE.
            // The sealed payload is the 33-byte share (x byte || 32-byte y) —
            // NOT a 32-byte key — so this is hpkeOpen, not hpkeOpenKey: the
            // key variant rejects anything that is not exactly 32 bytes, which
            // would fail every envelope enrolment writes (#1032).
            let shareHex = try cryptoService.hpkeOpen(
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
    let request: RecoverySessionSummary
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(String(request.userPubkey.prefix(16)) + "...")
                        .font(.brandMono(.body))
                        .lineLimit(1)
                    Spacer()
                    RecoveryStatusBadge(status: request.status)
                }

                HStack(spacing: 16) {
                    Label {
                        Text(request.expiresAt.prefix(10))
                    } icon: {
                        Image(systemName: "clock")
                            .font(.caption)
                    }
                    .font(.brand(.caption))
                    .foregroundStyle(Color.brandMutedForeground)

                    if request.signalVerified {
                        Label {
                            Text(NSLocalizedString("recovery_group_requests_status_verified", comment: ""))
                        } icon: {
                            Image(systemName: "checkmark.badge.fill")
                                .font(.caption)
                        }
                        .font(.brand(.caption))
                        .foregroundStyle(.green)
                    }
                }
            }
            .padding(.vertical, 4)
        }
        .accessibilityIdentifier("recovery-request-\(request.sessionId.prefix(8))")
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
    let summary: RecoverySessionSummary
    let loadSession: () async throws -> RecoverySessionStatusResponse
    @Binding var isApproving: Bool
    @Binding var errorMessage: String?
    let onApprove: () async -> Void
    let onUrgent: () -> Void
    let onCancel: () async -> Void
    let onDismiss: () -> Void

    @State private var session: RecoverySessionStatusResponse?

    var body: some View {
        NavigationStack {
            Group {
                if let session {
                    detailList(session)
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationTitle(NSLocalizedString("recovery_group_requests_title", comment: ""))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("cancel", comment: "Cancel")) {
                        onDismiss()
                    }
                }
            }
            .task {
                session = try? await loadSession()
            }
        }
    }

    private func detailList(_ session: RecoverySessionStatusResponse) -> some View {
        List {
            // Status
            Section {
                LabeledContent("Status") {
                    RecoveryStatusBadge(status: session.status.rawValue)
                }
                LabeledContent(
                    NSLocalizedString("recovery_group_requests_approval_progress", comment: ""),
                    value: "\(Int(session.contributionCount)) / \(Int(session.threshold))"
                )
                let remaining = Int(session.delayRemainingMS)
                if remaining > 0 {
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
                LabeledContent("User", value: String(session.userPubkey.prefix(24)) + "...")
                LabeledContent("New Device", value: String(session.newDevicePubkey.prefix(24)) + "...")
                LabeledContent("Session", value: session.sessionID)
            }

            // Actions
            if [.verified, .active].contains(session.status) {
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
    }
}
