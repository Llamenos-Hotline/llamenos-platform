import Foundation

// MARK: - CallReference

/// A call a note can be filed against: the call's id and the hub it belongs to.
///
/// A note is posted to the hub the call lives in (the server refuses a call id that is not
/// that hub's, #2125), which need not be the active hub — so the hub travels with the id.
/// Held in memory only; nothing here is persisted.
struct CallReference: Identifiable, Hashable, Sendable {
    enum Phase: Hashable, Sendable {
        case ringing
        case inProgress
        /// The volunteer's own call, just ended.
        case ended
        case recorded(CallStatus)
    }

    let id: String
    let hubId: String
    let startedAt: Date
    let phase: Phase

    /// What the call is called in a list — the call's state, never the caller's number.
    var title: String {
        switch phase {
        case .ringing: return NSLocalizedString("calls_incoming", comment: "Incoming Call")
        case .inProgress: return NSLocalizedString("calls_active", comment: "Active Call")
        case .ended: return NSLocalizedString("calls_ended", comment: "Call Ended")
        case .recorded(let status): return status.displayName
        }
    }
}

extension CallStatus {
    /// The history list's reading of a call's wire status.
    init(wire status: SharedActiveCallResponseStatus?) {
        switch status {
        case .some(.completed), .some(.inProgress): self = .answered
        default: self = .missed
        }
    }
}

extension CallReference {
    init(_ call: SharedCall, hubId: String) {
        let phase: Phase
        switch call.status {
        case .some(.ringing): phase = .ringing
        case .some(.inProgress): phase = .inProgress
        default: phase = .recorded(CallStatus(wire: call.status))
        }
        self.init(
            id: call.id,
            hubId: hubId,
            startedAt: DateFormatting.parseISO(call.startedAt) ?? Date(),
            phase: phase
        )
    }
}

// MARK: - NoteCallChoicesViewModel

/// The calls the signed-in user may file a note against, for the note editor's picker.
///
/// The server accepts a note on any call of the hub, so the client decides what to offer:
/// the calls it already holds (a call in progress, one that just ended), plus — by
/// permission — the hub's call history and active calls. A user without
/// `calls:read-history` is offered only calls they answered themselves, never someone
/// else's. Gated on `hasPermission`, never on a role (#2247).
@MainActor
@Observable
final class NoteCallChoicesViewModel {
    private let apiService: APIService
    private let hubId: String?
    private let myPubkey: String?
    private let canReadActive: Bool
    private let canReadHistory: Bool

    /// Calls to offer, newest context first: the ones already held, then the hub's.
    private(set) var choices: [CallReference]
    private(set) var isLoading: Bool = false

    /// Why the hub's calls could not be listed (localized), nil when they could.
    private(set) var errorMessage: String?

    /// - Parameters:
    ///   - hubId: The hub whose calls are listed; nil lists only `known`.
    ///   - known: Calls the app already holds (offered first, whatever the permissions).
    init(
        apiService: APIService,
        hubId: String?,
        myPubkey: String?,
        canReadActive: Bool,
        canReadHistory: Bool,
        known: [CallReference]
    ) {
        self.apiService = apiService
        self.hubId = hubId
        self.myPubkey = myPubkey
        self.canReadActive = canReadActive
        self.canReadHistory = canReadHistory
        self.choices = known
    }

    func load() async {
        guard let hubId, !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        async let active = fetchActive(hubId)
        async let history = fetchHistory(hubId)
        let results = [await active, await history]
        let fetched = results.compactMap { try? $0.get() }.flatMap { $0 }
            .sorted { $0.startedAt > $1.startedAt }
        if let failure = results.compactMap({ result -> Error? in
            if case .failure(let error) = result { return error } else { return nil }
        }).first {
            errorMessage = failure.localizedDescription
        }

        var seen = Set(choices.map(\.id))
        choices += fetched.filter { seen.insert($0.id).inserted }
    }

    private func fetchActive(_ hubId: String) async -> Result<[CallReference], Error> {
        guard canReadActive else { return .success([]) }
        do {
            let response: ProtocolActiveCallsResponse = try await apiService.request(
                method: "GET",
                path: APIService.hubPath(hubId, "/api/calls/active")
            )
            return .success(
                response.calls
                    .filter { canReadHistory || (myPubkey != nil && $0.answeredBy == myPubkey) }
                    .map { CallReference($0, hubId: hubId) }
            )
        } catch {
            return .failure(error)
        }
    }

    private func fetchHistory(_ hubId: String) async -> Result<[CallReference], Error> {
        guard canReadHistory else { return .success([]) }
        do {
            let response: ProtocolCallHistoryResponse = try await apiService.request(
                method: "GET",
                path: APIService.hubPath(hubId, "/api/calls/history?limit=50")
            )
            return .success(response.calls.map { CallReference($0, hubId: hubId) })
        } catch {
            return .failure(error)
        }
    }
}
