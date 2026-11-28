import Foundation
import os

// MARK: - DeviceIdentityService

/// Brings this device's identity in the user's sigchain up to date (#2496; spec
/// 2026-11-25-v2-device-linking-and-recovery §5 as revised 2026-11-26).
///
/// On every unlock and after enrolment: the user's genesis, first PUK and
/// `puk_epoch` until the chain holds a `puk_epoch` (PROTOCOL.md §2.11), resuming
/// one an earlier attempt left part-way — the genesis, built in Rust, naming this device's X-Wing
/// key with its possession signature — then verification that the chain
/// authorises this device under the X-Wing key it holds. The key is fixed for the
/// device's life: a chain naming another key for it is reported, never re-keyed
/// (re-keying is remove-and-relink, L6). A failure is logged loudly and retried
/// on the next unlock, never skipped.
///
/// The head this device last verified is kept in the Keychain. A chain the server
/// later serves that does not extend it (empty, shorter, or forked) is refused:
/// re-initialising it would sign a second genesis.
///
/// Multi-hub axiom: the user sigchain is per user, not per hub; nothing here reads
/// the active hub.
@MainActor
final class DeviceIdentityService {
    private let apiService: APIService
    private let cryptoService: CryptoService
    private let keychainService: KeychainService
    private let logger = Logger(subsystem: "org.llamenos.hotline", category: "DeviceIdentity")

    /// The X-Wing key the verified chain was last seen to name for this device, this process.
    private var verifiedKemKey: String?
    private var inFlight: Task<Void, Error>?

    init(apiService: APIService, cryptoService: CryptoService, keychainService: KeychainService) {
        self.apiService = apiService
        self.cryptoService = cryptoService
        self.keychainService = keychainService
    }

    enum IdentityError: Error, LocalizedError {
        case locked
        case notAuthorised
        case kemMismatch
        case chainRolledBack
        case unreadableHead
        case createdByAnotherDevice

        var errorDescription: String? {
            switch self {
            case .locked: return "Device keys are locked or have no X-Wing key"
            case .notAuthorised: return "Verified sigchain does not authorise this device"
            case .kemMismatch: return "The verified sigchain names a different X-Wing key for this device than the one it holds"
            case .chainRolledBack: return "The server's sigchain does not extend the head this device verified"
            case .unreadableHead: return "The sigchain head this device recorded cannot be read"
            case .createdByAnotherDevice: return "This user's sigchain was created by another device"
            }
        }
    }

