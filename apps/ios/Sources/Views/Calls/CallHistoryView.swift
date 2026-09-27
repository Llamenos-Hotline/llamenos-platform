import SwiftUI

// MARK: - CallStatus

/// Status of a historical call entry.
enum CallStatus: String, CaseIterable, Sendable {
    case answered
    case missed
    case voicemail

    var displayName: String {
        switch self {
        case .answered: return NSLocalizedString("call_status_answered", comment: "Answered")
        case .missed: return NSLocalizedString("call_status_missed", comment: "Missed")
        case .voicemail: return NSLocalizedString("call_status_voicemail", comment: "Voicemail")
        }
    }

    var icon: String {
        switch self {
        case .answered: return "phone.fill"
        case .missed: return "phone.down.fill"
        case .voicemail: return "voicemail"
        }
    }

    var iconColor: Color {
        switch self {
        case .answered: return .green
        case .missed: return .red
        case .voicemail: return .orange
        }
    }
}

// MARK: - CallHistoryEntry

/// A single call record from the call history API.
struct CallHistoryEntry: Identifiable, Sendable {
    let id: String
    let callerNumber: String?
    let status: CallStatus
    let duration: Int?
    let startedAt: Date
    let answeredBy: String?
}

// MARK: - CallHistoryViewModel

/// View model for loading and filtering call history.
@Observable
final class CallHistoryViewModel {
    private let apiService: APIService
    private let cryptoService: CryptoService

    var calls: [CallHistoryEntry] = []
    var isLoading: Bool = false
    var errorMessage: String?
    var filterStatus: CallStatus?

    /// Filtered calls based on the current status filter.
    var filteredCalls: [CallHistoryEntry] {
        guard let filter = filterStatus else { return calls }
        return calls.filter { $0.status == filter }
    }

    init(apiService: APIService, cryptoService: CryptoService) {
        self.apiService = apiService
        self.cryptoService = cryptoService
    }

    // MARK: - Data Loading

    func loadCallHistory() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil

        do {
            let response: ProtocolCallHistoryResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/calls/history?limit=50")
            )
            calls = response.calls.map { dto in
                let status: CallStatus
                switch dto.status {
                case .some(.completed), .some(.inProgress): status = .answered
                default: status = .missed
                }

                // Attempt E2EE decryption of call metadata (admin envelope)
                var callerNumber = dto.callerLast4
                var answeredBy = dto.answeredBy

                if let encryptedContent = dto.encryptedContent,
                   let envelopes = dto.adminEnvelopes, !envelopes.isEmpty {
                    let tuples = envelopes.map { (pubkey: $0.pubkey, enc: $0.enc, ct: $0.ct) }
                    if let decrypted = cryptoService.decryptCallMetadata(
                        encryptedContent: encryptedContent,
                        adminEnvelopes: tuples
                    ) {
                        callerNumber = decrypted.callerNumber
                        answeredBy = decrypted.answeredBy
                    }
                }

                return CallHistoryEntry(
                    id: dto.id,
                    callerNumber: callerNumber,
                    status: status,
                    duration: dto.duration.map { Int($0) },
                    startedAt: DateFormatting.parseISO(dto.startedAt) ?? Date(),
                    answeredBy: answeredBy
                )
            }
        } catch {
            if case APIError.noBaseURL = error {
                // Expected when hub isn't configured yet
            } else {
                errorMessage = error.localizedDescription
            }
        }

        isLoading = false
    }

    func refresh() async {
        isLoading = false
        await loadCallHistory()
    }
}

// MARK: - CallHistoryView

/// Call history list showing past calls with status filtering and pull-to-refresh.
/// Accessible from the dashboard quick actions (admin) and navigation.
struct CallHistoryView: View {
    @Environment(AppState.self) private var appState
    @Environment(HubContext.self) private var hubContext
    @State private var viewModelBox = ViewModelBox<CallHistoryViewModel>()

