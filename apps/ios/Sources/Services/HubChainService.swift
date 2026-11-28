import Foundation

/// The hub authority chain on iOS (#2963; wire spec §5, #2974 items 3–5).
///
/// - **Load:** fetch the hub's chain and verify it in Rust (`hub_chain::call`
///   `verify`, through ``CryptoService/hubChainCall(requestJson:)``), with the
///   user chains of its signers, against the trusted anchor this device holds for
///   the hub. Links travel as the server's raw JSON straight into the crate — no
///   Swift type decodes them, so no signed field can be dropped or re-encoded.
/// - **Anchor:** `{hub, seq, hash}` comes from this device only (its own genesis,
///   its own previous verification) — never from the server. A chain that does
///   not contain it is a fork.
/// - **Alerts:** fork, refused (an unauthorised or otherwise invalid link) and the
///   advisory stale-signer finding (D13). **Only a verified chain seals**
///   (``assertSealable(hubId:)``): a fork, a refused chain, a missing chain or a
///   failed fetch all stop sealing in that hub.
///
/// Nothing here canonicalises, hashes or checks a link — every such step is the
/// crate's. This only fetches, calls the crate and remembers verdicts.
final class HubChainService: @unchecked Sendable {

    enum Status: Equatable {
        case verified(head: Head, staleSigners: Int, at: Date = Date())
        /// The server serves no chain for the hub.
        case none
        case fork(String)
        case refused(code: String, detail: String)
    }

    struct Head: Codable, Equatable { let seq: Int; let hash: String }

    enum ChainError: LocalizedError, Equatable {
        case sealingStopped(hubId: String)
        var errorDescription: String? {
            switch self {
            case .sealingStopped:
                return NSLocalizedString("hub_chain_alert_sealing_stopped", comment: "Sealing stopped in a hub whose chain is not verified")
            }
        }
    }

    static let statusDidChange = Notification.Name("HubChainService.statusDidChange")
    static let verifiedLifetime: TimeInterval = 5 * 60

    private let apiService: APIService
    private let cryptoService: CryptoService
    private let keychainService: KeychainService
    private let lock = NSLock()
    private var statuses: [String: Status] = [:]

    init(apiService: APIService, cryptoService: CryptoService, keychainService: KeychainService) {
        self.apiService = apiService
        self.cryptoService = cryptoService
        self.keychainService = keychainService
    }

    func status(hubId: String) -> Status? {
        lock.lock(); defer { lock.unlock() }
        return statuses[hubId]
    }

    private func record(_ hubId: String, _ status: Status) -> Status {
        lock.lock()
        statuses[hubId] = status
        lock.unlock()
        NotificationCenter.default.post(name: Self.statusDidChange, object: hubId)
        return status
    }

    /// The crate's closed rejection code of an error (`chain_fork`, …).
    static func rejectionCode(_ error: Error) -> String {
        let message = String(describing: error)
        for marker in ["hub chain rejected (", "sigchain rejected ("] {
            if let open = message.range(of: marker),
               let close = message[open.upperBound...].firstIndex(of: ")") {
                return String(message[open.upperBound..<close])
            }
        }
        return "invalid_input"
    }

    // MARK: - Anchors (Keychain)

    /// Every anchor this device holds. Fails closed: a Keychain read error or an
    /// unreadable value throws — it is never "no anchors", which would let a
    /// server's empty or substituted chain be taken on first use again.
    private func anchors() throws -> [String: Head] {
        guard let data = try keychainService.retrieve(key: KeychainKey.hubChainAnchors) else { return [:] }
        return try JSONDecoder().decode([String: Head].self, from: data)
    }

    func anchor(hubId: String) throws -> Head? {
        lock.lock(); defer { lock.unlock() }
        return try anchors()[hubId]
    }

    /// A head that would move the anchor backwards or sideways (wire spec §5.7).
    struct AnchorFork: Error, CustomStringConvertible {
        let description: String
    }

