import SwiftUI

/// Main dashboard screen shown after successful authentication. Uses a branded
/// ScrollView layout with hero shift card, activity stats, quick actions grid,
/// identity strip, and recent notes.
struct DashboardView: View {
    @Environment(AppState.self) private var appState
    @Environment(Router.self) private var router
    @Environment(HubContext.self) private var hubContext
    @State private var viewModelBox = ViewModelBox<DashboardViewModel>()
    @State private var quickActionDestination: QuickActionDestination?

    var body: some View {
        let vm = resolvedViewModel

        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    // Offline queue banner
                    OfflineBanner()

                    // Hidden identity for accessibility (BrandCard overlay blocks child identifiers)
                    if let signingPubkey = appState.cryptoService.signingPubkeyHex {
                        Text(signingPubkey)
                            .font(.brandMono(.caption))
                            .accessibilityIdentifier("dashboard-identity")
                            .frame(height: 0)
                            .clipped()
                    }

                    // 0. Active call panel (shown above everything when on a call)
                    if let call = vm.currentCall {
                        ActiveCallView(
                            call: call,
                            onHangup: { await vm.hangupCall() },
                            onReportSpam: { await vm.reportSpam() },
                            onBanAndHangup: { reason in await vm.banAndHangup(reason: reason) },
                            onQuickNote: {
                                // Navigate to note creation — could be handled via
                                // a sheet or navigation destination in the future
                            }
                        )
                    }

                    // 1. Hero shift card
                    heroShiftCard(vm: vm)

                    // 2. Quick actions grid (early for reachability)
                    quickActionsGrid

                    // 3. Identity & connection strip
                    identityConnectionStrip

                    // 4. Activity stats row
                    activityStatsRow(vm: vm)

                    // 5. Recent notes section
                    if !vm.recentNotes.isEmpty {
                        recentNotesSection(vm: vm)
                    }

                    // 6. Error banner
                    if let error = vm.errorMessage {
                        errorBanner(error)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
            }
            .navigationBarHidden(true)
            .accessibilityIdentifier("dashboard-title")
            .refreshable {
                await vm.refresh()
            }
            .safeAreaInset(edge: .top) {
                HStack {
                    Text(NSLocalizedString("dashboard_title", comment: "Dashboard"))
                        .font(.brand(.headline))
                        .fontWeight(.bold)
                    Spacer()
                    Button {
                        appState.lockApp()
                    } label: {
                        Image(systemName: "lock.fill")
                            .foregroundStyle(Color.brandPrimary)
                    }
                    .accessibilityIdentifier("lock-app")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(.bar)
            }
            .navigationDestination(item: $quickActionDestination) { destination in
                switch destination {
                case .reports:
                    ReportsView()
                case .cases:
                    CaseListView()
                case .contacts:
                    ContactsView()
                case .blasts:
                    BlastsView()
                case .help:
                    HelpView()
                case .triage:
                    TriageListView()
                case .callHistory:
                    CallHistoryView()
                }
            }
            .task(id: hubContext.activeHubId) {
                await vm.loadDashboard()
                vm.startEventListener()
            }
            .onDisappear {
                vm.stopEventListener()
            }
        }
    }

    // MARK: - Hero Shift Card

    @ViewBuilder
    private func heroShiftCard(vm: DashboardViewModel) -> some View {
        BrandCard {
            VStack(spacing: 12) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            StatusDot(status: vm.isOnShift ? .active : .inactive, animated: vm.isOnShift)
                            Text(vm.isOnShift
                                ? NSLocalizedString("dashboard_on_shift", comment: "On Shift")
                                : NSLocalizedString("dashboard_off_shift", comment: "Off Shift"))
                                .font(.brand(.headline))
                                .foregroundStyle(Color.brandForeground)
                        }
                        .accessibilityIdentifier("shift-status-text")

                        if vm.isOnShift {
                            Text(vm.elapsedTimeDisplay)
                                .font(.brandMono(.title2))
                                .foregroundStyle(Color.statusActive)
                                .contentTransition(.numericText())
                                .accessibilityIdentifier("shift-elapsed-timer")
                        }
                    }

                    Spacer()