    var body: some View {
        let vm = resolvedViewModel

        NavigationStack {
            ZStack {
                if vm.isLoading && vm.calls.isEmpty {
                    ProgressView()
                        .accessibilityIdentifier("call-history-loading")
                } else if let error = vm.errorMessage, vm.calls.isEmpty {
                    BrandEmptyState(
                        icon: "exclamationmark.triangle",
                        title: NSLocalizedString("call_history_error_title", comment: "Unable to Load"),
                        message: error,
                        action: { Task { await vm.refresh() } },
                        actionLabel: NSLocalizedString("common_retry", comment: "Retry"),
                        actionAccessibilityID: "call-history-retry"
                    )
                } else if vm.filteredCalls.isEmpty {
                    BrandEmptyState(
                        icon: "phone.badge.waveform",
                        title: NSLocalizedString("call_history_empty_title", comment: "No Calls"),
                        message: vm.filterStatus != nil
                            ? NSLocalizedString("call_history_empty_filtered", comment: "No calls match this filter.")
                            : NSLocalizedString("call_history_empty_message", comment: "Call history will appear here after calls are received.")
                    )
                    .accessibilityIdentifier("call-history-empty")
                } else {
                    callsList(vm: vm)
                }
            }
            .navigationTitle(NSLocalizedString("call_history_title", comment: "Call History"))
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button {
                            vm.filterStatus = nil
                        } label: {
                            Label(
                                NSLocalizedString("call_filter_all", comment: "All"),
                                systemImage: "line.3.horizontal.decrease.circle"
                            )
                        }
                        ForEach(CallStatus.allCases, id: \.self) { status in
                            Button {
                                vm.filterStatus = status
                            } label: {
                                Label(status.displayName, systemImage: status.icon)
                            }
                        }
                    } label: {
                        Image(systemName: vm.filterStatus != nil
                            ? "line.3.horizontal.decrease.circle.fill"
                            : "line.3.horizontal.decrease.circle")
                    }
                    .accessibilityIdentifier("call-history-filter")
                }
            }
            .refreshable {
                await vm.refresh()
            }
            .task(id: hubContext.activeHubId) {
                await vm.loadCallHistory()
            }
        }
    }

    // MARK: - Calls List

    @ViewBuilder
    private func callsList(vm: CallHistoryViewModel) -> some View {
        List {
            ForEach(vm.filteredCalls) { call in
                callRow(call)
            }
        }
        .listStyle(.plain)
        .accessibilityIdentifier("call-history-list")
    }

    // MARK: - Call Row

    private func callRow(_ call: CallHistoryEntry) -> some View {
        HStack(spacing: 12) {
            // Status icon
            ZStack {
                Circle()
                    .fill(call.status.iconColor.opacity(0.15))
                    .frame(width: 40, height: 40)
                Image(systemName: call.status.icon)
                    .font(.system(size: 16))
                    .foregroundStyle(call.status.iconColor)
            }

            // Call info
            VStack(alignment: .leading, spacing: 2) {
                Text(maskedCallerNumber(call.callerNumber))
                    .font(.brand(.body))
                    .foregroundStyle(Color.brandForeground)

                HStack(spacing: 6) {
                    Text(call.status.displayName)
                        .font(.brand(.caption))
                        .foregroundStyle(call.status.iconColor)

                    if let duration = call.duration, duration > 0 {
                        Text(formatDuration(duration))
                            .font(.brandMono(.caption))
                            .foregroundStyle(Color.brandMutedForeground)
                    }
                }
            }

            Spacer()

            // Timestamp
            VStack(alignment: .trailing, spacing: 2) {
                Text(call.startedAt.formatted(date: .abbreviated, time: .omitted))
                    .font(.brand(.caption))
                    .foregroundStyle(Color.brandMutedForeground)
                Text(call.startedAt.formatted(date: .omitted, time: .shortened))
                    .font(.brand(.footnote))
                    .foregroundStyle(Color.brandMutedForeground)
            }
        }
        .padding(.vertical, 4)
        .accessibilityIdentifier("call-row-\(call.id)")
    }

    // MARK: - Helpers

    /// Mask the caller number for privacy (show last 4 digits only).
    private func maskedCallerNumber(_ number: String?) -> String {
        guard let number, !number.isEmpty else {
            return NSLocalizedString("calls_unknown_caller", comment: "Unknown Caller")
        }
        let digits = number.filter(\.isNumber)
        if digits.count > 4 {
            let lastFour = digits.suffix(4)
            return "***-***-\(lastFour)"
        }
        return number
    }

    /// Format call duration in seconds to mm:ss or hh:mm:ss.
    private func formatDuration(_ seconds: Int) -> String {
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        let secs = seconds % 60
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, secs)
        }
        return String(format: "%d:%02d", minutes, secs)
    }

    // MARK: - ViewModel Resolution

    private var resolvedViewModel: CallHistoryViewModel {
        if let vm = viewModelBox.value {
            return vm
        }
        // AppState owns the one CryptoService. This view used to read it from the
        // SwiftUI environment, where nothing ever injected it: opening Call History
        // trapped with "No Observable object of type CryptoService found".
        let vm = CallHistoryViewModel(apiService: appState.apiService, cryptoService: appState.cryptoService)
        viewModelBox.value = vm
        return vm
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Call History") {
    CallHistoryView()
        .environment(AppState(hubContext: HubContext()))
        .environment(HubContext())
        .environment(Router())
}
#endif
