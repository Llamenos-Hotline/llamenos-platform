import Foundation

// MARK: - ShiftStatus

/// The volunteer's current shift status.
enum ShiftStatus: Equatable {
    /// Not currently on shift.
    case offShift
    /// On shift and available to receive calls.
    case onShift
    /// On shift but currently on a call.
    case onCall
    /// Loading shift status from the API.
    case loading
    /// Failed to load shift status.
    case error(String)

    var isOnShift: Bool {
        self == .onShift || self == .onCall
    }
}

// MARK: - RecentNotePreview

/// Lightweight preview of a recent note for the dashboard.
struct RecentNotePreview: Identifiable, Sendable {
    let id: String
    let preview: String
    let createdAt: Date
    let hasCall: Bool
    let hasConversation: Bool
}

// MARK: - DashboardViewModel

/// View model for the main dashboard. Loads shift status, recent note previews,
/// and subscribes to WebSocket events for real-time updates.
@Observable
final class DashboardViewModel {
    private let apiService: APIService
    private let cryptoService: CryptoService
    private let webSocketService: WebSocketService
    private let hubContext: HubContext

    /// Current shift status.
    var shiftStatus: ShiftStatus = .offShift

    /// Convenience: whether the volunteer is currently on shift.
    var isOnShift: Bool { shiftStatus.isOnShift }

    /// When the current shift started, for the elapsed timer.
    var shiftStartedAt: Date?

    /// Number of active calls (loaded from API).
    var activeCallCount: Int = 0

    /// The current volunteer's active call (if any).
    var currentCall: ActiveCall?

    /// Number of recent notes (loaded from API).
    var recentNoteCount: Int = 0

    /// Recent note previews (last 3).
    var recentNotes: [RecentNotePreview] = []

    /// Whether the logout confirmation dialog is showing.
    var showLogoutConfirmation: Bool = false

    /// Whether the dashboard is currently loading data.
    var isLoading: Bool = false

    /// Error message from the last failed operation.
    var errorMessage: String?

    /// Active shift timer display string.
    var elapsedTimeDisplay: String {
        guard let startedAt = shiftStartedAt else { return "--:--:--" }
        let elapsed = Date().timeIntervalSince(startedAt)
        let hours = Int(elapsed) / 3600
        let minutes = (Int(elapsed) % 3600) / 60
        let seconds = Int(elapsed) % 60
        return String(format: "%02d:%02d:%02d", hours, minutes, seconds)
    }

    /// Background tasks
    private var eventTask: Task<Void, Never>?
    private var timerTask: Task<Void, Never>?

    init(apiService: APIService, cryptoService: CryptoService, webSocketService: WebSocketService, hubContext: HubContext) {
        self.apiService = apiService
        self.cryptoService = cryptoService
        self.webSocketService = webSocketService
        self.hubContext = hubContext
    }

    // MARK: - Data Loading

    /// Load dashboard data from the API.
    func loadDashboard() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil

        // Fetch shift status, active call, and recent notes in parallel
        async let statusResult: Void = fetchShiftStatus()
        async let notesResult: Void = fetchRecentNotes()
        async let callResult: Void = fetchActiveCall()

        await statusResult
        await notesResult
        await callResult

