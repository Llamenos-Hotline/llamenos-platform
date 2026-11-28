import CryptoKit
import Foundation

// MARK: - File-level references to UniFFI global functions
// Needed because CryptoService method names shadow some global function names.
// At file scope there is no `self`, so these unambiguously refer to the UniFFI functions.

// V3 device key management (stateful — secrets held in Rust memory)
private func ffiMobileGenerateAndLoad(deviceId: String, pin: String) throws -> EncryptedDeviceKeys {
    try mobileGenerateAndLoad(deviceId: deviceId, pin: pin)
}

private func ffiMobileUnlock(data: EncryptedDeviceKeys, pin: String) throws -> DeviceKeyState {
    try mobileUnlock(data: data, pin: pin)
}

private func ffiMobileUserInitPayload() throws -> String {
    try mobileUserInitPayload()
}

private func ffiMobileSigchainVerifyUsers(chainsJson: String) throws -> [SigchainVerifiedState] {
    try mobileSigchainVerifyUsers(chainsJson: chainsJson)
}

// Hub authority chain (#2963)
private func ffiMobileHubChain(requestJson: String) throws -> String {
    try mobileHubChain(requestJson: requestJson)
}

private func ffiMobileHubChainSign(requestJson: String) throws -> String {
    try mobileHubChainSign(requestJson: requestJson)
}

private func ffiMobileRecoveryApprovalSign(approvalJson: String) throws -> String {
    try mobileRecoveryApprovalSign(approvalJson: approvalJson)
}

private func ffiMobileCreateBackup(pin: String, recoveryKey: String) throws -> String {
    try mobileCreateBackup(pin: pin, recoveryKey: recoveryKey)
}

private func ffiMobileRestoreBackupAndLoad(
    backupJson: String, credential: String, isRecoveryKey: Bool, newPin: String, deviceId: String
) throws -> EncryptedDeviceKeys {
    try mobileRestoreBackupAndLoad(
        backupJson: backupJson, credential: credential, isRecoveryKey: isRecoveryKey, newPin: newPin, deviceId: deviceId
    )
}

private func ffiMobileLock() {
    mobileLock()
}

private func ffiMobileIsUnlocked() -> Bool {
    mobileIsUnlocked()
}

private func ffiMobileGetDeviceState() throws -> DeviceKeyState {
    try mobileGetDeviceState()
}

private func ffiMobileIsValidPin(_ pin: String) -> Bool {
    mobileIsValidPin(pin: pin)
}

// V3 auth (Ed25519, stateful)
private func ffiMobileCreateAuthToken(timestamp: UInt64, method: String, path: String) throws -> AuthToken {
    try mobileCreateAuthToken(timestamp: timestamp, method: method, path: path)
}

// V3 HPKE, by shape (spec D1): the crate supplies the label and the AAD.
private func ffiMobileShapeSeal(shape: Shape, recipientPubkeyHex: String, aadFields: [String], plaintextHex: String) throws -> HpkeEnvelope {
    try mobileShapeSeal(shape: shape, recipientPubkeyHex: recipientPubkeyHex, aadFields: aadFields, plaintextHex: plaintextHex)
}

private func ffiMobileShapeOpen(shape: Shape, aadFields: [String], envelope: HpkeEnvelope) throws -> String {
    try mobileShapeOpen(shape: shape, aadFields: aadFields, envelope: envelope)
}

// The content layer of a shape (AES-256-GCM under the shape's content AAD).
private func ffiMobileContentSeal(shape: Shape, plaintextHex: String) throws -> [String] {
    try mobileContentSeal(shape: shape, plaintextHex: plaintextHex)
}

private func ffiMobileContentOpen(shape: Shape, ciphertextHex: String, keyHex: String) throws -> String {
    try mobileContentOpen(shape: shape, ciphertextHex: ciphertextHex, keyHex: keyHex)
}

/// Unwrap and open in one call — the content key never reaches Swift.
private func ffiMobileOpenSealedContent(shape: Shape, ciphertextHex: String, envelope: HpkeEnvelope) throws -> String {
    try mobileOpenSealedContent(shape: shape, ciphertextHex: ciphertextHex, envelope: envelope)
}

// Stored multi-reader records (messages, call metadata): Rust picks this device's
// envelope and opens it — neither the device key nor the content key reaches Swift.
private func ffiMobileDecryptCallMetadata(encryptedContent: String, envelopes: [RecipientKeyEnvelope]) throws -> String {
    try mobileDecryptCallMetadata(encryptedContent: encryptedContent, envelopes: envelopes)
}

private func ffiMobileDecryptMessage(encryptedContent: String, envelopes: [RecipientKeyEnvelope]) throws -> String {
    try mobileDecryptMessage(encryptedContent: encryptedContent, envelopes: envelopes)
}

// V3 PUK
private func ffiMobilePukCreate() throws -> String {
    try mobilePukCreate()
}

// V3 Sigchain (stateful + stateless verification)
private func ffiMobileSigchainCreateLink(id: String, seq: UInt64, prevHash: String?, timestamp: String, payloadJson: String) throws -> SigchainLink {
    try mobileSigchainCreateLink(id: id, seq: seq, prevHash: prevHash, timestamp: timestamp, payloadJson: payloadJson)
}

private func ffiMobileSigchainVerifyLink(linkJson: String, expectedSignerPubkey: String) throws -> Bool {
    try mobileSigchainVerifyLink(linkJson: linkJson, expectedSignerPubkey: expectedSignerPubkey)
}