    /// Fire-and-forget form for the unlock and enrolment paths.
    func ensureIdentityInBackground() {
        Task {
            do {
                try await ensureIdentity()
            } catch {
                logger.error("Device identity verification failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    /// Bring this device's sigchain identity up to date. Idempotent.
    func ensureIdentity() async throws {
        if let inFlight { return try await inFlight.value }
        let task = Task { try await self.run() }
        inFlight = task
        defer { inFlight = nil }
        try await task.value
    }

    private func run() async throws {
        guard let user = cryptoService.signingPubkeyHex, let kem = cryptoService.kemPubkeyHex else {
            throw IdentityError.locked
        }
        if verifiedKemKey == kem { return }

        var links = try await sigchain(of: user)
        if let known = try verifiedHead(of: user) {
            guard known.seq >= 1, known.seq <= links.count, links[known.seq - 1].hash == known.hash else {
                throw IdentityError.chainRolledBack
            }
        }
        // Initialised means a puk_epoch: an empty chain, or a genesis-only one an
        // earlier attempt left when the envelope POST or the epoch append failed,
        // is finished here rather than verified as if it were done.
        if !links.contains(where: { $0.linkType == SigchainLinkType.pukEpoch.rawValue }) {
            links = try await initialiseIdentity(user: user, kem: kem, from: links)
        }
        let verified = try verifyAuthorises(user: user, links)
        try recordHead(user: user, verified)
        try assertNamesHeldKemKey(verified, user: user, kem: kem)
        verifiedKemKey = kem
    }

    /// `links` verified in Rust as `user`'s chain, with this device among its active devices.
    private func verifyAuthorises(user: String, _ links: [SigchainResponseLink]) throws -> SigchainVerifiedState {
        let verified = try cryptoService.verifySigchain(linksJson: try cryptoLinksJson(links))
        guard verified.userPubkey == user, verified.activeDevicePubkeys.contains(user) else {
            throw IdentityError.notAuthorised
        }
        return verified
    }

    private func assertNamesHeldKemKey(_ verified: SigchainVerifiedState, user: String, kem: String) throws {
        guard verified.activeDeviceKeys.contains(where: { $0.devicePubkey == user && $0.encryptionPubkey == kem }) else {
            throw IdentityError.kemMismatch
        }
    }

    // MARK: - Genesis + PUK (PROTOCOL.md §2.11)

    /// Genesis + PUK generation 1 + `puk_epoch`, resumed from `links`: genesis only
    /// when the chain is empty. The PUK is claimed by a link signed over the served
    /// head, so that prefix is verified first — it must be this device's own
    /// genesis, authorising it under the X-Wing key it holds — or nothing is
    /// created and nothing signed.
    private func initialiseIdentity(
        user: String, kem: String, from links: [SigchainResponseLink]
    ) async throws -> [SigchainResponseLink] {
        guard let deviceId = cryptoService.deviceId else { throw IdentityError.locked }
        var chain = links
        if chain.isEmpty {
            // Built in Rust: the device's keys, its X-Wing key and the pop over it.
            let genesis = try cryptoService.userInitPayload()
            try await appendSigned(user: user, type: .genesis, payloadJson: genesis, head: nil)
            chain = try await sigchain(of: user)
        }
        guard let genesis = chain.first?.payload.value as? [String: Any],
              genesis["deviceId"] as? String == deviceId else {
            throw IdentityError.createdByAnotherDevice
        }
        try assertNamesHeldKemKey(try verifyAuthorises(user: user, chain), user: user, kem: kem)

        // The envelope is stored BEFORE the chain claims the PUK, so a chain never
        // names a PUK whose seed was lost.
        struct PukCreated: Decodable {
            struct State: Decodable { let generation: Int; let signPubkeyHex: String; let dhPubkeyHex: String }
            let pukState: State
            let envelope: HpkeEnvelope
        }
        let puk = try JSONDecoder().decode(PukCreated.self, from: Data(try cryptoService.createInitialPuk().utf8))
        let body = DistributePukEnvelopesBody(envelopes: [
            DistributePukEnvelopesBodyEnvelope(
                deviceID: deviceId,
                envelope: SharedAuthorEnvelope(ct: puk.envelope.ct, enc: puk.envelope.enc),
                generation: puk.pukState.generation
            ),
        ])
        let _: DistributePukEnvelopesResponse = try await apiService.request(
            method: "POST", path: "/api/puk/envelopes", wireBody: body
        )
        let epoch = try json([
            "type": "puk_epoch",
            "generation": puk.pukState.generation,
            "signPubkey": puk.pukState.signPubkeyHex,
            "dhPubkey": puk.pukState.dhPubkeyHex,
        ])
        try await appendSigned(user: user, type: .pukEpoch, payloadJson: epoch, head: chain.last)
        return try await sigchain(of: user)
    }

    // MARK: - Links

    private func sigchain(of user: String) async throws -> [SigchainResponseLink] {
        let response: SigchainResponse = try await apiService.request(method: "GET", path: "/api/users/\(user)/sigchain")
        return response.links
    }

    /// Sign `payloadJson` in Rust as the link after `head` and append it.
    private func appendSigned(
        user: String,
        type: SigchainLinkType,
        payloadJson: String,
        head: SigchainResponseLink?
    ) async throws {
        let seq = (head?.seqNo ?? 0) + 1
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let link = try cryptoService.createSigchainLink(
            id: UUID().uuidString.lowercased(),
            seq: UInt64(seq),
            prevHash: head?.hash,
            timestamp: timestamp,
            payloadJson: payloadJson
        )
        let body = AppendSigchainLinkBody(
            hash: link.entryHash,
            linkType: type,
            payload: try JSONDecoder().decode([String: JSONAny].self, from: Data(payloadJson.utf8)),
            prevHash: head?.hash,
            seqNo: seq,
            signature: link.signature,
            signerDeviceID: link.signerDeviceId,
            signerPubkey: link.signerPubkey,
            timestamp: timestamp
        )
        let _: SigchainLinkRecord = try await apiService.request(
            method: "POST", path: "/api/users/\(user)/sigchain", wireBody: body
        )
    }

    /// The server's links in the crate's `SigchainLink` JSON shape.
    private func cryptoLinksJson(_ links: [SigchainResponseLink]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: try Self.cryptoLinkObjects(links)), as: UTF8.self)
    }

    /// The server's links as the crate's `SigchainLink` objects, for embedding in a
    /// larger crate request (the hub chain's `userChains`, #2963).
    static func cryptoLinkObjects(_ links: [SigchainResponseLink]) throws -> [[String: Any]] {
        let encoder = JSONEncoder()
        return try links.map { l in
            let payload = String(decoding: try encoder.encode(l.payload), as: UTF8.self)
            return [
                "id": l.id,
                "seq": l.seqNo,
                "prevHash": l.prevHash.flatMap { $0.isEmpty ? nil : $0 } ?? NSNull(),
                "entryHash": l.hash,
                "signerDeviceId": l.signerDeviceID,
                "signerPubkey": l.signerPubkey,
                "signature": l.signature,
                "timestamp": l.timestamp,
                "payloadJson": payload,
            ]
        }
    }

    private func json(_ object: [String: Any]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
    }

    // MARK: - Verified head

    /// The head this device last verified for `user`, or nil only when none was
    /// ever recorded. Fails closed: a Keychain read error, a malformed value or
    /// another user's head is an error, never "no head" — "no head" is what lets
    /// a shrunken chain be initialised again. Storing another identity's keys
    /// clears it (`AuthService.storeDeviceKeys`, the one write a new or restored
    /// identity goes through).
    private func verifiedHead(of user: String) throws -> (seq: Int, hash: String)? {
        guard let stored = try keychainService.retrieveString(key: KeychainKey.sigchainHead) else { return nil }
        let parts = stored.split(separator: ":").map(String.init)
        guard parts.count == 3, parts[0] == user, let seq = Int(parts[1]) else { throw IdentityError.unreadableHead }
        return (seq, parts[2])
    }

    private func recordHead(user: String, _ verified: SigchainVerifiedState) throws {
        try keychainService.storeString("\(user):\(verified.headSeq):\(verified.headHash)", key: KeychainKey.sigchainHead)
    }
}