    /// Advance the anchor for `hubId` under the wire spec §5.7 rule: strictly
    /// forward. A lower seq is refused, and an equal seq with a different hash is
    /// a fork — both throw ``AnchorFork``. The caller holds the hub's queue, so
    /// the read-verify-write it belongs to never interleaves with another.
    func advanceAnchor(hubId: String, head: Head) throws {
        lock.lock(); defer { lock.unlock() }
        var all = try anchors()
        if let known = all[hubId] {
            if head.seq < known.seq {
                throw AnchorFork(description: "the verified head seq \(head.seq) is below the anchor at seq \(known.seq)")
            }
            if head.seq == known.seq {
                if head.hash != known.hash { throw AnchorFork(description: "a different link at the anchored seq \(known.seq)") }
                return
            }
        }
        all[hubId] = head
        try keychainService.store(key: KeychainKey.hubChainAnchors, data: try JSONEncoder().encode(all))
    }

    // MARK: - One entry point per hub (wire spec §5.7)

    private var queues: [String: Task<Void, Never>] = [:]
    private var inFlight: [String: Task<Status, Error>] = [:]

    /// Run `step` after everything already queued for `hubId`: a verification
    /// and every append that moves the anchor are one critical section per hub.
    private func serialised<T: Sendable>(_ hubId: String, _ step: @escaping @Sendable () async throws -> T) async throws -> T {
        let task: Task<T, Error> = lock.withLock {
            let prior = queues[hubId]
            let task = Task<T, Error> {
                await prior?.value
                return try await step()
            }
            queues[hubId] = Task { _ = try? await task.value }
            return task
        }
        return try await task.value
    }

    // MARK: - Load