private func ffiMobileEd25519Verify(messageHex: String, signatureHex: String, pubkeyHex: String) throws -> Bool {
    try mobileEd25519Verify(messageHex: messageHex, signatureHex: signatureHex, pubkeyHex: pubkeyHex)
}

// Functions still needed for device linking
private func ffiComputeSharedXHex(ourSecretHex: String, theirPubkeyHex: String) throws -> String {
    try computeSharedXHex(ourSecretHex: ourSecretHex, theirPubkeyHex: theirPubkeyHex)
}

private func ffiDecryptWithSharedKeyHex(ciphertextHex: String, sharedXHex: String) throws -> String {
    try decryptWithSharedKeyHex(ciphertextHex: ciphertextHex, sharedXHex: sharedXHex)
}

private func ffiComputeSasCode(sharedXHex: String) throws -> String {
    try computeSasCode(sharedXHex: sharedXHex)
}

private func ffiMobileRandomBytesHex() -> String {
    mobileRandomBytesHex()
}

private func ffiGenerateEphemeralKeypair() -> EphemeralKeyPair {
    generateEphemeralKeypairMobile()
}

// V3 Shamir secret sharing (stateless — all ops are pure functions on share data)
private func ffiMobileShamirSplit(secretHex: String, total: UInt8, threshold: UInt8) throws -> [ShamirShare] {
    try mobileShamirSplit(secretHex: secretHex, total: total, threshold: threshold)
}

private func ffiMobileShamirCombine(shares: [ShamirShare], threshold: UInt8) throws -> String {
    try mobileShamirCombine(shares: shares, threshold: threshold)
}

private func ffiMobileShamirCommit(share: ShamirShare) throws -> String {
    try mobileShamirCommit(share: share)
}

private func ffiMobileShamirVerify(share: ShamirShare, commitmentHex: String) throws -> Bool {
    try mobileShamirVerify(share: share, commitmentHex: commitmentHex)
}

// Recovery share liveness proof (#2782) — opens the share and signs inside Rust
private func ffiMobileRecoveryShareLivenessProof(
    shareEnvelope: HpkeEnvelope, hubId: String, challengeHex: String
) throws -> String {
    try mobileRecoveryShareLivenessProof(shareEnvelope: shareEnvelope, hubId: hubId, challengeHex: challengeHex)
}

// Ban digest (#2759) — stateless RFC 9497 OPRF client half (packages/crypto/src/ban_digest.rs)
private func ffiBanDigestBlind(phone: String) throws -> BanDigestBlind {
    try banDigestBlind(phone: phone)
}

private func ffiBanDigestFinalize(phone: String, blindHex: String, evaluatedElementHex: String) throws -> String {
    try banDigestFinalize(phone: phone, blindHex: blindHex, evaluatedElementHex: evaluatedElementHex)
}

// V3 Recovery group keypair generation (stateless — produces X25519 keypair)
private func ffiMobileRecoveryGroupGenerateKeypair() -> RecoveryGroupKeypair {
    mobileRecoveryGroupGenerateKeypair()
}

// V3 Draft encryption (hub-key-based, secrets stay in Rust)
private func ffiMobileEncryptDraft(plaintext: String, hubId: String) throws -> String {
    try mobileEncryptDraft(plaintext: plaintext, hubId: hubId)
}

private func ffiMobileDecryptDraft(packedHex: String, hubId: String) throws -> String {
    try mobileDecryptDraft(packedHex: packedHex, hubId: hubId)
}

// V3 Ed25519 signing (stateful — uses device signing key)
private func ffiMobileSign(messageHex: String) throws -> String {
    try mobileSign(messageHex: messageHex)
}

// Hub key + server event key management (keys stored in Rust, never in Swift)
private func ffiMobileSetHubKey(hubId: String, keyHex: String) throws {
    try mobileSetHubKey(hubId: hubId, keyHex: keyHex)
}

private func ffiMobileHasHubKey(hubId: String) -> Bool {
    mobileHasHubKey(hubId: hubId)
}

private func ffiMobileClearHubKeys() {
    mobileClearHubKeys()
}

private func ffiMobileEncryptHubField(plaintext: String, hubId: String, label: String) throws -> String {
    try mobileEncryptHubField(plaintext: plaintext, hubId: hubId, label: label)
}

private func ffiMobileDecryptHubField(packedHex: String, hubId: String, label: String) throws -> String {
    try mobileDecryptHubField(packedHex: packedHex, hubId: hubId, label: label)
}

private func ffiMobileSetServerEventKeys(keys: [ServerEventKey]) throws {
    try mobileSetServerEventKeys(keys: keys)
}

private func ffiMobileOpenServerEvent(hubId: String, kind: UInt32, epoch: UInt64, payloadHex: String) throws -> String {
    try mobileOpenServerEvent(hubId: hubId, kind: kind, epoch: epoch, payloadHex: payloadHex)
}

// MARK: - CryptoService

enum CryptoServiceError: LocalizedError, Equatable {
    case noKeyLoaded
    case invalidPin
    case encryptionFailed(String)
    case decryptionFailed(String)

