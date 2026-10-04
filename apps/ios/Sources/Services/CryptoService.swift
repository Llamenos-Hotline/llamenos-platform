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

// V3 HPKE (stateless seal, stateful open)
private func ffiMobileHpkeSeal(plaintextHex: String, recipientPubkeyHex: String, label: String, aadHex: String) throws -> HpkeEnvelope {
    try mobileHpkeSeal(plaintextHex: plaintextHex, recipientPubkeyHex: recipientPubkeyHex, label: label, aadHex: aadHex)
}

private func ffiMobileHpkeOpen(envelope: HpkeEnvelope, expectedLabel: String, aadHex: String) throws -> String {
    try mobileHpkeOpen(envelope: envelope, expectedLabel: expectedLabel, aadHex: aadHex)
}

private func ffiMobileHpkeSealKey(keyHex: String, recipientPubkeyHex: String, label: String, aadHex: String) throws -> HpkeEnvelope {
    try mobileHpkeSealKey(keyHex: keyHex, recipientPubkeyHex: recipientPubkeyHex, label: label, aadHex: aadHex)
}

private func ffiMobileHpkeOpenKey(envelope: HpkeEnvelope, expectedLabel: String, aadHex: String) throws -> String {
    try mobileHpkeOpenKey(envelope: envelope, expectedLabel: expectedLabel, aadHex: aadHex)
}

// V3 symmetric encryption (AES-256-GCM)
private func ffiMobileSymmetricEncrypt(plaintextHex: String) throws -> [String] {
    try mobileSymmetricEncrypt(plaintextHex: plaintextHex)
}