                    shiftStatusBadge(vm.shiftStatus)
                }
            }
            .padding(16)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("shift-status-card")
    }

    // MARK: - Activity Stats Row

    @ViewBuilder
    private func activityStatsRow(vm: DashboardViewModel) -> some View {
        HStack(spacing: 12) {
            BrandCard {
                VStack(spacing: 4) {
                    Text("\(vm.activeCallCount)")
                        .font(.brand(.title))
                        .fontWeight(.bold)
                        .foregroundStyle(Color.brandPrimary)
                        .contentTransition(.numericText())
                        .accessibilityIdentifier("active-call-count")
                    Text(NSLocalizedString("dashboard_calls", comment: "Calls"))
                        .font(.brand(.caption))
                        .foregroundStyle(Color.brandMutedForeground)
                }
                .frame(maxWidth: .infinity)
                .padding(12)
            }
            .accessibilityIdentifier("active-calls-card")

            BrandCard {
                VStack(spacing: 4) {
                    Text("\(vm.recentNoteCount)")
                        .font(.brand(.title))
                        .fontWeight(.bold)
                        .foregroundStyle(Color.brandAccent)
                        .contentTransition(.numericText())
                        .accessibilityIdentifier("recent-note-count")
                    Text(NSLocalizedString("dashboard_notes", comment: "Notes"))
                        .font(.brand(.caption))
                        .foregroundStyle(Color.brandMutedForeground)
                }
                .frame(maxWidth: .infinity)
                .padding(12)
            }
            .accessibilityIdentifier("recent-notes-card")
        }
    }

    // MARK: - Quick Actions Grid

    private var quickActionsGrid: some View {
        Grid(horizontalSpacing: 12, verticalSpacing: 12) {
            GridRow {
                quickActionCard(
                    title: NSLocalizedString("dashboard_reports", comment: "Reports"),
                    icon: "doc.text.fill",
                    destination: .reports,
                    accessibilityID: "dashboard-reports-action"
                )

                quickActionCard(
                    title: NSLocalizedString("dashboard_cases", comment: "Cases"),
                    icon: "folder.fill",
                    destination: .cases,
                    accessibilityID: "dashboard-cases-action"
                )
            }

            GridRow {
                quickActionCard(
                    title: NSLocalizedString("dashboard_call_history", comment: "Call History"),
                    icon: "clock.arrow.circlepath",
                    destination: .callHistory,
                    accessibilityID: "dashboard-call-history-action"
                )

                quickActionCard(
                    title: NSLocalizedString("dashboard_help", comment: "Help"),
                    icon: "questionmark.circle.fill",
                    destination: .help,
                    accessibilityID: "dashboard-help-action"
                )
            }

            // Two per row, whichever of the restricted screens this user may open.
            let restricted = restrictedQuickActions
            ForEach(Array(stride(from: 0, to: restricted.count, by: 2)), id: \.self) { start in
                GridRow {
                    ForEach(restricted[start..<min(start + 2, restricted.count)]) { action in
                        quickActionCard(
                            title: action.title,
                            icon: action.icon,
                            destination: action.destination,
                            accessibilityID: action.accessibilityID
                        )
                    }
                }
            }
        }
    }

    private struct QuickAction: Identifiable {
        let title: String
        let icon: String
        let destination: QuickActionDestination
        let accessibilityID: String
        var id: String { accessibilityID }
    }

    /// Quick actions for screens only some roles can use, each shown only with the
    /// permission its screen's API requires (apps/worker/routes: contacts-v2 →
    /// contacts:view, blasts → blasts:read, records triage → reports:triage).
    /// They were all gated on settings:read, which every volunteer holds, so
    /// volunteers were offered three screens the server then refused.
    private var restrictedQuickActions: [QuickAction] {
        [
            ("contacts:view", QuickAction(
                title: NSLocalizedString("dashboard_contacts", comment: "Contacts"),
                icon: "person.crop.circle.badge.clock",
                destination: .contacts,
                accessibilityID: "dashboard-contacts-action"
            )),
            ("blasts:read", QuickAction(
                title: NSLocalizedString("dashboard_blasts", comment: "Message Blasts"),
                icon: "megaphone.fill",
                destination: .blasts,
                accessibilityID: "dashboard-blasts-action"
            )),
            ("reports:triage", QuickAction(
                title: NSLocalizedString("dashboard_triage", comment: "Triage"),
                icon: "tray.and.arrow.down.fill",
                destination: .triage,
                accessibilityID: "dashboard-triage-action"
            )),
        ]
        .filter { appState.hasPermission($0.0) }
        .map { $0.1 }
    }

    private func quickActionCard(title: String, icon: String, destination: QuickActionDestination, accessibilityID: String) -> some View {
        Button {
            quickActionDestination = destination
        } label: {
            VStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.title2)
                    .foregroundStyle(Color.brandPrimary)
                Text(title)
                    .font(.brand(.caption))
                    .fontWeight(.medium)
                    .foregroundStyle(Color.brandForeground)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .padding(.horizontal, 16)
            .background(
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color.brandCard)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(Color.brandBorder, lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.04), radius: 2, y: 1)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(accessibilityID)
    }

    // MARK: - Identity & Connection Strip

    private var identityConnectionStrip: some View {
        BrandCard(padding: 12) {
            VStack(spacing: 8) {
                if let signingPubkey = appState.cryptoService.signingPubkeyHex {
                    CopyableField(
                        label: NSLocalizedString("dashboard_identity", comment: "Identity"),
                        value: signingPubkey
                    )
                }

                Divider()

                HStack {
                    StatusDot(status: connectionDotState, animated: appState.webSocketService.connectionState == .connected)
                    Text(appState.webSocketService.connectionState.displayText)
                        .font(.brand(.caption))
                        .foregroundStyle(Color.brandMutedForeground)

                    Spacer()

                    if let hubURL = appState.authService.hubURL {
                        Text(hubURL)
                            .font(.brand(.caption))
                            .foregroundStyle(Color.brandMutedForeground)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                .accessibilityIdentifier("connection-status")
            }
        }
        .accessibilityIdentifier("dashboard-connection-card")
    }

    private var connectionDotState: StatusDot.Status {
        switch appState.webSocketService.connectionState {
        case .connected: return .active
        case .connecting, .reconnecting(_): return .warning
        case .disconnected: return .inactive
        }
    }

    // MARK: - Recent Notes Section

    @ViewBuilder
    private func recentNotesSection(vm: DashboardViewModel) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(NSLocalizedString("dashboard_recent_notes", comment: "Recent Notes"))
                .font(.brand(.headline))
                .foregroundStyle(Color.brandForeground)
                .padding(.leading, 4)

            ForEach(vm.recentNotes.prefix(3)) { note in
                BrandCard {
                    HStack(alignment: .top, spacing: 10) {
                        Text(note.preview)
                            .font(.brand(.caption))
                            .foregroundStyle(Color.brandForeground)
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, alignment: .leading)

                        VStack(alignment: .trailing, spacing: 2) {
                            Text(note.createdAt.formatted(date: .omitted, time: .shortened))
                                .font(.brand(.footnote))
                                .foregroundStyle(Color.brandMutedForeground)

                            HStack(spacing: 4) {
                                if note.hasCall {
                                    Image(systemName: "phone.fill")
                                        .font(.caption2)
                                        .foregroundStyle(Color.brandPrimary)
                                }
                                if note.hasConversation {
                                    Image(systemName: "message.fill")
                                        .font(.caption2)
                                        .foregroundStyle(Color.statusActive)
                                }
                            }
                        }
                    }
                    .padding(12)
                }
                .accessibilityIdentifier("recent-note-\(note.id)")
            }
        }
    }

    // MARK: - Error Banner

    private func errorBanner(_ error: String) -> some View {
        BrandCard {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Color.brandAccent)
                Text(error)
                    .font(.brand(.footnote))
                    .foregroundStyle(Color.brandMutedForeground)
            }
            .padding(12)
        }
        .accessibilityIdentifier("dashboard-error")
    }

    // MARK: - Quick Action Destination

    enum QuickActionDestination: Hashable {
        case reports
        case cases
        case contacts
        case blasts
        case help
        case triage
        case callHistory
    }

    // MARK: - Shift Status Badge

    @ViewBuilder
    private func shiftStatusBadge(_ status: ShiftStatus) -> some View {
        switch status {
        case .onShift:
            Text(NSLocalizedString("badge_on_shift", comment: "On Shift"))
                .font(.brand(.caption))
                .fontWeight(.semibold)
                .foregroundStyle(.green)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Capsule().fill(Color.green.opacity(0.15)))
        case .onCall:
            Text(NSLocalizedString("badge_on_call", comment: "On Call"))
                .font(.brand(.caption))
                .fontWeight(.semibold)
                .foregroundStyle(.blue)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Capsule().fill(Color.blue.opacity(0.15)))
        case .offShift:
            Text(NSLocalizedString("badge_off_shift", comment: "Off Shift"))
                .font(.brand(.caption))
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Capsule().fill(Color(.systemGray5)))
        case .loading:
            ProgressView()
                .scaleEffect(0.7)
        case .error:
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(.red)
        }
    }

    // MARK: - ViewModel Resolution

    private var resolvedViewModel: DashboardViewModel {
        if let vm = viewModelBox.value {
            return vm
        }
        let vm = DashboardViewModel(
            apiService: appState.apiService,
            cryptoService: appState.cryptoService,
            webSocketService: appState.webSocketService,
            hubContext: hubContext
        )
        viewModelBox.value = vm
        return vm
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Dashboard - Off Shift") {
    NavigationStack {
        DashboardView()
            .environment(AppState(hubContext: HubContext()))
            .environment(Router())
    }
}
#endif
