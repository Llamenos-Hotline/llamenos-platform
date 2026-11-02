import Foundation
import os

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

    /// The call this volunteer answered and is on — the one whose `answeredBy` is this
    /// device's identity. Never "whichever call the hub lists first": a call someone else
    /// answered is not theirs to hang up, spam or ban (the server refuses with 403).
    var currentCall: ActiveCall?

    /// Calls ringing this volunteer, across every member hub (the multi-hub routing axiom).
    var ringingCalls: [ActiveCall] = []

    /// This volunteer's own call that has just ended. Holds the call id so a note can still
    /// be filed against it; in memory only, and gone when the volunteer dismisses it, saves
    /// the note, locks or logs out. Never written to disk.
    private(set) var endedCall: CallReference?

    /// Calls the relay has announced are over. A call id is never reused, and the server
    /// publishes the end only after closing the call row, so a `calls/active` answer that
    /// still lists one of these was read before the end and is stale: it must not put the
    /// call back on screen (or re-raise a "Call Ended" prompt the volunteer dismissed).
    /// In memory only, cleared with every other call on lock / logout.
    private var endedCallIds: Set<String> = []

    /// Rings the server refused to answer in the app (422: the hub has no in-app leg for
    /// this volunteer), which can only be answered on the phone.
    private(set) var answerOnPhoneCallIds: Set<String> = []

    /// Rings with an answer request in flight.
    private(set) var answeringCallIds: Set<String> = []

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

    /// Call-flow trace, for reading what the dashboard did when a UI test stalls (#2283):
    /// CI captures this subsystem from the simulator and uploads it with each shard.
    private static let log = Logger(subsystem: "org.llamenos.hotline", category: "CallFlow")

    /// DEBUG builds only (the simulator, the UI-test build). A release build traces
    /// nothing, so a seized phone's log holds no record of when its volunteer took calls.
    private static func trace(_ message: @autoclosure () -> String) {
        #if DEBUG
        let text = message()
        log.debug("\(text, privacy: .public)")
        #endif
    }

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
                self.handleTypedEvent(attributed)
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
        case .callRing, .callAnswered, .callUpdate, .callEnded, .voicemailNew, .presenceSummary, .presenceDetail:
            // A call the event says is over is shown as over NOW, from the event (#2283).
            // The fetches below reconcile shift status and the call list; they confirm or
            // correct what is on screen and are never the precondition for it. Before,
            // the Call Ended / Add Note prompt appeared only once `shifts/my-status` and
            // then `calls/active` had both answered, so a volunteer on a slow or flapping
            // connection ended a call and got no prompt to write its note.
            Self.trace("relay: \(attributed.event.rawValue) call=\(attributed.callId ?? "-") status=\(attributed.callStatus?.rawValue ?? "-") hub=\(attributed.hubId)")
            if let ended = attributed.endedCallId {
                callIsOver(ended, hubId: attributed.hubId)
            }
            reconcileCalls(hubId: attributed.hubId)
        case .shiftStarted, .shiftEnded, .shiftUpdate:
            Task { await fetchShiftStatus(hubIds: [attributed.hubId]) }
        case .noteCreated:
            // Recent notes are browsing data for the active hub only.
            guard attributed.hubId == hubContext.activeHubId else { return }
            Task { await fetchRecentNotes() }
        case .messageNew, .messageStatus, .conversationNew, .conversationAssigned, .conversationClosed, .conversationEnvelopesAdded:
            // Message events don't affect dashboard — handled by ConversationsViewModel
            break
        case .deviceWipe, .hubIncident, .unknown:
            break
        }
    }

    /// Re-read where the volunteer stands on `hubId` and the calls on every member hub.
    /// The two reads are independent, so neither waits for the other.
    private func reconcileCalls(hubId: String) {
        Task {
            async let status: Void = fetchShiftStatus(hubIds: [hubId])
            async let calls: Void = fetchActiveCall()
            _ = await (status, calls)
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

    /// Answer a ringing call in the app (on the call's own hub, not the active hub).
    ///
    /// 422 means the hub has no in-app leg for this volunteer: the call is still ringing and
    /// can only be answered on the phone, so the card says so instead of offering Answer.
    func answerCall(_ call: ActiveCall) async {
        guard !answeringCallIds.contains(call.id) else { return }
        answeringCallIds.insert(call.id)
        defer { answeringCallIds.remove(call.id) }
        do {
            try await apiService.request(method: "POST", path: APIService.hubPath(call.hubId, "/api/calls/\(call.id)/answer"))
            await fetchActiveCall()
        } catch APIError.requestFailed(statusCode: 422, _) {
            answerOnPhoneCallIds.insert(call.id)
        } catch {
            // 409: someone else picked up first. Anything else: the call is still ringing.
            errorMessage = NSLocalizedString("calls_answer_failed", comment: "Couldn't answer the call.")
            await fetchActiveCall()
        }
    }

    /// Hang up the current active call (on the call's own hub, not the active hub).
    func hangupCall() async {
        guard let call = currentCall else { return }
        do {
            try await apiService.request(method: "POST", path: APIService.hubPath(call.hubId, "/api/calls/\(call.id)/hangup"))
            finish(call)
        } catch {
            // The call is still on screen and still ringing the caller: say the hang-up
            // did not happen, rather than the bare refusal reason.
            errorMessage = NSLocalizedString("calls_hangup_failed", comment: "Couldn't end the call. Try again.")
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
            finish(call)
        } catch {
            errorMessage = NSLocalizedString("call_actions_ban_failed", comment: "Failed to ban caller")
        }
    }

    // MARK: - Ended Call

    /// Calls the note editor can offer straight away: the one in progress and the one that
    /// just ended.
    var heldCalls: [CallReference] {
        [currentCall?.reference, endedCall].compactMap { $0 }
    }

    /// The volunteer dismissed the "Call Ended" prompt.
    func dismissEndedCall() {
        endedCall = nil
    }

    /// A note was filed against `call`: the prompt has done its job.
    func noteSaved(for call: CallReference) {
        if endedCall?.id == call.id { endedCall = nil }
    }

    /// Forget every call held in memory — the app locked or the user logged out.
    func clearCalls() {
        currentCall = nil
        ringingCalls = []
        endedCall = nil
        endedCallIds = []
        answerOnPhoneCallIds = []
        answeringCallIds = []
    }

    /// This volunteer's `call` is over: swap the call card for the "Call Ended" prompt.
    private func finish(_ call: ActiveCall) {
        endedCallIds.insert(call.id)
        if currentCall?.id == call.id { currentCall = nil }
        endedCall = call.reference(phase: .ended)
    }

    /// The relay said call `callId` on `hubId` is over. If it was this volunteer's call it
    /// becomes the "Call Ended" prompt; if it was ringing them it stops ringing. Needs no
    /// network: everything it uses is already held.
    private func callIsOver(_ callId: String, hubId: String) {
        endedCallIds.insert(callId)
        ringingCalls.removeAll { $0.id == callId && $0.hubId == hubId }
        if let mine = currentCall, mine.id == callId, mine.hubId == hubId {
            Self.trace("call \(callId): Call Ended prompt raised from the relay event")
            finish(mine)
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

    /// Fetch the calls that concern this volunteer across every member hub: the ones ringing
    /// them, and the one they answered. A call somebody else answered is counted, not shown.
    private func fetchActiveCall() async {
        let hubIds = callHubIds
        guard !hubIds.isEmpty else {
            currentCall = nil
            ringingCalls = []
            activeCallCount = 0
            return
        }
        Self.trace("calls/active: requesting \(hubIds.count) hub(s)")
        let started = ContinuousClock.now
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
        Self.trace("calls/active: \(callsByHub.count)/\(hubIds.count) hub(s) answered after \(ContinuousClock.now - started)")

        // A call the relay already said is over stays over: this answer was read before.
        let ended = endedCallIds
        let me = cryptoService.signingPubkeyHex
        let live = hubIds.flatMap { hubId in
            (callsByHub[hubId]?.calls ?? [])
                .filter { !ended.contains($0.id) }
                .map { (hubId: hubId, call: $0) }
        }
        activeCallCount = live.count

        // A hub that did not answer keeps what it showed: its calls may well still be there.
        let ringing = live
            .filter { $0.call.status == .some(.ringing) && $0.call.answeredBy == nil }
            .map { ActiveCall($0.call, hubId: $0.hubId) }
        ringingCalls = ringingCalls.filter { callsByHub[$0.hubId] == nil } + ringing

        // The active hub's call wins when this volunteer is on several.
        let mine = live
            .filter { me != nil && $0.call.answeredBy == me && $0.call.status == .some(.inProgress) }
            .map { ActiveCall($0.call, hubId: $0.hubId) }
        let previous = currentCall
        if let first = mine.first {
            currentCall = first
        } else if let previous, callsByHub[previous.hubId] != nil {
            currentCall = nil
        }
        // Gone from a hub that answered: the call ended (hung up by the caller, the other
        // side, or the server).
        if let previous, callsByHub[previous.hubId] != nil, !mine.contains(where: { $0.id == previous.id }) {
            finish(previous)
        }
    }

    /// Ask the server where this volunteer stands on `hubIds` (every member hub by default).
    private func fetchShiftStatus(hubIds: [String]? = nil) async {
        Self.trace("shifts/my-status: requesting")
        let started = ContinuousClock.now
        let failure = await shiftClockService.refresh(hubIds: hubIds ?? callHubIds)
        Self.trace("shifts/my-status: answered after \(ContinuousClock.now - started)")
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
                path: apiService.activeHubPath("/api/notes") + "?page=1&limit=3"
            )

            recentNoteCount = response.total

            // Decrypt the recent notes for preview using HPKE envelopes
            recentNotes = response.notes.prefix(3).compactMap(decryptRecentNote)
        } catch {
            // Expected with no hub to browse (`APIError.isNoHub`); otherwise
            // don't overwrite the shift error either
        }
    }


    deinit {
        eventTask?.cancel()
        timerTask?.cancel()
    }
}
