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
        case verified(head: Head, staleSigners: Int)
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

    /// Advance the anchor for `hubId` — never backwards — under the lock, so two
    /// verifications racing cannot lower it.
    func setAnchor(hubId: String, head: Head) throws {
        lock.lock(); defer { lock.unlock() }
        var all = try anchors()
        if let known = all[hubId], known.seq > head.seq { return }
        all[hubId] = head
        try keychainService.store(key: KeychainKey.hubChainAnchors, data: try JSONEncoder().encode(all))
    }

    // MARK: - Load

    /// Every link of the hub's chain, as the server's raw JSON objects.
    private func fetchLinks(hubId: String) async throws -> [Any] {
        var links: [Any] = []
        var from = 1
        while true {
            let (status, body) = try await apiService.rawRequest(
                method: "GET", path: APIService.hubPath(hubId, "/api/chain?from=\(from)"), body: nil
            )
            guard status == 200,
                  let page = try JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any],
                  let pageLinks = page["links"] as? [[String: Any]] else {
                throw APIError.requestFailed(statusCode: status, body: body)
            }
            links.append(contentsOf: pageLinks)
            let hasMore = page["hasMore"] as? Bool ?? false
            guard hasMore, let last = pageLinks.last, let seq = last["seq"] as? Int else { return links }
            from = seq + 1
        }
    }

    /// Each signer's (and recovery holder's) user chain, in the crate's shape.
    private func userChains(for links: [Any]) async throws -> [[[String: Any]]] {
        var users = Set<String>()
        for case let link as [String: Any] in links {
            if let signer = link["signerUser"] as? String { users.insert(signer) }
            if let body = link["body"] as? [String: Any], body["type"] as? String == "recovery_group",
               let holders = body["holders"] as? [String] {
                users.formUnion(holders)
            }
        }
        var chains: [[[String: Any]]] = []
        for user in users.sorted() {
            let response: SigchainResponse = try await apiService.request(method: "GET", path: "/api/users/\(user)/sigchain")
            if !response.links.isEmpty { chains.append(try DeviceIdentityService.cryptoLinkObjects(response.links)) }
        }
        return chains
    }

    /// Fetch and verify `hubId`'s chain against this device's anchor; advance the
    /// anchor. A refused chain is an answer, recorded so sealing stops — never thrown.
    @discardableResult
    func load(hubId: String) async throws -> Status {
        let links = try await fetchLinks(hubId: hubId)
        let anchor = try anchor(hubId: hubId)
        if links.isEmpty {
            return record(hubId, anchor.map { .fork("the server serves no chain, but this device verified seq \($0.seq)") } ?? .none)
        }
        var request: [String: Any] = ["op": "verify", "links": links, "userChains": try await userChains(for: links)]
        if let anchor { request["anchor"] = ["seq": anchor.seq, "hash": anchor.hash] }
        let requestJson = String(decoding: try JSONSerialization.data(withJSONObject: request), as: UTF8.self)
        do {
            let answer = try cryptoService.hubChainCall(requestJson: requestJson)
            guard let verified = try JSONSerialization.jsonObject(with: Data(answer.utf8)) as? [String: Any],
                  let hub = verified["hub"] as? String,
                  let head = verified["head"] as? [String: Any],
                  let seq = head["seq"] as? Int, let hash = head["hash"] as? String else {
                return record(hubId, .refused(code: "invalid_input", detail: "unreadable crate answer"))
            }
            // A valid chain of ANOTHER hub, served for this one, is refused.
            guard hub == hubId else {
                return record(hubId, .refused(code: "chain_hub_mismatch", detail: "the served chain is hub \(hub)'s"))
            }
            let verifiedHead = Head(seq: seq, hash: hash)
            try setAnchor(hubId: hubId, head: verifiedHead)
            let alerts = (verified["alerts"] as? [Any])?.count ?? 0
            return record(hubId, .verified(head: verifiedHead, staleSigners: alerts))
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
        if status == nil || status == Status.none {
            status = try await load(hubId: hubId)
        }
        guard case .verified = status else { throw ChainError.sealingStopped(hubId: hubId) }
    }

    // MARK: - Founding (new-hub genesis, §5.6)

    private struct FoundingBundle: Decodable { let bundle: String; let permissions: [String] }
    private struct FoundingResponse: Decodable { let bundles: [FoundingBundle] }

    /// This device's user-chain head, verified in Rust, with this device active in it.
    private func ownHead(user: String) async throws -> Head {
        let response: SigchainResponse = try await apiService.request(method: "GET", path: "/api/users/\(user)/sigchain")
        let request: [String: Any] = ["op": "verifySigchain", "links": try DeviceIdentityService.cryptoLinkObjects(response.links)]
        let answer = try cryptoService.hubChainCall(
            requestJson: String(decoding: try JSONSerialization.data(withJSONObject: request), as: UTF8.self)
        )
        guard let state = try JSONSerialization.jsonObject(with: Data(answer.utf8)) as? [String: Any],
              let active = state["activeDevicePubkeys"] as? [String], let device = cryptoService.signingPubkeyHex,
              active.contains(device), let seq = state["headSeq"] as? Int, let hash = state["headHash"] as? String else {
            throw CryptoServiceError.noKeyLoaded
        }
        return Head(seq: seq, hash: hash)
    }

    private func sign(_ unsigned: [String: Any]) throws -> [String: Any] {
        let json = String(decoding: try JSONSerialization.data(withJSONObject: unsigned), as: UTF8.self)
        let signed = try cryptoService.signHubLink(unsignedJson: json)
        guard let link = try JSONSerialization.jsonObject(with: Data(signed.utf8)) as? [String: Any] else {
            throw CryptoServiceError.noKeyLoaded
        }
        return link
    }

    /// Found a hub: this device signs its genesis (the founder alone, holding the
    /// founder bundles the server's catalog names), the server stores it as the
    /// chain's first link, then each bundle's permissions are committed in a
    /// `policy {kind: bundle}` link. Returns the created hub's response body.
    func foundHub(fields: [String: Any]) async throws -> String {
        guard let founder = cryptoService.signingPubkeyHex else { throw CryptoServiceError.noKeyLoaded }
        let founding: FoundingResponse = try await apiService.request(method: "GET", path: "/api/hubs/founding")
        let head = try await ownHead(user: founder)
        let hubId = UUID().uuidString.lowercased()
        let headObject: [String: Any] = ["seq": head.seq, "hash": head.hash]
        let genesis = try sign([
            "hub": hubId, "seq": 1, "prevHash": NSNull(), "signerUser": founder, "signerUserHead": headObject,
            "body": [
                "type": "genesis", "founder": founder, "migration": 0,
                "members": [["user": founder, "bundles": founding.bundles.map(\.bundle).sorted()]],
            ],
        ])
        var body = fields
        body["id"] = hubId
        body["genesis"] = genesis
        let (status, created) = try await apiService.rawRequest(
            method: "POST", path: "/api/hubs",
            body: String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self)
        )
        guard status == 201 || status == 200 else { throw APIError.requestFailed(statusCode: status, body: created) }
        try setAnchor(hubId: hubId, head: Head(seq: 1, hash: genesis["entryHash"] as? String ?? ""))

        var prev = genesis
        for bundle in founding.bundles {
            let hashAnswer = try cryptoService.hubChainCall(requestJson: String(
                decoding: try JSONSerialization.data(withJSONObject: ["op": "permsHash", "permissions": bundle.permissions]),
                as: UTF8.self
            ))
            let permsHash = (try JSONSerialization.jsonObject(with: Data(hashAnswer.utf8)) as? [String: Any])?["permsHash"] as? String ?? ""
            let link = try sign([
                "hub": hubId, "seq": (prev["seq"] as? Int ?? 0) + 1, "prevHash": prev["entryHash"] ?? NSNull(),
                "signerUser": founder, "signerUserHead": headObject,
                "body": ["type": "policy", "kind": "bundle", "bundle": bundle.bundle, "permissions": bundle.permissions, "permsHash": permsHash],
            ])
            let (appendStatus, appended) = try await apiService.rawRequest(
                method: "POST", path: APIService.hubPath(hubId, "/api/chain"),
                body: String(decoding: try JSONSerialization.data(withJSONObject: ["link": link]), as: UTF8.self)
            )
            guard appendStatus == 201 else { throw APIError.requestFailed(statusCode: appendStatus, body: appended) }
            try setAnchor(hubId: hubId, head: Head(seq: link["seq"] as? Int ?? 0, hash: link["entryHash"] as? String ?? ""))
            prev = link
        }
        return created
    }
}