    var errorDescription: String? {
        switch self {
        case .noKeyLoaded:
            return NSLocalizedString("error_no_key_loaded", comment: "No cryptographic key is loaded")
        case .invalidPin:
            return NSLocalizedString("error_invalid_pin", comment: "PIN must be 6-8 digits")
        case .encryptionFailed(let detail):
            return L10n.format("error_encryption_failed", comment: "Encryption failed: %@", detail)
        case .decryptionFailed(let detail):
            return L10n.format("error_decryption_failed", comment: "Decryption failed: %@", detail)
        }
    }
}

/// Central cryptographic service using the v3 device key model.
///
/// Device secrets, hub keys, and server event keys are held exclusively in Rust memory.
/// The Swift layer only sees public keys and operation results — secrets NEVER leave Rust.
@Observable
final class CryptoService: @unchecked Sendable {
    private(set) var signingPubkeyHex: String?
    private(set) var encryptionPubkeyHex: String?
    private(set) var deviceId: String?
    /// This device's X-Wing public key, once unlocked (crypto_format 2, wire spec D16).
    private(set) var kemPubkeyHex: String?
    var pubkey: String? { encryptionPubkeyHex }
    var isUnlocked: Bool { ffiMobileIsUnlocked() }
    var hasIdentity: Bool { signingPubkeyHex != nil }

    // MARK: - Device Key Generation

    func generateDeviceKeys(deviceId: String, pin: String) throws -> EncryptedDeviceKeys {
        guard ffiMobileIsValidPin(pin) else { throw CryptoServiceError.invalidPin }
        let encrypted = try ffiMobileGenerateAndLoad(deviceId: deviceId, pin: pin)
        adopt(encrypted.state)
        return encrypted
    }

    // MARK: - Unlock / Lock

    /// Unlock the stored device keys. Unlocking only reads the device's X-Wing
    /// seed; it is never redrawn (#2496).
    func unlockWithPin(data: EncryptedDeviceKeys, pin: String) throws -> DeviceKeyState {
        let ds = try ffiMobileUnlock(data: data, pin: pin)
        adopt(ds)
        return ds
    }

    private func adopt(_ ds: DeviceKeyState) {
        self.signingPubkeyHex = ds.signingPubkeyHex
        self.encryptionPubkeyHex = ds.encryptionPubkeyHex
        self.kemPubkeyHex = ds.kemPubkeyHex
        self.deviceId = ds.deviceId
    }

    /// This device's genesis `user_init` payload JSON (spec 2026-11-25 §5 as
    /// revised 2026-11-26): its Ed25519, X25519 and X-Wing keys, `format: 2` and
    /// the possession signature, made in Rust. Sign the link carrying it with
    /// `createSigchainLink`.
    func userInitPayload() throws -> String {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        return try ffiMobileUserInitPayload()
    }

    /// Verify several users' chains together (spec §6): each chain verified,
    /// then any key named by two users' chains refused (`chain_key_reused`).
    func verifySigchains(chainsJson: String) throws -> [SigchainVerifiedState] {
        try ffiMobileSigchainVerifyUsers(chainsJson: chainsJson)
    }

    // MARK: - Device backup (packages/crypto backup.rs, v6)

    /// A fresh recovery key for display: base32, dash-grouped.
    func generateRecoveryKey() -> String {
        mobileGenerateRecoveryKey()
    }

    /// The loaded device's backup file (JSON): its three seeds — signing, X25519
    /// and X-Wing — sealed under `pin` and `recoveryKey`. The seeds never leave Rust.
    func createBackup(pin: String, recoveryKey: String) throws -> String {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        return try ffiMobileCreateBackup(pin: pin, recoveryKey: recoveryKey)
    }

    /// Restore a device from a backup file and load it, re-encrypted under
    /// `newPin`. The X-Wing key comes back with the other two, so it is the one
    /// the user's chain names (#3053). A backup without the X-Wing seed throws
    /// `CryptoError.BackupMissingXwingSeed` — it is never half-restored.
    func restoreBackup(
        backupJson: String, credential: String, isRecoveryKey: Bool, newPin: String, deviceId: String
    ) throws -> EncryptedDeviceKeys {
        let encrypted = try ffiMobileRestoreBackupAndLoad(
            backupJson: backupJson, credential: credential, isRecoveryKey: isRecoveryKey, newPin: newPin, deviceId: deviceId
        )
        adopt(encrypted.state)
        return encrypted
    }

    /// Lock the crypto state — zeroize device secrets, hub keys, and server event keys in Rust.
    /// Public keys are retained for locked-state UI display ("Locked as ...").
    func lock() {
        ffiMobileLock()
        // mobile_lock() already clears hub keys and server event keys in Rust
    }

    // MARK: - Auth Token (Ed25519)

    func createAuthToken(method: String, path: String) throws -> AuthToken {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        let timestamp = UInt64(Date().timeIntervalSince1970 * 1000)
        return try ffiMobileCreateAuthToken(timestamp: timestamp, method: method, path: path)
    }

    // MARK: - Note Encryption (HPKE)

    func encryptNote(payload: String, recipientPubkeys: [String]) throws -> (ciphertextHex: String, envelopes: [(pubkey: String, envelope: HpkeEnvelope)]) {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        let plaintextHex = payload.data(using: .utf8)!.map { String(format: "%02x", $0) }.joined()
        let result = try ffiMobileContentSeal(shape: .noteKey, plaintextHex: plaintextHex)
        let ciphertextHex = result[0]
        let keyHex = result[1]
        var envelopes: [(pubkey: String, envelope: HpkeEnvelope)] = []
        for pubkey in recipientPubkeys {
            let sealed = try ffiMobileShapeSeal(shape: .noteKey, recipientPubkeyHex: pubkey, aadFields: [], plaintextHex: keyHex)
            envelopes.append((pubkey: pubkey, envelope: sealed))
        }
        return (ciphertextHex, envelopes)
    }

