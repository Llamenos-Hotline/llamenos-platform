import Foundation
import os

// MARK: - UserIdentityAPI

/// The server routes identity initialisation uses (docs/protocol/PROTOCOL.md §4.37, §4.38).
/// `APIService` is the production implementation.
protocol UserIdentityAPI: Sendable {
    func getSigchain(userPubkey: String) async throws -> SigchainResponse
    func appendSigchainLink(userPubkey: String, body: AppendSigchainLinkBody) async throws
    func distributePukEnvelopes(_ body: DistributePukEnvelopesBody) async throws
}

extension APIService: UserIdentityAPI {
    func getSigchain(userPubkey: String) async throws -> SigchainResponse {
        try await request(method: "GET", path: "/api/users/\(userPubkey)/sigchain")
    }

    /// Bodies go through a plain encoder: the default request encoder converts keys to
    /// snake_case, and the server's schemas (and the signed payload) are camelCase.
    func appendSigchainLink(userPubkey: String, body: AppendSigchainLinkBody) async throws {
        let _: SigchainLinkRecord = try await request(
            method: "POST",
            path: "/api/users/\(userPubkey)/sigchain",
            rawBody: try JSONEncoder().encode(body)
        )
    }

    func distributePukEnvelopes(_ body: DistributePukEnvelopesBody) async throws {
        let _: DistributePukEnvelopesResponse = try await request(
            method: "POST",
            path: "/api/puk/envelopes",
            rawBody: try JSONEncoder().encode(body)
        )
    }
}

// MARK: - UserIdentityService

