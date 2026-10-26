import Foundation

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
///
/// Main-actor isolated, like `CaseManagementViewModel` (#1918). `DashboardView` reads
/// every property here on the main thread, so every write must happen there too.
/// Without the isolation each `async` method ran on the global executor (Swift 5.9
/// semantics for a nonisolated async function): Thread Sanitizer reports
/// `fetchRecentNotes()` writing `recentNoteCount` on a GCD worker while
/// `DashboardView.activityStatsRow` reads it, and `shiftStatus` / `activeCallCount`
/// read mid-write in the hero card. A write that lands while the body is being
/// evaluated is not reliably observed, so the dashboard could keep showing stale shift
/// state after the server had answered. Network calls still suspend off the main
/// thread inside `APIService`; only the state changes are pinned here.
@MainActor
@Observable
final class DashboardViewModel {
    private let apiService: APIService
    private let cryptoService: CryptoService
    private let webSocketService: WebSocketService
    private let hubContext: HubContext
    private let shiftClockService: ShiftClockService

    /// What the server will do with a ring for this volunteer: scheduled ∧ clocked in ∧ not
    /// on break, on any member hub (rings come from all of them, not just the one being
    /// browsed). Nil until the server has answered.
    ///
    /// Read from `ShiftClockService`, i.e. from `GET /shifts/my-status` per hub — never from
    /// its scheduled-only `onShift` by itself, which made this card say "On Shift" for a
    /// volunteer the server was not ringing (#2204, the iOS counterpart of #2108).
    var readiness: ShiftReadiness? { shiftClockService.readiness(across: callHubIds) }

    /// When the volunteer started being rung, for the elapsed timer.
    var shiftStartedAt: Date? { shiftClockService.readySince(across: callHubIds) }

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
        // Reading `tick` subscribes the view to the once-a-second timer invalidations.
        _ = tick
        guard let startedAt = shiftStartedAt else { return "--:--:--" }
        let elapsed = Date().timeIntervalSince(startedAt)
        let hours = Int(elapsed) / 3600
        let minutes = (Int(elapsed) % 3600) / 60
        let seconds = Int(elapsed) % 60
        return String(format: "%02d:%02d:%02d", hours, minutes, seconds)
    }

    /// Background tasks. Exempt from main-actor isolation only so the nonisolated
    /// `deinit` can cancel them: a `Task` handle is `Sendable` and `cancel()` is
    /// thread-safe, every other read and write happens on the main actor, and `deinit`
    /// runs once the last reference is gone, so nothing can race it. Not observed —
    /// no view reads them.
    @ObservationIgnored nonisolated(unsafe) private var eventTask: Task<Void, Never>?
    @ObservationIgnored nonisolated(unsafe) private var timerTask: Task<Void, Never>?

    /// Bumped once a second while ringing so the elapsed-time display re-evaluates.
    private var tick: Int = 0

    /// Nonisolated: it only stores its arguments, so the model can be built anywhere —
    /// every state change after construction still happens on the main actor.
    nonisolated init(
        apiService: APIService,
        cryptoService: CryptoService,
        webSocketService: WebSocketService,
        hubContext: HubContext,
        shiftClockService: ShiftClockService
    ) {
        self.apiService = apiService
        self.cryptoService = cryptoService
        self.webSocketService = webSocketService
        self.hubContext = hubContext
        self.shiftClockService = shiftClockService
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
    private func handleTypedEvent(_ attributed: AttributedHubEvent) {
        switch attributed.event {
        case .callRing, .callAnswered, .callUpdate, .voicemailNew, .presenceSummary, .presenceDetail:
            // Call/presence events on any member hub affect shift status and the active call.
            Task {
                await fetchShiftStatus(hubIds: [attributed.hubId])
                await fetchActiveCall()
            }
        case .callEnded:
            // Call ended — clear it immediately if it was this hub's call, then refresh
            if currentCall?.hubId == attributed.hubId {
                currentCall = nil
            }
            Task {
                await fetchShiftStatus(hubIds: [attributed.hubId])
                await fetchActiveCall()
            }
        case .shiftStarted, .shiftEnded, .shiftUpdate:
            Task { await fetchShiftStatus(hubIds: [attributed.hubId]) }
        case .noteCreated:
            // Recent notes are browsing data for the active hub only.
            guard attributed.hubId == hubContext.activeHubId else { return }
            Task { await fetchRecentNotes() }
        case .messageNew, .messageStatus, .conversationNew, .conversationAssigned, .conversationClosed, .conversationEnvelopesAdded:
            // Message events don't affect dashboard — handled by ConversationsViewModel
            break
        case .deviceWipe, .unknown:
            break
        }
    }

    // MARK: - Timer

    /// Run the timer while the server is ringing this volunteer, stop it otherwise.
    private func syncTimer() {
        guard readiness?.isRingTarget == true else {
            stopTimer()
            return
        }
        guard timerTask == nil else { return }
        timerTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                self?.tick &+= 1
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
            activeCallCount = 0
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
        activeCallCount = callsByHub.values.reduce(0) { $0 + $1.calls.count }
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

    /// Ask the server where this volunteer stands on `hubIds` (every member hub by default).
    private func fetchShiftStatus(hubIds: [String]? = nil) async {
        let failure = await shiftClockService.refresh(hubIds: hubIds ?? callHubIds)
        syncTimer()
        if let failure {
            if case APIError.noBaseURL = failure {
                // Expected when hub isn't configured yet
            } else {
                errorMessage = failure.localizedDescription
            }
        }
    }

    // MARK: - Note Decryption

    /// Decrypt one note for the dashboard preview.
    ///
    /// Internal (not private) so unit tests can drive it directly — constructing the
    /// view model needs no network. Envelope selection is by trial, never by comparing
    /// `authorPubkey` — see `NoteResponse.decryptionCandidates` (#1024).
    ///
    /// Nonisolated: a pure function of its argument and the immutable `cryptoService`.
    /// It reads and writes no observed state; `fetchRecentNotes()` assigns its result on
    /// the main actor.
    nonisolated func decryptRecentNote(_ encrypted: NoteResponse) -> RecentNotePreview? {
        guard let ourPubkey = cryptoService.encryptionPubkeyHex else { return nil }

        for envelope in encrypted.decryptionCandidates(encryptionPubkey: ourPubkey) {
            guard let json = try? cryptoService.decryptNote(
                ciphertextHex: encrypted.encryptedContent,
                envelope: envelope
            ) else { continue }

            // #1633: plain decoder — the note payload is camelCase on every platform, and a
            // `.convertFromSnakeCase` here would hide an encoder regression.
            guard let payload = try? JSONDecoder().decode(NotePayload.self, from: Data(json.utf8)) else {
                return nil
            }

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
        }
        return nil
    }

    private func fetchRecentNotes() async {
        do {
            let response: NotesListResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/notes") + "?page=1&limit=3"
            )

            recentNoteCount = response.total

            // Decrypt the recent notes for preview using HPKE envelopes
            recentNotes = response.notes.prefix(3).compactMap(decryptRecentNote)
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