    // MARK: - Note Decryption (HPKE)

    func decryptNote(ciphertextHex: String, envelope: HpkeEnvelope) throws -> String {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        let plaintextHex = try ffiMobileOpenSealedContent(shape: .noteKey, ciphertextHex: ciphertextHex, envelope: envelope)
        guard let data = hexToData(plaintextHex), let result = String(data: data, encoding: .utf8) else {
            throw CryptoServiceError.decryptionFailed("Invalid UTF-8 in decrypted note")
        }
        return result
    }

    // MARK: - Message Encryption (HPKE)

    /// Seal a message (`LABEL_MESSAGE`) for this device and `readerPubkeys` in
    /// the stored-record format the server and desktop read and write.
    ///
    /// Rust owns the AAD: a stored record carries **no** AAD on either layer
    /// (PROTOCOL.md §2.4), unlike notes/files/contacts, which bind `label` and
    /// `label:key-wrap`. This function used to pass the canonical AAD itself,
    /// so a message sealed here could not be opened by the server or desktop
    /// and vice versa (#1927). Do not choose an AAD at this call site.
    func encryptMessage(plaintext: String, readerPubkeys: [String]) throws -> (encryptedContent: String, envelopes: [RecipientEnvelope]) {
        guard let encPubkey = encryptionPubkeyHex else { throw CryptoServiceError.noKeyLoaded }
        let allReaders = Array(Set([encPubkey] + readerPubkeys))
        let sealed = try mobileEncryptMessage(plaintext: plaintext, readerPubkeys: allReaders)
        let envelopes = sealed.readerEnvelopes.map { RecipientEnvelope(ct: $0.ct, enc: $0.enc, pubkey: $0.pubkey) }
        return (sealed.encryptedContent, envelopes)
    }

    // MARK: - Message Decryption (HPKE)

    /// Decrypt a conversation message from all of its reader envelopes, whether
    /// a client sealed it or the server did (inbound SMS/WhatsApp/Signal,
    /// server-encrypted outbound). Rust picks this device's envelope.
    func decryptMessage(encryptedContent: String, readerEnvelopes: [RecipientEnvelope]) throws -> String {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        let envelopes = readerEnvelopes.map { RecipientKeyEnvelope(pubkey: $0.pubkey, enc: $0.enc, ct: $0.ct) }
        return try ffiMobileDecryptMessage(encryptedContent: encryptedContent, envelopes: envelopes)
    }

    // MARK: - Contact Encryption (HPKE)

    /// Encrypt contact data (summary or PII) for multiple readers.
    /// Returns the ciphertext hex and per-reader HPKE envelopes.
    ///
    /// - Parameters:
    ///   - jsonPayload: JSON string of the contact data to encrypt.
    ///   - readerPubkeys: X25519 public keys of all intended readers.
    ///   - shape: `.contactProfileKey` or `.contactIdKey` — the crate supplies label and AAD.
    /// - Returns: Ciphertext hex and per-reader envelopes with pubkey, enc, ct.
    func encryptContactData(jsonPayload: String, readerPubkeys: [String], shape: Shape) throws -> (ciphertextHex: String, envelopes: [RecipientEnvelope]) {
        guard let encPubkey = encryptionPubkeyHex else { throw CryptoServiceError.noKeyLoaded }
        let allReaders = Array(Set([encPubkey] + readerPubkeys))
        let plaintextHex = jsonPayload.data(using: .utf8)!.map { String(format: "%02x", $0) }.joined()
        let result = try ffiMobileContentSeal(shape: shape, plaintextHex: plaintextHex)
        let ciphertextHex = result[0]
        let keyHex = result[1]
        var envelopes: [RecipientEnvelope] = []
        for pubkey in allReaders {
            let hpkeEnv = try ffiMobileShapeSeal(shape: shape, recipientPubkeyHex: pubkey, aadFields: [], plaintextHex: keyHex)
            envelopes.append(RecipientEnvelope(ct: hpkeEnv.ct, enc: hpkeEnv.enc, pubkey: pubkey))
        }
        return (ciphertextHex, envelopes)
    }

    /// Decrypt contact data (summary or PII) using the device's HPKE key.
    ///
    /// - Parameters:
    ///   - ciphertextHex: The encrypted contact data.
    ///   - envelope: The HPKE envelope for this device.
    ///   - shape: `.contactProfileKey` or `.contactIdKey`.
    /// - Returns: Decrypted JSON string.
    func decryptContactData(ciphertextHex: String, envelope: HpkeEnvelope, shape: Shape) throws -> String {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        let plaintextHex = try ffiMobileOpenSealedContent(shape: shape, ciphertextHex: ciphertextHex, envelope: envelope)
        guard let data = hexToData(plaintextHex), let result = String(data: data, encoding: .utf8) else {
            throw CryptoServiceError.decryptionFailed("Invalid UTF-8 in decrypted contact data")
        }
        return result
    }

    // MARK: - Case records + case comments (sealed per purpose, #2499)

