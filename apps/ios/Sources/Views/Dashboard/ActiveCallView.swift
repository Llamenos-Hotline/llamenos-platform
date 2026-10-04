import SwiftUI

// MARK: - ActiveCall Model

/// Represents a call currently in progress for this volunteer.
struct ActiveCall: Identifiable, Sendable {
    let id: String
    /// The hub the call belongs to. Call actions (hang up, spam, ban) target this hub,
    /// which need not be the active hub (multi-hub routing axiom).
    let hubId: String
    let callerNumber: String?
    let startedAt: Date
    let status: String
}

// MARK: - ActiveCallView

/// In-call action panel shown on the dashboard when the volunteer has an active call.
/// Provides call timer, hang up, report spam, ban + hang up (with reason), and quick note.
struct ActiveCallView: View {
    let call: ActiveCall
    let onHangup: () async -> Void
    let onReportSpam: () async -> Void
    let onBanAndHangup: (String?) async -> Void
    let onQuickNote: () -> Void

    @State private var showBanSheet: Bool = false
    @State private var banReason: String = ""
    @State private var isHangingUp: Bool = false
    @State private var isReportingSpam: Bool = false
    @State private var isBanning: Bool = false

    var body: some View {
        BrandCard {
            VStack(spacing: 16) {
                // Header: call icon + info + timer
                headerSection

                Divider()

                // Action buttons
                actionButtons

                // Quick note button
                quickNoteButton
            }
            .padding(16)
        }
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.blue.opacity(0.5), lineWidth: 2)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("active-call-card")
        .sheet(isPresented: $showBanSheet) {
            banReasonSheet
        }
    }

    // MARK: - Header

    private var headerSection: some View {
        HStack {
            // Call icon
            ZStack {
                Circle()
                    .fill(Color.blue.opacity(0.15))
                    .frame(width: 44, height: 44)
                Image(systemName: "phone.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(Color.blue)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(NSLocalizedString("calls_active", comment: "Active Call"))
                    .font(.brand(.headline))
                    .foregroundStyle(Color.blue)
                Text(call.callerNumber ?? NSLocalizedString("calls_unknown_caller", comment: "Unknown Caller"))
                    .font(.brand(.caption))
                    .foregroundStyle(Color.brandMutedForeground)
            }

            Spacer()

            // Elapsed timer
            VStack(alignment: .trailing, spacing: 2) {
                TimelineView(.periodic(from: call.startedAt, by: 1.0)) { context in
                    Text(formatElapsed(from: call.startedAt, to: context.date))
                        .font(.brandMono(.title2))
                        .fontWeight(.bold)
                        .foregroundStyle(Color.blue)
                        .contentTransition(.numericText())
                }
                .accessibilityIdentifier("call-elapsed-timer")

                Text(NSLocalizedString("calls_duration", comment: "Duration"))
                    .font(.brand(.footnote))
                    .foregroundStyle(Color.brandMutedForeground)
            }
        }
    }

    // MARK: - Action Buttons

    private var actionButtons: some View {
        VStack(spacing: 8) {
        HStack(spacing: 12) {
            // Hang up
            Button {
                Task {
                    isHangingUp = true
                    await onHangup()
                    isHangingUp = false
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "phone.down.fill")
                    Text(NSLocalizedString("calls_hang_up", comment: "Hang Up"))
                        .fontWeight(.semibold)
                }
                .font(.brand(.subheadline))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(Color.red, in: RoundedRectangle(cornerRadius: 8))
            }
            .disabled(isHangingUp)
            .opacity(isHangingUp ? 0.6 : 1.0)
            .accessibilityIdentifier("hangup-button")

            // Report spam
            Button {
                Task {
                    isReportingSpam = true
                    await onReportSpam()
                    isReportingSpam = false
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                    Text(NSLocalizedString("calls_report_spam", comment: "Report as Spam"))
                        .fontWeight(.medium)
                }
                .font(.brand(.subheadline))
                .foregroundStyle(Color.yellow.opacity(0.9))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Color.yellow.opacity(0.5), lineWidth: 1.5)
                )
            }
            .disabled(isReportingSpam)
            .opacity(isReportingSpam ? 0.6 : 1.0)
            .accessibilityIdentifier("report-spam-button")
        }

        // Ban & Hang Up (full width)
        Button {
            showBanSheet = true
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "shield.slash.fill")
                Text(NSLocalizedString("call_actions_ban_and_hang_up", comment: "Ban & Hang Up"))
                    .fontWeight(.medium)
            }
            .font(.brand(.subheadline))
            .foregroundStyle(Color.red)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Color.red.opacity(0.5), lineWidth: 1.5)
            )
        }
        .accessibilityIdentifier("ban-hangup-button")
        } // VStack
    }

    // MARK: - Quick Note

    private var quickNoteButton: some View {
        Button(action: onQuickNote) {
            HStack(spacing: 6) {
                Image(systemName: "note.text.badge.plus")
                Text(NSLocalizedString("calls_add_note", comment: "Add Note"))
                    .fontWeight(.medium)
            }
            .font(.brand(.subheadline))
            .foregroundStyle(Color.brandPrimary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color.brandPrimary.opacity(0.08))
            )
        }
        .accessibilityIdentifier("quick-note-button")
    }

    // MARK: - Ban Reason Sheet

    private var banReasonSheet: some View {
        NavigationStack {
            Form {
                Section {
                    Text(NSLocalizedString("call_actions_ban_and_hang_up_confirm", comment: "Ban this caller and end the call?"))
                        .font(.brand(.body))
                        .foregroundStyle(Color.brandForeground)
                }

                Section {
                    TextField(
                        NSLocalizedString("call_actions_ban_reason", comment: "Reason (optional)"),
                        text: $banReason
                    )
                    .accessibilityIdentifier("ban-reason-input")
                }
            }
            .navigationTitle(NSLocalizedString("call_actions_ban_and_hang_up", comment: "Ban & Hang Up"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("common_cancel", comment: "Cancel")) {
                        showBanSheet = false
                        banReason = ""
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task {
                            isBanning = true
                            showBanSheet = false
                            let reason = banReason.trimmingCharacters(in: .whitespacesAndNewlines)
                            await onBanAndHangup(reason.isEmpty ? nil : reason)
                            banReason = ""
                            isBanning = false
                        }
                    } label: {
                        Text(NSLocalizedString("call_actions_ban_and_hang_up", comment: "Ban & Hang Up"))
                            .foregroundStyle(.red)
                            .fontWeight(.semibold)
                    }
                    .disabled(isBanning)
                    .accessibilityIdentifier("ban-confirm-button")
                }
            }
        }
        .presentationDetents([.medium])
    }

    // MARK: - Helpers

    private func formatElapsed(from start: Date, to now: Date) -> String {
        let elapsed = max(0, now.timeIntervalSince(start))
        let hours = Int(elapsed) / 3600
        let minutes = (Int(elapsed) % 3600) / 60
        let seconds = Int(elapsed) % 60
        return String(format: "%02d:%02d:%02d", hours, minutes, seconds)
    }
}
