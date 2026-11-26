import Foundation
import os

// MARK: - DeviceIdentityService

/// Publishes this device in the user's sigchain (#2496; spec
/// 2026-11-25-v2-device-linking-and-recovery §5).
///
/// On every unlock and after enrolment: the user's genesis, first PUK and
/// `puk_epoch` when the chain is still empty and this device never verified one
/// (PROTOCOL.md §2.11), then a `device_kem` link publishing this device's X-Wing
/// key unless the verified chain already names it. A device without one is left
/// out of its hubs' migration genesis device set, so a failure is logged loudly
/// and retried on the next unlock, never skipped.
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
    private var publishedKemKey: String?
    private var inFlight: Task<Void, Error>?

    init(apiService: APIService, cryptoService: CryptoService, keychainService: KeychainService) {
        self.apiService = apiService
        self.cryptoService = cryptoService
        self.keychainService = keychainService
    }

    enum IdentityError: Error, LocalizedError {
        case locked
        case notAuthorised
        case kemNotPublished
        case chainRolledBack
        case unreadableHead

        var errorDescription: String? {
            switch self {
            case .locked: return "Device keys are locked or have no X-Wing key"
            case .notAuthorised: return "Verified sigchain does not authorise this device"
            case .kemNotPublished: return "Verified sigchain does not name this device's X-Wing key"
            case .chainRolledBack: return "The server's sigchain does not extend the head this device verified"
            case .unreadableHead: return "The sigchain head this device recorded cannot be read"
            }
        }
    }

    /// Fire-and-forget form for the unlock and enrolment paths.
    func ensureIdentityInBackground() {
        Task {
            do {
                try await ensureIdentity()
            } catch {
                logger.error("Publishing the device X-Wing key (device_kem) failed: \(error.localizedDescription, privacy: .public)")
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
        if publishedKemKey == kem { return }

        var links = try await sigchain(of: user)
        if let known = try verifiedHead(of: user) {
            guard known.seq >= 1, known.seq <= links.count, links[known.seq - 1].hash == known.hash else {
                throw IdentityError.chainRolledBack
            }
        } else if links.isEmpty {
            links = try await initialiseIdentity(user: user)
        }
        var verified = try cryptoService.verifySigchain(linksJson: try cryptoLinksJson(links))
        guard verified.userPubkey == user, verified.activeDevicePubkeys.contains(user) else {
            throw IdentityError.notAuthorised
        }
        try recordHead(user: user, verified)

        if !verified.deviceKemKeys.contains(where: { $0.devicePubkey == user && $0.kemPubkey == kem }) {
            let payload = try cryptoService.deviceKemPayload(userPubkey: user)
            try await appendSigned(user: user, type: .deviceKem, payloadJson: payload, head: links.last)
            links = try await sigchain(of: user)
            verified = try cryptoService.verifySigchain(linksJson: try cryptoLinksJson(links))
            guard verified.deviceKemKeys.contains(where: { $0.devicePubkey == user && $0.kemPubkey == kem }) else {
                throw IdentityError.kemNotPublished
            }
            try recordHead(user: user, verified)
        }
        publishedKemKey = kem
    }

    // MARK: - Genesis + PUK (PROTOCOL.md §2.11)

    private func initialiseIdentity(user: String) async throws -> [SigchainResponseLink] {
        guard let deviceId = cryptoService.deviceId, let x25519 = cryptoService.encryptionPubkeyHex else {
            throw IdentityError.locked
        }
        let genesis = try json([
            "type": "user_init",
            "deviceId": deviceId,
            "devicePubkey": user,
            "deviceEncryptionPubkey": x25519,
        ])
        try await appendSigned(user: user, type: .genesis, payloadJson: genesis, head: nil)

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
        try await appendSigned(user: user, type: .pukEpoch, payloadJson: epoch, head: try await sigchain(of: user).last)
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
        let encoder = JSONEncoder()
        let array: [[String: Any]] = try links.map { l in
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
        return String(decoding: try JSONSerialization.data(withJSONObject: array), as: UTF8.self)
    }

    private func json(_ object: [String: Any]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
    }

    // MARK: - Verified head

    /// The head this device last verified for `user`, or nil only when none was
    /// ever recorded. Fails closed: a Keychain read error, a malformed value or
    /// another user's head is an error, never "no head" — "no head" is what lets
    /// an empty chain be initialised.
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