    /// Seal a case record's summary or fields, or a case comment, as this
    /// device for this device plus `readerPubkeys` (X25519).
    ///
    /// There is no label and no AAD parameter: `mobileSealCase` derives both
    /// from `purpose` inside `packages/crypto/src/case_record.rs`, the code
    /// desktop, Android and the server run too. iOS used to take the label as a
    /// parameter and compose the envelope here; it happened to choose correctly
    /// (`LABEL_CASE_SUMMARY`, canonical AAD) while desktop and Android chose
    /// `LABEL_MESSAGE` with no AAD — the ability to choose was the defect.
    ///
    /// Envelopes come back in wire form (`enc`/`ct` hex), addressed to each
    /// reader's X25519 key.
    func sealCase(purpose: CasePurpose, plaintext: String, readerPubkeys: [String]) throws -> (encryptedContent: String, envelopes: [RecipientEnvelope]) {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        let sealed = try mobileSealCase(purpose: purpose, plaintext: plaintext, readerPubkeys: readerPubkeys)
        let envelopes = sealed.readerEnvelopes.map { RecipientEnvelope(ct: $0.ct, enc: $0.enc, pubkey: $0.pubkey) }
        return (sealed.encryptedContent, envelopes)
    }

    /// Open a case ciphertext as this device from all of its envelopes; Rust
    /// picks the one addressed to this device's X25519 key.
    func openCase(purpose: CasePurpose, encryptedContent: String, envelopes: [RecipientEnvelope]) throws -> String {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        return try mobileOpenCase(
            purpose: purpose,
            encryptedContent: encryptedContent,
            envelopes: envelopes.map { RecipientKeyEnvelope(pubkey: $0.pubkey, enc: $0.enc, ct: $0.ct) }
        )
    }

    // MARK: - Free-text shift fields (sealed per purpose, #2777, #2778)

    /// Seal an availability reason or an override note as this device, for this
    /// device plus `readerPubkeys` (X25519).
    ///
    /// No label and no AAD parameter: `mobileSealShiftField` derives both from
    /// `purpose` inside `packages/crypto/src/shift_record.rs`. Both fields used
    /// to go on the wire as the typed text, into columns named `encrypted_*`.
    func sealShiftField(purpose: ShiftFieldPurpose, plaintext: String, readerPubkeys: [String]) throws -> SealedShiftField {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        let sealed = try mobileSealShiftField(purpose: purpose, plaintext: plaintext, readerPubkeys: readerPubkeys)
        return SealedShiftField(
            encryptedContent: sealed.encryptedContent,
            envelopes: sealed.readerEnvelopes.map { SharedAdminEnvelope(ct: $0.ct, enc: $0.enc, pubkey: $0.pubkey) }
        )
    }

    /// Open a sealed shift field as this device from all of its envelopes; Rust
    /// picks the one addressed to this device's X25519 key.
    func openShiftField(purpose: ShiftFieldPurpose, sealed: SealedShiftField) throws -> String {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        return try mobileOpenShiftField(
            purpose: purpose,
            encryptedContent: sealed.encryptedContent,
            envelopes: sealed.envelopes.map { RecipientKeyEnvelope(pubkey: $0.pubkey, enc: $0.enc, ct: $0.ct) }
        )
    }

    /// Generate 32 random bytes as hex (for content keys, etc.).
    func randomBytesHex() -> String {
        ffiMobileRandomBytesHex()
    }

    // MARK: - PUK Operations

    func createInitialPuk() throws -> String {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        return try ffiMobilePukCreate()
    }

    /// Unwrap a PUK seed sealed to this device. The puk-seed shape binds this
    /// device's id, which Rust takes from its own state.
    func unwrapPukSeed(envelope: HpkeEnvelope) throws -> String {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        return try mobilePukUnwrapSeed(envelope: envelope)
    }

    // MARK: - Sigchain Operations

    func createSigchainLink(id: String, seq: UInt64, prevHash: String?, timestamp: String, payloadJson: String) throws -> SigchainLink {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        return try ffiMobileSigchainCreateLink(id: id, seq: seq, prevHash: prevHash, timestamp: timestamp, payloadJson: payloadJson)
    }

    /// Verify a whole user sigchain through packages/crypto `verify_sigchain`
    /// (stateless). `linksJson` is a JSON array of the crate's `SigchainLink`.
    func verifySigchain(linksJson: String) throws -> SigchainVerifiedState {
        try mobileSigchainVerify(linksJson: linksJson)
    }

    // MARK: - Hub Authority Chain (#2963; wire spec §5)

    /// One stateless hub-chain operation in Rust (`hub_chain::call`): `requestJson`
    /// is `{"op": "verify" | "signingMessage" | "assemble" | "permsHash" |
    /// "verifySigchain" | "approvalMessage" | "build" | "usersNamed", …}`, the answer the crate's JSON. The app
    /// never canonicalises, hashes or checks a hub link itself.
    func hubChainCall(requestJson: String) throws -> String {
        try ffiMobileHubChain(requestJson: requestJson)
    }

    /// Build and sign one hub-chain link from an intent (JSON
    /// `hub_chain::LinkIntentRequest`) with this device's key, held in Rust. The
    /// answer is `{link, head}`; the crate derives every signed field (#3133).
    func signHubIntent(requestJson: String) throws -> String {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        return try ffiMobileHubChainSign(requestJson: requestJson)
    }

    /// Sign a recovery approval (JSON) with this holder device's key (D14).
    func signRecoveryApproval(approvalJson: String) throws -> String {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        return try ffiMobileRecoveryApprovalSign(approvalJson: approvalJson)
    }