/// User identity initialisation — the sigchain genesis link and the first PUK
/// (docs/protocol/PROTOCOL.md §2.11 "Identity initialisation").
///
/// Produces, for the user whose identity key is this device's Ed25519 key:
///
/// 1. seq 1 `genesis` link (payload `user_init`) naming this device's Ed25519 +
///    X25519 keys, signed by this device.
/// 2. PUK generation 1, HPKE-sealed to this device (`LABEL_PUK_WRAP_TO_DEVICE`,
///    AAD `<label>:<deviceId>`), stored at POST /api/puk/envelopes BEFORE the chain
///    claims it, so the chain never names a PUK whose seed was lost.
/// 3. seq 2 `puk_epoch` link binding the PUK's public keys into the chain.
/// 4. The chain as the server stores it, re-verified with packages/crypto
///    `verify_sigchain`, which must authorise this device.
///
/// Mobile creates device keys before the server knows the user: an admin registers
/// the user's pubkey out of band. Until then every identity route answers 401, so
/// initialisation runs at the first authenticated session — after onboarding and
/// after each unlock — and is idempotent: every step is keyed off the server's
/// current chain, so a retry after a partial failure resumes where it stopped.
actor UserIdentityService {
    /// Result of an initialisation attempt.
    enum Outcome: Sendable {
        /// The server's chain verifies and authorises this device.
        case verified(SigchainVerifiedState)
        /// The server does not know this user yet (401) — retried at the next session.
        case notRegistered
    }

    enum IdentityError: LocalizedError, Equatable {
        case createdByAnotherDevice
        case deviceNotAuthorised
        case malformedLink(String)

        var errorDescription: String? {
            switch self {
            case .createdByAnotherDevice: return "This user's sigchain was created by another device"
            case .deviceNotAuthorised: return "Verified sigchain does not authorise this device"
            case .malformedLink(let detail): return "Malformed sigchain link: \(detail)"
            }
        }
    }

    /// Sequence number of the genesis link — packages/protocol `SIGCHAIN_GENESIS_SEQ`,
    /// matching packages/crypto `verify_sigchain`, which requires the first link at seq 1.
    static let genesisSeq = 1

    private let cryptoService: CryptoService
    private let api: any UserIdentityAPI
    private let logger = Logger(subsystem: "org.llamenos.hotline", category: "UserIdentity")
    /// The run in progress, so concurrent callers share one run instead of racing on seq numbers.
    private var inFlight: Task<Outcome, Error>?

    init(cryptoService: CryptoService, api: any UserIdentityAPI) {
        self.cryptoService = cryptoService
        self.api = api
    }

    /// Run `ensureInitialized` detached from the caller's lifecycle. Failures are logged;
    /// the next session resumes from the server's chain.
    nonisolated func ensureInitializedInBackground() {
        Task {
            do {
                switch try await self.ensureInitialized() {
                case .verified(let state):
                    self.logger.info("Identity verified at seq \(state.headSeq)")
                case .notRegistered:
                    self.logger.info("User not registered yet — identity deferred")
                }
            } catch {
                self.logger.error("Identity initialisation failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    /// Create the user's sigchain genesis link and first PUK if they are missing,
    /// then verify the stored chain.
    func ensureInitialized() async throws -> Outcome {
        if let inFlight { return try await inFlight.value }
        let run = Task { try await self.initialize() }
        inFlight = run
        defer { inFlight = nil }
        return try await run.value
    }

    private func initialize() async throws -> Outcome {
        guard cryptoService.isUnlocked,
              let userPubkey = cryptoService.signingPubkeyHex,
              let encryptionPubkey = cryptoService.encryptionPubkeyHex,
              let deviceId = cryptoService.deviceId
        else { throw CryptoServiceError.noKeyLoaded }

        var links: [SigchainResponseLink]
        do {
            links = try await api.getSigchain(userPubkey: userPubkey).links
        } catch APIError.requestFailed(statusCode: 401, _) {
            return .notRegistered
        }

        if links.isEmpty {
            let genesis = SigchainGenesisPayload(
                deviceEncryptionPubkey: encryptionPubkey,
                deviceID: deviceId,
                devicePubkey: userPubkey,
                type: .userInit
            )
            try await appendSignedLink(userPubkey: userPubkey, linkType: .genesis, payload: genesis, head: nil)
            links = try await api.getSigchain(userPubkey: userPubkey).links
        }

        guard let genesisLink = links.first else { throw IdentityError.malformedLink("empty chain after genesis") }
        let genesisPayload = try Self.decodePayload(SigchainGenesisPayload.self, of: genesisLink)
        guard genesisPayload.deviceID == deviceId else { throw IdentityError.createdByAnotherDevice }

        if !links.contains(where: { $0.linkType == SigchainLinkType.pukEpoch.rawValue }) {
            let puk = try cryptoService.createInitialPuk()
            try await api.distributePukEnvelopes(DistributePukEnvelopesBody(envelopes: [
                DistributePukEnvelopesBodyEnvelope(deviceID: deviceId, envelope: puk.envelope, generation: puk.generation),
            ]))
            let epoch = SigchainPukEpochPayload(
                dhPubkey: puk.dhPubkeyHex,
                generation: puk.generation,
                signPubkey: puk.signPubkeyHex,
                type: .pukEpoch
            )
            try await appendSignedLink(userPubkey: userPubkey, linkType: .pukEpoch, payload: epoch, head: links.last)
            links = try await api.getSigchain(userPubkey: userPubkey).links
        }

        let verified = try cryptoService.verifySigchain(links: try links.map(Self.cryptoLink))
        guard verified.activeDevicePubkeys.contains(userPubkey) else { throw IdentityError.deviceNotAuthorised }
        return .verified(verified)
    }

    /// Sign `payload` as the link after `head` and append it to the user's chain.
    private func appendSignedLink<Payload: Encodable>(
        userPubkey: String,
        linkType: SigchainLinkType,
        payload: Payload,
        head: SigchainResponseLink?
    ) async throws {
        let seqNo = head.map { $0.seqNo + 1 } ?? Self.genesisSeq
        let payloadData = try JSONEncoder().encode(payload)
        let timestamp = Self.timestampFormatter.string(from: Date())
        let signed = try cryptoService.createSigchainLink(
            id: UUID().uuidString.lowercased(),
            seq: UInt64(seqNo),
            prevHash: head?.hash,
            timestamp: timestamp,
            payloadJson: String(decoding: payloadData, as: UTF8.self)
        )
        try await api.appendSigchainLink(userPubkey: userPubkey, body: AppendSigchainLinkBody(
            hash: signed.entryHash,
            linkType: linkType,
            payload: try JSONDecoder().decode([String: JSONAny].self, from: payloadData),
            prevHash: head?.hash ?? "",
            seqNo: seqNo,
            signature: signed.signature,
            signerDeviceID: signed.signerDeviceId,
            signerPubkey: signed.signerPubkey,
            timestamp: timestamp
        ))
    }

    /// Map a server link record to the packages/crypto `SigchainLink` `verify_sigchain` takes.
    static func cryptoLink(_ link: SigchainResponseLink) throws -> SigchainLink {
        guard let seq = UInt64(exactly: link.seqNo) else { throw IdentityError.malformedLink("seq \(link.seqNo)") }
        return SigchainLink(
            id: link.id,
            seq: seq,
            prevHash: link.prevHash.isEmpty ? nil : link.prevHash,
            entryHash: link.hash,
            signerDeviceId: link.signerDeviceID,
            signerPubkey: link.signerPubkey,
            signature: link.signature,
            timestamp: link.timestamp,
            payloadJson: String(decoding: try JSONEncoder().encode(link.payload), as: UTF8.self)
        )
    }

    /// Decode a link's payload into its protocol schema type.
    static func decodePayload<Payload: Decodable>(_ type: Payload.Type, of link: SigchainResponseLink) throws -> Payload {
        try JSONDecoder().decode(type, from: try JSONEncoder().encode(link.payload))
    }

    private static let timestampFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