        isLoading = false
    }

    /// Refresh dashboard data.
    func refresh() async {
        isLoading = false
        await loadDashboard()
    }

    // MARK: - WebSocket Events

    /// Start listening for real-time typed WebSocket events.
    ///
    /// Call events are handled from EVERY member hub, not just the active one
    /// (multi-hub routing axiom): a ring on hub B must surface while hub A is being
    /// browsed. Only browsing data (recent notes) is scoped to the active hub.
    func startEventListener() {
        eventTask?.cancel()
        eventTask = Task { [weak self] in
            guard let self else { return }
            for await attributed in self.webSocketService.attributedEvents {
                guard !Task.isCancelled else { break }
                await self.handleTypedEvent(attributed)
            }
        }
    }

    /// Stop listening for WebSocket events.
    func stopEventListener() {
        eventTask?.cancel()
        eventTask = nil
        stopTimer()
    }

    /// Handle a decrypted, hub-attributed event and refresh only relevant data.
    @MainActor
    private func handleTypedEvent(_ attributed: AttributedHubEvent) {
        switch attributed.event {
        case .callRing, .callAnswered, .callUpdate, .voicemailNew, .presenceSummary, .presenceDetail:
            // Call/presence events on any member hub affect shift status and the active call.
            Task {
                await fetchShiftStatus()
                await fetchActiveCall()
            }
        case .callEnded:
            // Call ended — clear it immediately if it was this hub's call, then refresh
            if currentCall?.hubId == attributed.hubId {
                currentCall = nil
            }
            Task {
                await fetchShiftStatus()
                await fetchActiveCall()
            }
        case .shiftStarted, .shiftEnded, .shiftUpdate:
            Task { await fetchShiftStatus() }
        case .noteCreated:
            // Recent notes are browsing data for the active hub only.
            guard attributed.hubId == hubContext.activeHubId else { return }
            Task { await fetchRecentNotes() }
        case .messageNew, .messageStatus, .conversationNew, .conversationAssigned, .conversationClosed:
            // Message events don't affect dashboard — handled by ConversationsViewModel
            break
        case .deviceWipe, .unknown:
            break
        }
    }

    // MARK: - Timer

    func startTimer() {
        stopTimer()
        timerTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                // Touch a property to trigger @Observable re-evaluation
                self?.shiftStartedAt = self?.shiftStartedAt
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    func stopTimer() {
        timerTask?.cancel()
        timerTask = nil
    }

    // MARK: - Call Actions

    /// Hang up the current active call (on the call's own hub, not the active hub).
    func hangupCall() async {
        guard let call = currentCall else { return }
        do {
            try await apiService.request(method: "POST", path: APIService.hubPath(call.hubId, "/api/calls/\(call.id)/hangup"))
            currentCall = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Report the current active call as spam (on the call's own hub).
    func reportSpam() async {
        guard let call = currentCall else { return }
        do {
            try await apiService.request(method: "POST", path: APIService.hubPath(call.hubId, "/api/calls/\(call.id)/spam"))
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Ban the caller and hang up (on the call's own hub).
    func banAndHangup(reason: String?) async {
        guard let call = currentCall else { return }
        let path = APIService.hubPath(call.hubId, "/api/calls/\(call.id)/ban")
        do {
            let body: [String: String]? = reason.map { ["reason": $0] }
            if let body {
                try await apiService.request(method: "POST", path: path, body: body)
            } else {
                try await apiService.request(method: "POST", path: path)
            }
            currentCall = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Private Helpers

    /// Hubs whose calls the dashboard surfaces: every member hub the relay reported,
    /// with the active hub first (and always present, so single-hub behaviour holds
    /// before the relay has authenticated).
    var callHubIds: [String] {
        var ids: [String] = []
        if let active = hubContext.activeHubId { ids.append(active) }
        for id in webSocketService.memberHubIds where !ids.contains(id) {
            ids.append(id)
        }
        return ids
    }

    /// Fetch the volunteer's active call (if any) across every member hub.
    /// The active hub's call wins when several hubs have one.
    private func fetchActiveCall() async {
        let hubIds = callHubIds
        guard !hubIds.isEmpty else {
            currentCall = nil
            return
        }
        var callsByHub: [String: ProtocolActiveCallsResponse] = [:]
        await withTaskGroup(of: (String, ProtocolActiveCallsResponse?).self) { group in
            for hubId in hubIds {
                group.addTask { [apiService] in
                    // One unreachable hub must not hide another hub's ringing call.
                    let response: ProtocolActiveCallsResponse? = try? await apiService.request(
                        method: "GET",
                        path: APIService.hubPath(hubId, "/api/calls/active")
                    )
                    return (hubId, response)
                }
            }
            for await (hubId, response) in group {
                if let response { callsByHub[hubId] = response }
            }
        }
        guard let (hubId, first) = hubIds.lazy
            .compactMap({ id in callsByHub[id]?.calls.first.map { (id, $0) } })
            .first
        else {
            // No call anywhere. Clear only if every hub answered — a hub whose request
            // failed may still hold the current call; the next event re-checks it.
            if callsByHub.count == hubIds.count { currentCall = nil }
            return
        }
        // Attempt E2EE decryption of call metadata
        var callerNumber = first.callerLast4
        if let encryptedContent = first.encryptedContent,
           let envelopes = first.adminEnvelopes, !envelopes.isEmpty {
            let tuples = envelopes.map { (pubkey: $0.pubkey, enc: $0.enc, ct: $0.ct) }
            if let decrypted = cryptoService.decryptCallMetadata(
                encryptedContent: encryptedContent,
                adminEnvelopes: tuples
            ) {
                callerNumber = decrypted.callerNumber
            }
        }
        currentCall = ActiveCall(
            id: first.id,
            hubId: hubId,
            callerNumber: callerNumber,
            startedAt: DateFormatting.parseISO(first.startedAt) ?? Date(),
            status: first.status?.rawValue ?? "unknown"
        )
    }

    private func fetchShiftStatus() async {
        do {
            let status: DashboardShiftStatusResponse = try await apiService.request(
                method: "GET",
                path: "/api/shifts/my-status"
            )
            shiftStatus = status.onShift ? .onShift : .offShift
            activeCallCount = status.activeCallCount ?? 0
            recentNoteCount = status.recentNoteCount ?? 0

            if status.onShift, let startedAtString = status.startedAt {
                shiftStartedAt = DateFormatting.parseISO(startedAtString)
                startTimer()
            } else {
                shiftStartedAt = nil
                stopTimer()
            }
        } catch {
            shiftStatus = .offShift
            activeCallCount = 0
            if case APIError.noBaseURL = error {
                // Expected when hub isn't configured yet
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func fetchRecentNotes() async {
        do {
            let response: NotesListResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/notes") + "?page=1&limit=3"
            )

            recentNoteCount = response.total

            // Decrypt the recent notes for preview using HPKE envelopes
            recentNotes = response.notes.prefix(3).compactMap { encrypted -> RecentNotePreview? in
                guard let ourPubkey = cryptoService.encryptionPubkeyHex else { return nil }

                var hpkeEnvelope: HpkeEnvelope?

                if encrypted.authorPubkey == ourPubkey, let authorEnv = encrypted.authorEnvelope {
                    hpkeEnvelope = HpkeEnvelope(v: 3, labelId: 0, enc: authorEnv.enc, ct: authorEnv.ct)
                }

                if hpkeEnvelope == nil, let adminEnvs = encrypted.adminEnvelopes {
                    if let ourEnv = adminEnvs.first(where: { $0.pubkey == ourPubkey }) {
                        hpkeEnvelope = HpkeEnvelope(v: 3, labelId: 0, enc: ourEnv.enc, ct: ourEnv.ct)
                    }
                }

                guard let envelope = hpkeEnvelope else { return nil }

                do {
                    let json = try cryptoService.decryptNote(
                        ciphertextHex: encrypted.encryptedContent,
                        envelope: envelope
                    )
                    let decoder = JSONDecoder()
                    decoder.keyDecodingStrategy = .convertFromSnakeCase
                    let payload = try decoder.decode(NotePayload.self, from: Data(json.utf8))

                    let previewText = payload.text.count > 80
                        ? String(payload.text.prefix(80)) + "..."
                        : payload.text

                    return RecentNotePreview(
                        id: encrypted.id,
                        preview: previewText,
                        createdAt: DateFormatting.parseISO(encrypted.createdAt) ?? Date(),
                        hasCall: encrypted.callID != nil,
                        hasConversation: encrypted.conversationID != nil
                    )
                } catch {
                    return nil
                }
            }
        } catch {
            if case APIError.noBaseURL = error {
                // Expected when hub isn't configured yet
            }
            // Don't overwrite shift error
        }
    }


    deinit {
        eventTask?.cancel()
        timerTask?.cancel()
    }
}

// MARK: - API Response Types

/// Response from the shift status endpoint.
private struct DashboardShiftStatusResponse: Decodable {
    let onShift: Bool
    let shiftId: String?
    let startedAt: String?
    let activeCallCount: Int?
    let recentNoteCount: Int?
}