    /// Verify a single sigchain link's Ed25519 signature against an expected signer pubkey.
    /// Stateless — no device key needed.
    func verifySigchainLink(linkJson: String, expectedSignerPubkey: String) throws -> Bool {
        try ffiMobileSigchainVerifyLink(linkJson: linkJson, expectedSignerPubkey: expectedSignerPubkey)
    }

    /// Verify an Ed25519 signature (stateless — no device key needed).
    /// All inputs are hex-encoded.
    func ed25519Verify(messageHex: String, signatureHex: String, pubkeyHex: String) throws -> Bool {
        try ffiMobileEd25519Verify(messageHex: messageHex, signatureHex: signatureHex, pubkeyHex: pubkeyHex)
    }

    // MARK: - Device Linking ECDH (X25519)

    func generateEphemeralKeypair() -> (secretHex: String, publicHex: String) {
        let kp = ffiGenerateEphemeralKeypair()
        return (kp.secretKeyHex, kp.publicKey)
    }

    func deriveSharedSecret(ourSecret: String, theirPublic: String) throws -> String {
        try ffiComputeSharedXHex(ourSecretHex: ourSecret, theirPubkeyHex: theirPublic)
    }

    func decryptWithSharedSecret(encrypted: String, sharedSecret: String) throws -> String {
        guard !encrypted.isEmpty else { throw CryptoServiceError.decryptionFailed("Empty ciphertext") }
        return try ffiDecryptWithSharedKeyHex(ciphertextHex: encrypted, sharedXHex: sharedSecret)
    }

    // MARK: - SAS Code

    func deriveSASCode(sharedSecret: String) throws -> String {
        try ffiComputeSasCode(sharedXHex: sharedSecret)
    }

    // MARK: - Stateless Auth Token (test bootstrap)

    // Gate behind #if DEBUG so this method is excluded from Release and any build
    // that does not explicitly use a Debug-derived configuration. The callers in
    // AppState are already behind #if UI_TESTING, but gating the method itself
    // prevents it from being reachable from any other code path in release builds.
    #if DEBUG
    static func createAuthTokenStatic(secretHex: String, method: String, path: String) throws -> AuthToken {
        let timestamp = UInt64(Date().timeIntervalSince1970 * 1000)
        return try mobileCreateAuthTokenFromSigningKey(signingKeyHex: secretHex, timestamp: timestamp, method: method, path: path)
    }
    #endif

    // MARK: - Hub Key Management (keys stored in Rust, never in Swift)

    /// Returns true if a key for the given hub is stored in Rust.
    func hasHubKey(hubId: String) -> Bool {
        ffiMobileHasHubKey(hubId: hubId)
    }

    /// Unwrap a hub key envelope using HPKE and store in Rust CryptoState.
    /// Hub key never enters Swift memory — goes directly from HPKE open to Rust storage.
    ///
    /// The hub-key shape fixes the label and AAD in Rust — the same call Android
    /// makes (`mobile_load_hub_key`) — and the key goes straight to Rust state.
    func loadHubKey(hubId: String, envelope: HubKeyEnvelopeResponse) throws {
        guard !hasHubKey(hubId: hubId) else { return }
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        try mobileLoadHubKey(hubId: hubId, enc: envelope.envelope.enc, ct: envelope.envelope.ct)
    }

    /// Evict all hub keys from Rust memory. Called on lock and logout.
    func clearHubKeys() {
        ffiMobileClearHubKeys()
    }

    // MARK: - Hub Field Encryption

    /// Seal a small hub-scoped field (tag label, tag category) under the hub key
    /// held in Rust. `label` is the domain-separation constant bound as AAD
    /// (e.g. `CryptoLabels.LABEL_TAG_ENCRYPT`); Rust refuses an unregistered one.
    /// Returns `hex(nonce_12 || ciphertext || tag_16)` — the desktop wire format.
    func encryptHubField(plaintext: String, hubId: String, label: String) throws -> String {
        try ffiMobileEncryptHubField(plaintext: plaintext, hubId: hubId, label: label)
    }

    /// Open a hub-scoped field. Returns nil on any failure (no key for the hub,
    /// wrong key or label, corrupted data) — matching desktop's `decryptHubField`,
    /// so callers fall back to the raw stored value.
    func decryptHubField(ciphertextHex: String, hubId: String, label: String) -> String? {
        try? ffiMobileDecryptHubField(packedHex: ciphertextHex, hubId: hubId, label: label)
    }

    // MARK: - Relay events (spec D9, #2999)

    /// Replace the relay-event keys held in Rust with the server's list — one per
    /// (hub, epoch) for the hubs this user belongs to (`GET /api/auth/me`).
    func setServerEventKeys(_ keys: [ServerEventKey]) throws {
        try ffiMobileSetServerEventKeys(keys: keys)
    }

    /// Open a relay frame with the key Rust holds for its hub and epoch. The
    /// frame's hub, kind and epoch are bound in its AAD. Returns nil when it does
    /// not open — including a frame of a hub this user holds no key for.
    func openServerEvent(hubId: String, kind: Int, epoch: Int, payloadHex: String) -> String? {
        try? ffiMobileOpenServerEvent(hubId: hubId, kind: UInt32(kind), epoch: UInt64(epoch), payloadHex: payloadHex)
    }

    // MARK: - Shamir Secret Sharing