private func ffiMobileSymmetricDecrypt(ciphertextHex: String, keyHex: String) throws -> String {
    try mobileSymmetricDecrypt(ciphertextHex: ciphertextHex, keyHex: keyHex)
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

// Legacy functions still needed for device linking and server events
private func ffiComputeSharedXHex(ourSecretHex: String, theirPubkeyHex: String) throws -> String {
    try computeSharedXHex(ourSecretHex: ourSecretHex, theirPubkeyHex: theirPubkeyHex)
}

private func ffiDecryptWithSharedKeyHex(ciphertextHex: String, sharedXHex: String) throws -> String {
    try decryptWithSharedKeyHex(ciphertextHex: ciphertextHex, sharedXHex: sharedXHex)
}

private func ffiComputeSasCode(sharedXHex: String) throws -> String {
    try computeSasCode(sharedXHex: sharedXHex)
}

private func ffiDecryptServerEventHex(encryptedHex: String, keyHex: String) throws -> String {
    try decryptServerEventHex(encryptedHex: encryptedHex, keyHex: keyHex)
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

private func ffiMobileSetServerEventKeys(currentHex: String, previousHex: String?) throws {
    try mobileSetServerEventKeys(currentHex: currentHex, previousHex: previousHex)
}

private func ffiMobileDecryptHubEvent(ciphertextHex: String, hubId: String) throws -> String {
    try mobileDecryptHubEvent(ciphertextHex: ciphertextHex, hubId: hubId)
}

private func ffiMobileDecryptServerEvent(encryptedHex: String) throws -> String {
    try mobileDecryptServerEvent(encryptedHex: encryptedHex)
}

private func ffiMobileDecryptServerEventWithEpoch(encryptedHex: String, epoch: UInt64) throws -> String {
    try mobileDecryptServerEventWithEpoch(encryptedHex: encryptedHex, epoch: epoch)
}

private func ffiMobileDecryptEventWithAttribution(ciphertextHex: String) throws -> [String] {
    try mobileDecryptEventWithAttribution(ciphertextHex: ciphertextHex)
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
    var pubkey: String? { encryptionPubkeyHex }
    var isUnlocked: Bool { ffiMobileIsUnlocked() }
    var hasIdentity: Bool { signingPubkeyHex != nil }

    // MARK: - Device Key Generation

    func generateDeviceKeys(deviceId: String, pin: String) throws -> EncryptedDeviceKeys {
        guard ffiMobileIsValidPin(pin) else { throw CryptoServiceError.invalidPin }
        let encrypted = try ffiMobileGenerateAndLoad(deviceId: deviceId, pin: pin)
        self.signingPubkeyHex = encrypted.state.signingPubkeyHex
        self.encryptionPubkeyHex = encrypted.state.encryptionPubkeyHex
        self.deviceId = encrypted.state.deviceId
        return encrypted
    }

    // MARK: - Unlock / Lock

    func unlockWithPin(data: EncryptedDeviceKeys, pin: String) throws -> DeviceKeyState {
        let ds = try ffiMobileUnlock(data: data, pin: pin)
        self.signingPubkeyHex = ds.signingPubkeyHex
        self.encryptionPubkeyHex = ds.encryptionPubkeyHex
        self.deviceId = ds.deviceId
        return ds
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
        let result = try ffiMobileSymmetricEncrypt(plaintextHex: plaintextHex)
        let ciphertextHex = result[0]
        let keyHex = result[1]
        var envelopes: [(pubkey: String, envelope: HpkeEnvelope)] = []
        for pubkey in recipientPubkeys {
            let envelope = try ffiMobileHpkeSealKey(keyHex: keyHex, recipientPubkeyHex: pubkey, label: CryptoLabels.LABEL_NOTE_KEY, aadHex: "")
            envelopes.append((pubkey: pubkey, envelope: envelope))
        }
        return (ciphertextHex, envelopes)
    }

    // MARK: - Note Decryption (HPKE)

    func decryptNote(ciphertextHex: String, envelope: HpkeEnvelope) throws -> String {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        let keyHex = try ffiMobileHpkeOpenKey(envelope: envelope, expectedLabel: CryptoLabels.LABEL_NOTE_KEY, aadHex: "")
        let plaintextHex = try ffiMobileSymmetricDecrypt(ciphertextHex: ciphertextHex, keyHex: keyHex)
        guard let data = hexToData(plaintextHex), let result = String(data: data, encoding: .utf8) else {
            throw CryptoServiceError.decryptionFailed("Invalid UTF-8 in decrypted note")
        }
        return result
    }

    // MARK: - Message Encryption (HPKE)

    func encryptMessage(plaintext: String, readerPubkeys: [String]) throws -> (encryptedContent: String, envelopes: [RecipientEnvelope]) {
        guard let encPubkey = encryptionPubkeyHex else { throw CryptoServiceError.noKeyLoaded }
        let allReaders = Array(Set([encPubkey] + readerPubkeys))
        let plaintextHex = plaintext.data(using: .utf8)!.map { String(format: "%02x", $0) }.joined()
        let result = try ffiMobileSymmetricEncrypt(plaintextHex: plaintextHex)
        let ciphertextHex = result[0]
        let keyHex = result[1]
        var envelopes: [RecipientEnvelope] = []
        for pubkey in allReaders {
            let hpkeEnv = try ffiMobileHpkeSealKey(keyHex: keyHex, recipientPubkeyHex: pubkey, label: CryptoLabels.LABEL_MESSAGE, aadHex: "")
            envelopes.append(RecipientEnvelope(ct: hpkeEnv.ct, enc: hpkeEnv.enc, pubkey: pubkey))
        }
        return (ciphertextHex, envelopes)
    }

    // MARK: - Message Decryption (HPKE)

    func decryptMessage(encryptedContent: String, envelope: HpkeEnvelope) throws -> String {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        let keyHex = try ffiMobileHpkeOpenKey(envelope: envelope, expectedLabel: CryptoLabels.LABEL_MESSAGE, aadHex: "")
        let plaintextHex = try ffiMobileSymmetricDecrypt(ciphertextHex: encryptedContent, keyHex: keyHex)
        guard let data = hexToData(plaintextHex), let result = String(data: data, encoding: .utf8) else {
            throw CryptoServiceError.decryptionFailed("Invalid UTF-8 in decrypted message")
        }
        return result
    }

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
    ///   - label: Domain separation label (LABEL_CONTACT_PROFILE or LABEL_CONTACT_ID).
    /// - Returns: Ciphertext hex and per-reader envelopes with pubkey, enc, ct.
    func encryptContactData(jsonPayload: String, readerPubkeys: [String], label: String) throws -> (ciphertextHex: String, envelopes: [RecipientEnvelope]) {
        guard let encPubkey = encryptionPubkeyHex else { throw CryptoServiceError.noKeyLoaded }
        let allReaders = Array(Set([encPubkey] + readerPubkeys))
        let plaintextHex = jsonPayload.data(using: .utf8)!.map { String(format: "%02x", $0) }.joined()
        let result = try ffiMobileSymmetricEncrypt(plaintextHex: plaintextHex)
        let ciphertextHex = result[0]
        let keyHex = result[1]
        var envelopes: [RecipientEnvelope] = []
        for pubkey in allReaders {
            let hpkeEnv = try ffiMobileHpkeSealKey(keyHex: keyHex, recipientPubkeyHex: pubkey, label: label, aadHex: "")
            envelopes.append(RecipientEnvelope(ct: hpkeEnv.ct, enc: hpkeEnv.enc, pubkey: pubkey))
        }
        return (ciphertextHex, envelopes)
    }

    /// Decrypt contact data (summary or PII) using the device's HPKE key.
    ///
    /// - Parameters:
    ///   - ciphertextHex: The encrypted contact data.
    ///   - envelope: The HPKE envelope for this device.
    ///   - label: Domain separation label (LABEL_CONTACT_PROFILE or LABEL_CONTACT_ID).
    /// - Returns: Decrypted JSON string.
    func decryptContactData(ciphertextHex: String, envelope: HpkeEnvelope, label: String) throws -> String {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        let keyHex = try ffiMobileHpkeOpenKey(envelope: envelope, expectedLabel: label, aadHex: "")
        let plaintextHex = try ffiMobileSymmetricDecrypt(ciphertextHex: ciphertextHex, keyHex: keyHex)
        guard let data = hexToData(plaintextHex), let result = String(data: data, encoding: .utf8) else {
            throw CryptoServiceError.decryptionFailed("Invalid UTF-8 in decrypted contact data")
        }
        return result
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

    func unwrapPukSeed(envelope: HpkeEnvelope, aad: String) throws -> String {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        let aadHex = aad.data(using: .utf8)!.map { String(format: "%02x", $0) }.joined()
        return try ffiMobileHpkeOpenKey(envelope: envelope, expectedLabel: CryptoLabels.LABEL_PUK_WRAP_TO_DEVICE, aadHex: aadHex)
    }

    // MARK: - Sigchain Operations

    func createSigchainLink(id: String, seq: UInt64, prevHash: String?, timestamp: String, payloadJson: String) throws -> SigchainLink {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        return try ffiMobileSigchainCreateLink(id: id, seq: seq, prevHash: prevHash, timestamp: timestamp, payloadJson: payloadJson)
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

    // MARK: - Server Event Decryption (legacy — key passed explicitly)

    static func decryptServerEvent(encryptedHex: String, keyHex: String) -> String? {
        return try? ffiDecryptServerEventHex(encryptedHex: encryptedHex, keyHex: keyHex)
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
    func loadHubKey(hubId: String, envelope: HubKeyEnvelopeResponse) throws {
        guard !hasHubKey(hubId: hubId) else { return }
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        let hpkeEnvelope = HpkeEnvelope(v: 3, labelId: 0, enc: envelope.envelope.enc, ct: envelope.envelope.ct)
        let keyHex = try ffiMobileHpkeOpenKey(envelope: hpkeEnvelope, expectedLabel: CryptoLabels.LABEL_HUB_KEY_WRAP, aadHex: "")
        try ffiMobileSetHubKey(hubId: hubId, keyHex: keyHex)
    }

    /// Evict all hub keys from Rust memory. Called on lock and logout.
    func clearHubKeys() {
        ffiMobileClearHubKeys()
    }

    // MARK: - Hub Event Decryption

    /// Decrypt a hub-encrypted relay event payload in Rust (XChaCha20-Poly1305).
    /// Hub key is looked up by hub ID in Rust CryptoState — never touches Swift.
    func decryptHubEvent(ciphertextHex: String, hubId: String) -> String? {
        return try? ffiMobileDecryptHubEvent(ciphertextHex: ciphertextHex, hubId: hubId)
    }

    // MARK: - Server Event Keys

    /// Store server event encryption keys in Rust (current + optional previous for epoch rotation).
    func setServerEventKeys(currentHex: String, previousHex: String? = nil) throws {
        try ffiMobileSetServerEventKeys(currentHex: currentHex, previousHex: previousHex)
    }

    /// Decrypt a server-published event using stored server event keys in Rust.
    /// Tries current key first, falls back to previous key during epoch rotation.
    func decryptServerEventWithStoredKeys(encryptedHex: String) -> String? {
        return try? ffiMobileDecryptServerEvent(encryptedHex: encryptedHex)
    }

    /// Decrypt a server-published event using epoch-aware AAD and bucket-padding strip.
    /// Uses stored server event keys (current + previous) in Rust — no key in Swift.
    func decryptServerEvent(ciphertextHex: String, epoch: Int) -> String? {
        return try? ffiMobileDecryptServerEventWithEpoch(encryptedHex: ciphertextHex, epoch: UInt64(epoch))
    }

    /// Try to decrypt a relay event against all stored hub keys in Rust.
    /// Returns (hubId, decryptedJson) for the first key that succeeds, or nil.
    /// Keys never leave Rust memory during this operation.
    func decryptEventWithAttribution(ciphertextHex: String) -> (hubId: String, json: String)? {
        guard let result = try? ffiMobileDecryptEventWithAttribution(ciphertextHex: ciphertextHex),
              result.count == 2 else { return nil }
        return (hubId: result[0], json: result[1])
    }

    /// Store a server event key as a hub key for multi-hub key-trial attribution.
    /// The key goes directly to Rust CryptoState — never stored in Swift memory.
    func storeServerEventKey(hubId: String, keyHex: String) {
        try? ffiMobileSetHubKey(hubId: hubId, keyHex: keyHex)
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

    // MARK: - General HPKE Operations

    /// HPKE-seal arbitrary data to a recipient's public key with a domain label.
    func hpkeSeal(plaintextHex: String, recipientPubkeyHex: String, label: String, aadHex: String) throws -> HpkeEnvelope {
        try ffiMobileHpkeSeal(plaintextHex: plaintextHex, recipientPubkeyHex: recipientPubkeyHex, label: label, aadHex: aadHex)
    }

    /// HPKE-open an envelope using our device private key.
    func hpkeOpen(envelope: HpkeEnvelope, expectedLabel: String, aadHex: String) throws -> String {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        return try ffiMobileHpkeOpen(envelope: envelope, expectedLabel: expectedLabel, aadHex: aadHex)
    }

    /// HPKE-seal a symmetric key to a recipient's public key with a domain label.
    func hpkeSealKey(keyHex: String, recipientPubkeyHex: String, label: String, aadHex: String) throws -> HpkeEnvelope {
        try ffiMobileHpkeSealKey(keyHex: keyHex, recipientPubkeyHex: recipientPubkeyHex, label: label, aadHex: aadHex)
    }

    /// HPKE-open a key envelope using our device private key.
    func hpkeOpenKey(envelope: HpkeEnvelope, expectedLabel: String, aadHex: String) throws -> String {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        return try ffiMobileHpkeOpenKey(envelope: envelope, expectedLabel: expectedLabel, aadHex: aadHex)
    }

    // MARK: - Ed25519 Signing

    /// Sign a hex-encoded message using the device's Ed25519 signing key.
    func ed25519Sign(messageHex: String) throws -> String {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        return try ffiMobileSign(messageHex: messageHex)
    }

    // MARK: - Symmetric Encryption (AES-256-GCM)

    /// Encrypt data with a random AES-256-GCM key. Returns (ciphertextHex, keyHex).
    func symmetricEncrypt(plaintextHex: String) throws -> (ciphertextHex: String, keyHex: String) {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        let result = try ffiMobileSymmetricEncrypt(plaintextHex: plaintextHex)
        return (ciphertextHex: result[0], keyHex: result[1])
    }

    // MARK: - Recovery Group

    func recoveryGroupGenerateKeypair() -> RecoveryGroupKeypair {
        ffiMobileRecoveryGroupGenerateKeypair()
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
    /// Returns encrypted content, per-recipient key envelopes, and per-recipient metadata envelopes.
    func encryptFile(
        data: Data,
        fileName: String,
        mimeType: String,
        recipientPubkeys: [String]
    ) throws -> (
        encryptedData: Data,
        keyEnvelopes: [(pubkey: String, envelope: HpkeEnvelope)],
        metadataEnvelopes: [(pubkey: String, encryptedContent: String, envelope: HpkeEnvelope)]
    ) {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }

        // SHA-256 checksum of raw data
        let checksum = sha256Hex(data)

        // Build metadata JSON
        let metadata: [String: Any] = [
            "originalName": fileName,
            "mimeType": mimeType,
            "size": data.count,
            "checksum": checksum
        ]
        let metadataData = try JSONSerialization.data(withJSONObject: metadata)
        let metadataHex = metadataData.map { String(format: "%02x", $0) }.joined()

        // Random 32-byte file key
        let fileKeyHex = ffiMobileRandomBytesHex()

        // AES-GCM encrypt file content with file key
        let dataHex = data.map { String(format: "%02x", $0) }.joined()
        let encryptedResult = try ffiMobileSymmetricEncrypt(plaintextHex: dataHex)
        // symmetric_encrypt returns [ciphertextHex, randomKeyHex] — but we need to encrypt with our file key.
        // Use the dedicated key-based encrypt: encrypt dataHex with fileKeyHex via symmetric_decrypt's inverse.
        // Actually, mobile_symmetric_encrypt generates its own random key. We need to use the file key instead.
        // The pattern: generate a random key via symmetric_encrypt, then re-wrap that key via HPKE.
        // But for file encryption, the file key IS the random key. So we use the result directly.
        let encryptedContentHex = encryptedResult[0]
        let actualFileKeyHex = encryptedResult[1]
        guard let encryptedData = hexToData(encryptedContentHex) else {
            throw CryptoServiceError.encryptionFailed("Failed to convert encrypted content to Data")
        }

        // HPKE-wrap the file key for each recipient
        var keyEnvelopes: [(pubkey: String, envelope: HpkeEnvelope)] = []
        for pubkey in recipientPubkeys {
            let envelope = try ffiMobileHpkeSealKey(
                keyHex: actualFileKeyHex,
                recipientPubkeyHex: pubkey,
                label: CryptoLabels.LABEL_FILE_KEY,
                aadHex: ""
            )
            keyEnvelopes.append((pubkey: pubkey, envelope: envelope))
        }

        // Encrypt metadata for each recipient with LABEL_FILE_METADATA
        var metaEnvelopes: [(pubkey: String, encryptedContent: String, envelope: HpkeEnvelope)] = []
        for pubkey in recipientPubkeys {
            let metaEncResult = try ffiMobileSymmetricEncrypt(plaintextHex: metadataHex)
            let encMetaHex = metaEncResult[0]
            let metaKeyHex = metaEncResult[1]
            let envelope = try ffiMobileHpkeSealKey(
                keyHex: metaKeyHex,
                recipientPubkeyHex: pubkey,
                label: CryptoLabels.LABEL_FILE_METADATA,
                aadHex: ""
            )
            metaEnvelopes.append((pubkey: pubkey, encryptedContent: encMetaHex, envelope: envelope))
        }

        return (encryptedData, keyEnvelopes, metaEnvelopes)
    }

    /// Decrypt a file's symmetric key from an HPKE envelope.
    func decryptFileKey(envelope: HpkeEnvelope) throws -> String {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        return try ffiMobileHpkeOpenKey(
            envelope: envelope,
            expectedLabel: CryptoLabels.LABEL_FILE_KEY,
            aadHex: ""
        )
    }

    /// Decrypt file metadata from an HPKE envelope.
    func decryptFileMetadata(
        encryptedContentHex: String,
        envelope: HpkeEnvelope
    ) throws -> (originalName: String, mimeType: String, size: Int, checksum: String)? {
        guard isUnlocked else { throw CryptoServiceError.noKeyLoaded }
        let keyHex = try ffiMobileHpkeOpenKey(
            envelope: envelope,
            expectedLabel: CryptoLabels.LABEL_FILE_METADATA,
            aadHex: ""
        )
        let plaintextHex = try ffiMobileSymmetricDecrypt(ciphertextHex: encryptedContentHex, keyHex: keyHex)
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
        let plaintextHex = try ffiMobileSymmetricDecrypt(ciphertextHex: encryptedContentHex, keyHex: fileKeyHex)
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