    /// Every link of the hub's chain, as the server's raw JSON objects. Pages
    /// are contiguous from seq 1, so the next page starts after the count so far.
    private func fetchLinks(hubId: String) async throws -> [Any] {
        var links: [Any] = []
        while true {
            let (status, body) = try await apiService.rawRequest(
                method: "GET", path: APIService.hubPath(hubId, "/api/chain?from=\(links.count + 1)"), body: nil
            )
            guard status == 200,
                  let page = try JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any],
                  let pageLinks = page["links"] as? [Any] else {
                throw APIError.requestFailed(statusCode: status, body: body)
            }
            links.append(contentsOf: pageLinks)
            guard page["hasMore"] as? Bool == true, !pageLinks.isEmpty else { return links }
        }
    }

    /// One crate call, JSON in and JSON out.
    private func crate(_ request: [String: Any]) throws -> Data {
        let json = String(decoding: try JSONSerialization.data(withJSONObject: request), as: UTF8.self)
        return Data(try cryptoService.hubChainCall(requestJson: json).utf8)
    }

    private struct UsersNamed: Decodable { let users: [String] }

    /// The user chain of every user the crate says a verifier of `links` needs,
    /// as the server serves them — the crate reads that shape itself.
    private func userChains(for links: [Any]) async throws -> [Any] {
        let named = try JSONDecoder().decode(UsersNamed.self, from: try crate(["op": "usersNamed", "links": links]))
        var chains: [Any] = []
        for user in named.users {
            let (status, body) = try await apiService.rawRequest(method: "GET", path: "/api/users/\(user)/sigchain", body: nil)
            guard status == 200,
                  let response = try JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any],
                  let served = response["links"] as? [Any] else {
                throw APIError.requestFailed(statusCode: status, body: body)
            }
            if !served.isEmpty { chains.append(served) }
        }
        return chains
    }

    private var verifiedStates: [String: HubChainVerified] = [:]

    /// The crate's verified answer for `hubId`'s chain, from this device's last
    /// successful verification — `nil` when the hub has none.
    func verified(hubId: String) -> HubChainVerified? {
        lock.lock(); defer { lock.unlock() }
        return verifiedStates[hubId]
    }

    /// Fetch and verify `hubId`'s chain against this device's anchor; advance the
    /// anchor. The one entry point (wire spec §5.7): every caller — the banner,
    /// the sealing gate, a hub switch — shares a verification already in flight
    /// for the hub. A refused chain is an answer, recorded so sealing stops.
    @discardableResult
    func load(hubId: String) async throws -> Status {
        let task: Task<Status, Error> = lock.withLock {
            if let pending = inFlight[hubId] { return pending }
            let task = Task<Status, Error> {
                defer { self.lock.withLock { self.inFlight[hubId] = nil } }
                return try await self.serialised(hubId) { try await self.loadNow(hubId: hubId) }
            }
            inFlight[hubId] = task
            return task
        }
        return try await task.value
    }

    private func loadNow(hubId: String) async throws -> Status {
        let links = try await fetchLinks(hubId: hubId)
        let anchor = try anchor(hubId: hubId)
        if links.isEmpty {
            return record(hubId, anchor.map { .fork("the server serves no chain, but this device verified seq \($0.seq)") } ?? .none)
        }
        var request: [String: Any] = ["op": "verify", "links": links, "userChains": try await userChains(for: links)]
        if let anchor { request["anchor"] = ["seq": anchor.seq, "hash": anchor.hash] }
        do {
            let verified = try JSONDecoder().decode(HubChainVerified.self, from: try crate(request))
            // A valid chain of ANOTHER hub, served for this one, is refused.
            guard verified.hub == hubId else {
                return record(hubId, .refused(code: "chain_hub_mismatch", detail: "the served chain is hub \(verified.hub)'s"))
            }
            let head = Head(seq: verified.head.seq, hash: verified.head.hash)
            try advanceAnchor(hubId: hubId, head: head)
            lock.withLock { verifiedStates[hubId] = verified }
            return record(hubId, .verified(head: head, staleSigners: verified.alerts.count))
        } catch let fork as AnchorFork {
            return record(hubId, .fork(fork.description))
        } catch is DecodingError {
            return record(hubId, .refused(code: "invalid_input", detail: "unreadable crate answer"))
        } catch {
            let code = Self.rejectionCode(error)
            let detail = String(describing: error)
            return record(hubId, code == "chain_fork" ? .fork(detail) : .refused(code: code, detail: detail))
        }
    }

    /// Refuse to seal in a hub unless this device has VERIFIED its chain. With no
    /// verdict yet (or only "no chain", which a server could claim for any hub) the
    /// chain is loaded first; a fetch failure throws, because "could not check" is
    /// not "checked".
    func assertSealable(hubId: String) async throws {
        var status = self.status(hubId: hubId)
        // A verification is good for `verifiedLifetime`: after that, sealing
        // re-checks the chain (a fork served since is caught), and a failed
        // re-check refuses.
        switch status {
        case .fork?, .refused?:
            break
        case .verified(_, _, let at)? where Date().timeIntervalSince(at) < Self.verifiedLifetime:
            break
        default:
            status = try await load(hubId: hubId)
        }
        guard case .verified = status else { throw ChainError.sealingStopped(hubId: hubId) }
    }

    // MARK: - Writing (every link is built from intent in the crate, #3133)

    private struct VerifiedHead: Decodable { let activeDevicePubkeys: [String]; let headSeq: Int; let headHash: String }

    /// This device's user-chain head, verified in Rust, with this device active in it.
    private func ownHead(user: String) async throws -> Head {
        let (status, body) = try await apiService.rawRequest(method: "GET", path: "/api/users/\(user)/sigchain", body: nil)
        guard status == 200,
              let response = try JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any],
              let served = response["links"] as? [Any] else {
            throw APIError.requestFailed(statusCode: status, body: body)
        }
        let state = try JSONDecoder().decode(VerifiedHead.self, from: try crate(["op": "verifySigchain", "links": served]))
        guard let device = cryptoService.signingPubkeyHex, state.activeDevicePubkeys.contains(device) else {
            throw CryptoServiceError.noKeyLoaded
        }
        return Head(seq: state.headSeq, hash: state.headHash)
    }

    /// A link the crate signed and the head it makes. `link` is the crate's JSON
    /// object, passed on to the server as is — never read here.
    private struct Signed { let link: Any; let head: Head }

    private struct SignedHead: Decodable { let head: Head }

    private func sign(hubId: String, prev: Head?, signer: String, signerHead: Head, intent: [String: Any]) throws -> Signed {
        let request: [String: Any] = [
            "hub": hubId,
            "prev": prev.map { ["seq": $0.seq, "hash": $0.hash] as [String: Any] } ?? NSNull(),
            "signerUser": signer,
            "signerUserHead": ["seq": signerHead.seq, "hash": signerHead.hash],
            "intent": intent,
        ]
        let answer = try cryptoService.signHubIntent(
            requestJson: String(decoding: try JSONSerialization.data(withJSONObject: request), as: UTF8.self)
        )
        let data = Data(answer.utf8)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any], let link = object["link"] else {
            throw CryptoServiceError.noKeyLoaded
        }
        return Signed(link: link, head: try JSONDecoder().decode(SignedHead.self, from: data).head)
    }

    /// Append a link the crate signed. A lost head race is ``APIError/requestFailed(statusCode:body:)`` with 409.
    private func append(hubId: String, _ signed: Signed) async throws {
        let (status, body) = try await apiService.rawRequest(
            method: "POST", path: APIService.hubPath(hubId, "/api/chain"),
            body: String(decoding: try JSONSerialization.data(withJSONObject: ["link": signed.link]), as: UTF8.self)
        )
        guard status == 201 else { throw APIError.requestFailed(statusCode: status, body: body) }
    }

    /// The chain write was refused before signing: this device has not verified the hub's chain.
    struct WriteRefused: Error { let hubId: String; let status: Status }

    /// Sign and append the links `intents` names, as this user, on the head this
    /// device has just verified (§5.1): verify, let the caller decide against
    /// the verified state, sign each through the crate, append. A lost race
    /// (409) re-reads, re-verifies, re-decides and re-signs. Every role write
    /// takes this path; the server has no unsigned role write (#3133).
    @discardableResult
    func appendIntents(
        hubId: String,
        intents: @escaping @Sendable (HubChainVerified) throws -> [[String: Any]]
    ) async throws -> HubChainVerified {
        guard let signer = cryptoService.signingPubkeyHex else { throw CryptoServiceError.noKeyLoaded }
        return try await serialised(hubId) {
            for attempt in 1...Self.appendAttempts {
                let status = try await self.loadNow(hubId: hubId)
                guard case .verified = status, let verified = self.verified(hubId: hubId) else {
                    throw WriteRefused(hubId: hubId, status: status)
                }
                let wanted = try intents(verified)
                if wanted.isEmpty { return verified }
                let signerHead = try await self.ownHead(user: signer)
                var prev = Head(seq: verified.head.seq, hash: verified.head.hash)
                do {
                    for intent in wanted {
                        let signed = try self.sign(hubId: hubId, prev: prev, signer: signer, signerHead: signerHead, intent: intent)
                        try await self.append(hubId: hubId, signed)
                        try self.advanceAnchor(hubId: hubId, head: signed.head)
                        prev = signed.head
                    }
                } catch APIError.requestFailed(let code, _) where code == 409 && attempt < Self.appendAttempts {
                    continue
                }
                let after = try await self.loadNow(hubId: hubId)
                guard case .verified = after, let state = self.verified(hubId: hubId) else {
                    throw WriteRefused(hubId: hubId, status: after)
                }
                return state
            }
            throw WriteRefused(hubId: hubId, status: .none)
        }
    }

    static let appendAttempts = 3

    // MARK: - Founding (new-hub genesis, §5.6)

    /// Found a hub: this device signs its genesis (the founder alone, holding the
    /// founder bundles the server's catalog names), the server stores it as the
    /// chain's first link, then each bundle's permissions are committed in a
    /// `policy {kind: bundle}` link — every link built in the crate from its
    /// intent. Returns the created hub's response body.
    func foundHub(fields: [String: Any]) async throws -> String {
        guard let founder = cryptoService.signingPubkeyHex else { throw CryptoServiceError.noKeyLoaded }
        let founding: HubFoundingResponse = try await apiService.request(method: "GET", path: "/api/hubs/founding")
        let head = try await ownHead(user: founder)
        let hubId = UUID().uuidString.lowercased()
        let genesis = try sign(
            hubId: hubId, prev: nil, signer: founder, signerHead: head,
            intent: ["type": "genesis", "bundles": founding.bundles.map(\.bundle)]
        )
        var body = fields
        body["id"] = hubId
        body["genesis"] = genesis.link
        let (status, created) = try await apiService.rawRequest(
            method: "POST", path: "/api/hubs",
            body: String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self)
        )
        guard status == 201 || status == 200 else { throw APIError.requestFailed(statusCode: status, body: created) }
        let bundles = founding.bundles
        let genesisHead = genesis.head
        try await serialised(hubId) {
            try self.advanceAnchor(hubId: hubId, head: genesisHead)
            var prev = genesisHead
            for bundle in bundles {
                let signed = try self.sign(
                    hubId: hubId, prev: prev, signer: founder, signerHead: head,
                    intent: ["type": "bundlePolicy", "bundle": bundle.bundle, "permissions": bundle.permissions]
                )
                try await self.append(hubId: hubId, signed)
                try self.advanceAnchor(hubId: hubId, head: signed.head)
                prev = signed.head
            }
        }
        return created
    }
}