    func shamirSplit(secretHex: String, total: UInt8, threshold: UInt8) throws -> [ShamirShare] {
        try ffiMobileShamirSplit(secretHex: secretHex, total: total, threshold: threshold)
    }

    func shamirCombine(shares: [ShamirShare], threshold: UInt8) throws -> String {
        try ffiMobileShamirCombine(shares: shares, threshold: threshold)
    }

    func shamirCommit(share: ShamirShare) throws -> String {
        try ffiMobileShamirCommit(share: share)
    }

    func shamirVerify(share: ShamirShare, commitment: String) throws -> Bool {
        try ffiMobileShamirVerify(share: share, commitmentHex: commitment)
    }

    // MARK: - Ban Digest (#2759)

    /// Blind an E.164 number for a ban digest. Send `blindedElementHex` to the server's evaluate
    /// endpoint and keep `blindHex` for `banDigestFinalize`: the number never leaves the device.
    /// Throws for anything that is not E.164.
    func banDigestBlind(phone: String) throws -> BanDigestBlind {
        try ffiBanDigestBlind(phone: phone)
    }

    /// Finalize the server's evaluated element into the number's ban digest (128 hex chars).
    func banDigestFinalize(phone: String, blindHex: String, evaluatedElementHex: String) throws -> String {
        try ffiBanDigestFinalize(phone: phone, blindHex: blindHex, evaluatedElementHex: evaluatedElementHex)
    }

    // MARK: - HPKE, by shape

    /// HPKE-seal `plaintextHex` as `shape` to a recipient's public key. The crate
    /// supplies the label and AAD; `aadFields` are the values the shape binds.
    func shapeSeal(shape: Shape, recipientPubkeyHex: String, plaintextHex: String, aadFields: [String] = []) throws -> HpkeEnvelope {
        try ffiMobileShapeSeal(shape: shape, recipientPubkeyHex: recipientPubkeyHex, aadFields: aadFields, plaintextHex: plaintextHex)
    }

    /// HPKE-open an envelope of `shape` with our device private key.
    func shapeOpen(shape: Shape, envelope: HpkeEnvelope, aadFields: [String] = []) throws -> String {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        return try ffiMobileShapeOpen(shape: shape, aadFields: aadFields, envelope: envelope)
    }

    // MARK: - Ed25519 Signing

    /// Sign a hex-encoded message using the device's Ed25519 signing key.
    func ed25519Sign(messageHex: String) throws -> String {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        return try ffiMobileSign(messageHex: messageHex)
    }

    // MARK: - Symmetric Encryption (AES-256-GCM)

    // MARK: - Recovery Group

    func recoveryGroupGenerateKeypair() -> RecoveryGroupKeypair {
        ffiMobileRecoveryGroupGenerateKeypair()
    }

    /// Prove this device still holds its recovery share (#2782).
    ///
    /// Rust opens the holder's share envelope with this device's key and signs
    /// the server's single-use `challengeHex` with the key derived from the
    /// share, bound to `hubId` and to this device's own signing pubkey — the
    /// identity the server authenticates the submission as. Returns the proof
    /// (hex) for `POST /api/recovery-group/shares/liveness`. Neither the share
    /// nor the derived key enters Swift.
    func recoveryShareLivenessProof(shareEnvelope: HpkeEnvelope, hubId: String, challengeHex: String) throws -> String {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        return try ffiMobileRecoveryShareLivenessProof(
            shareEnvelope: shareEnvelope,
            hubId: hubId,
            challengeHex: challengeHex
        )
    }

    // MARK: - Call Metadata Decryption (HPKE)

    /// Decrypt call metadata (callerNumber, answeredBy) from a call record.
    /// The server seals it and addresses the admin's envelope by the account
    /// (Ed25519) key; Rust matches either of this device's keys and opens the
    /// wrap with the X25519 key. Returns nil if no envelope is ours or it fails to open.
    func decryptCallMetadata(
        encryptedContent: String,
        adminEnvelopes: [(pubkey: String, enc: String, ct: String)]
    ) -> (callerNumber: String, answeredBy: String?)? {
        guard isUnlocked else { return nil }
        let envelopes = adminEnvelopes.map { RecipientKeyEnvelope(pubkey: $0.pubkey, enc: $0.enc, ct: $0.ct) }
        guard let json = try? ffiMobileDecryptCallMetadata(encryptedContent: encryptedContent, envelopes: envelopes),
              let jsonData = json.data(using: .utf8),
              let dict = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else {
            return nil
        }
        let callerNumber = dict["callerNumber"] as? String ?? "Unknown"
        let answeredBy = dict["answeredBy"] as? String
        return (callerNumber, answeredBy)
    }

    // MARK: - File Encryption (HPKE)

    /// Encrypt file data for multiple recipients using HPKE envelope encryption.
    ///
    /// The content is sealed under a fresh key as the file-key shape; that key is
    /// HPKE-wrapped to each recipient as the same shape, and the file's metadata is
    /// sealed per recipient as the file-metadata-key shape. The
    /// envelopes come back in wire form (`enc`/`ct` hex, PROTOCOL.md §2.3), the
    /// shape `POST /hubs/:hubId/uploads/init` stores and every client opens.
    func encryptFile(
        data: Data,
        fileName: String,
        mimeType: String,
        recipientPubkeys: [String]
    ) throws -> (
        encryptedData: Data,
        keyEnvelopes: [(pubkey: String, enc: String, ct: String)],
        metadataEnvelopes: [(pubkey: String, encryptedContent: String, enc: String, ct: String)]
    ) {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }

        let metadata: [String: Any] = [
            "originalName": fileName,
            "mimeType": mimeType,
            "size": data.count,
            "checksum": sha256Hex(data)
        ]
        let metadataData = try JSONSerialization.data(withJSONObject: metadata)
        let metadataHex = metadataData.map { String(format: "%02x", $0) }.joined()

        // symmetric_encrypt draws the random file key and returns it with the ciphertext.
        let dataHex = data.map { String(format: "%02x", $0) }.joined()
        let encryptedResult = try ffiMobileContentSeal(shape: .fileKey, plaintextHex: dataHex)
        let fileKeyHex = encryptedResult[1]
        guard let encryptedData = hexToData(encryptedResult[0]) else {
            throw CryptoServiceError.encryptionFailed("Failed to convert encrypted content to Data")
        }

        var keyEnvelopes: [(pubkey: String, enc: String, ct: String)] = []
        var metaEnvelopes: [(pubkey: String, encryptedContent: String, enc: String, ct: String)] = []
        for pubkey in recipientPubkeys {
            let keyWrap = try ffiMobileShapeSeal(shape: .fileKey, recipientPubkeyHex: pubkey, aadFields: [], plaintextHex: fileKeyHex)
            keyEnvelopes.append((pubkey: pubkey, enc: keyWrap.enc, ct: keyWrap.ct))

            let metaEncResult = try ffiMobileContentSeal(shape: .fileMetadataKey, plaintextHex: metadataHex)
            let metaWrap = try ffiMobileShapeSeal(shape: .fileMetadataKey, recipientPubkeyHex: pubkey, aadFields: [], plaintextHex: metaEncResult[1])
            metaEnvelopes.append((pubkey: pubkey, encryptedContent: metaEncResult[0], enc: metaWrap.enc, ct: metaWrap.ct))
        }

        return (encryptedData, keyEnvelopes, metaEnvelopes)
    }

    /// Decrypt a file's symmetric key from an HPKE envelope.
    func decryptFileKey(envelope: HpkeEnvelope) throws -> String {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        return try ffiMobileShapeOpen(shape: .fileKey, aadFields: [], envelope: envelope)
    }

    /// Decrypt file metadata from an HPKE envelope.
    func decryptFileMetadata(
        encryptedContentHex: String,
        envelope: HpkeEnvelope
    ) throws -> (originalName: String, mimeType: String, size: Int, checksum: String)? {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        let plaintextHex = try ffiMobileOpenSealedContent(shape: .fileMetadataKey, ciphertextHex: encryptedContentHex, envelope: envelope)
        guard let data = hexToData(plaintextHex),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        let originalName = dict["originalName"] as? String ?? "unknown"
        let mimeType = dict["mimeType"] as? String ?? "application/octet-stream"
        let size = dict["size"] as? Int ?? 0
        let checksum = dict["checksum"] as? String ?? ""
        return (originalName, mimeType, size, checksum)
    }

    /// Decrypt file content using a previously-unwrapped file key.
    func decryptFileContent(encryptedContentHex: String, fileKeyHex: String) throws -> Data {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        let plaintextHex = try ffiMobileContentOpen(shape: .fileKey, ciphertextHex: encryptedContentHex, keyHex: fileKeyHex)
        guard let data = hexToData(plaintextHex) else {
            throw CryptoServiceError.decryptionFailed("Failed to convert decrypted hex to Data")
        }
        return data
    }

    // MARK: - Draft Encryption (hub-key-based)

    /// Encrypt a draft note using the hub key stored in Rust.
    /// The hub key never leaves Rust memory.
    func encryptDraft(plaintext: String, hubId: String) throws -> String {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        return try ffiMobileEncryptDraft(plaintext: plaintext, hubId: hubId)
    }

    /// Decrypt a draft note using the hub key stored in Rust.
    /// The hub key never leaves Rust memory.
    func decryptDraft(packedHex: String, hubId: String) throws -> String {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        return try ffiMobileDecryptDraft(packedHex: packedHex, hubId: hubId)
    }

    // MARK: - Hex Utility

    private func sha256Hex(_ data: Data) -> String {
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private func hexToData(_ hex: String) -> Data? {
        var data = Data(capacity: hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let nextIndex = hex.index(index, offsetBy: 2)
            guard nextIndex <= hex.endIndex, let byte = UInt8(hex[index..<nextIndex], radix: 16) else { return nil }
            data.append(byte)
            index = nextIndex
        }
        return data
    }

    // MARK: - Test Support

    #if DEBUG
    /// Store a hub key directly in Rust for testing (bypasses FFI envelope decryption).
    func storeHubKeyForTesting(hubId: String, keyHex: String) {
        try? ffiMobileSetHubKey(hubId: hubId, keyHex: keyHex)
    }

    func setMockIdentity() {
        let pin = ProcessInfo.processInfo.environment["XCTEST_MOCK_PIN"] ?? "12345678"
        let deviceId = "xctest-device-\(UUID().uuidString)"
        do { _ = try generateDeviceKeys(deviceId: deviceId, pin: pin) } catch {}
    }

    func setMockVolunteerIdentity() {
        let deviceId = "xctest-volunteer-\(UUID().uuidString)"
        do { _ = try generateDeviceKeys(deviceId: deviceId, pin: "65432100") } catch {}
    }
    #endif
}
