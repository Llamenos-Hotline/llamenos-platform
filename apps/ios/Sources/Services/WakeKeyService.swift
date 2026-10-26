import Foundation
import os
import Security

// MARK: - WakeKeyError

enum WakeKeyError: LocalizedError {
    case keyGenerationFailed
    case keyStorageFailed(OSStatus)
    case keyRetrievalFailed(OSStatus)
    case noPrivateKey
    case decryptionFailed(String)
    case registrationFailed(String)
    /// The server refused the registration body itself (400/422). Retrying the same
    /// body cannot succeed, so the retry loop stops and the error stays surfaced.
    case registrationRejected(String)
    /// Registration was attempted while the device keys are locked. The request
    /// would go out unsigned and be refused with a 401, so it is never sent.
    case deviceLocked
    /// The unlocked device state carries no usable Ed25519/X25519 public key. A
    /// registration with empty keys is stored by the server and then sealed to
    /// nothing, so it is refused here rather than sent.
    case deviceKeysUnavailable

    var errorDescription: String? {
        switch self {
        case .keyGenerationFailed:
            return NSLocalizedString("error_wake_key_generation", comment: "Failed to generate wake key")
        case .keyStorageFailed(let status):
            return "Wake key storage failed: \(status)"
        case .keyRetrievalFailed(let status):
            return "Wake key retrieval failed: \(status)"
        case .noPrivateKey:
            return NSLocalizedString("error_no_wake_key", comment: "No wake key found")
        case .decryptionFailed(let detail):
            return L10n.format("error_wake_decrypt_failed", comment: "Wake decrypt failed: %@", detail)
        case .registrationFailed(let detail), .registrationRejected(let detail):
            return L10n.format("error_wake_register_failed", comment: "Device registration failed: %@", detail)
        case .deviceLocked:
            return L10n.format("error_wake_register_failed", comment: "Device registration failed: %@", "device is locked")
        case .deviceKeysUnavailable:
            return L10n.format("error_wake_register_failed", comment: "Device registration failed: %@", "device keys unavailable")
        }
    }
}

// MARK: - WakeKeyService

/// Manages device-specific wake keypair for push notification encryption.
/// The wake key enables the notification service extension to decrypt push payloads
/// without requiring PIN unlock — critical for lock-screen call notifications.
///
/// V3: Uses HPKE (X25519) for push payload encryption instead of legacy ECIES.
/// The private key is stored in the Keychain with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`
/// and `kSecAttrSynchronizable: false` — it never leaves this device via iCloud Keychain.
///
/// Note: The Secure Enclave (kSecAttrTokenIDSecureEnclave) only supports P-256/P-384 keys.
/// X25519 wake keys cannot be stored in the Secure Enclave; device-only Keychain is used instead.
///
/// Flow:
/// 1. On first launch: `ensureKeypairExists()` generates and stores the wake key
/// 2. After every unlock, and again when the APNs token arrives: `registerDeviceIfUnlocked()`
///    sends the device's X25519/Ed25519 public keys (+ wake pubkey and token once known),
///    signed, and retries until the server accepts it
/// 3. On push receipt: notification service extension calls `decryptWakePayload()` to
///    decrypt the HPKE-encrypted notification content
///
/// `@MainActor` (#1920 audit): `registerDevice` ran on the global executor from
/// the push-token callback's `Task`, reading `publicKeyHex` and writing the registration state,
/// while `cleanup()` — logout and wipe, on main — cleared both. Every other caller (the
/// app delegate's push handlers, `AppState`, `WipeService`) already runs on main.
@MainActor
@Observable
final class WakeKeyService {

    // MARK: - Public State

    /// The wake public key in hex, available after `ensureKeypairExists()`.
    private(set) var publicKeyHex: String?

    /// Whether the wake keypair has been generated.
    var hasKeypair: Bool { publicKeyHex != nil }

    /// Whether the server has accepted this process's current registration. Derived from
    /// the last accepted body, never persisted: a stored flag would outlive the server
    /// row it describes (wipe, reinstall, key change) and read as registered when not.
    var isRegistered: Bool { registeredFingerprint != nil }

    /// The APNs token, once the system has delivered one. Held in memory only: the
    /// system re-delivers it at every launch, and it is needed again after each unlock.
    private(set) var pushToken: String?

    /// Why the last registration attempt failed, or nil once the server accepted one.
    /// Observed by the UI so a device that cannot be sent anything says so.
    private(set) var registrationError: String?

    // MARK: - Private Properties

    private let keychainService: KeychainService
    private let cryptoService: CryptoService
    private let apiService: APIService

    private static let wakePrivateKeyAccount = "wake-private-key"
    private static let wakePublicKeyAccount = "wake-public-key"

    private static let log = Logger(subsystem: "org.llamenos.hotline", category: "DeviceRegistration")

    /// Waits between failed registration attempts; the last one repeats. The endpoint
    /// sits in the server's `strict` rate-limit bucket (5/hour), so the first five
    /// attempts are spread over ~13 minutes and the tail is slow rather than a burst
    /// that locks the device out of registering at all.
    private let retryDelays: [Duration]

    /// The registration in flight or waiting to retry. Cancelled on lock and logout.
    private var registrationTask: Task<Void, Never>?

    /// Fingerprint of the last body the server accepted, so an unlock that changes
    /// nothing does not spend a request. A new key or token changes it and registers again.
    private var registeredFingerprint: String?

    // MARK: - Initialization

    init(
        keychainService: KeychainService,
        cryptoService: CryptoService,
        apiService: APIService,
        retryDelays: [Duration] = [.seconds(5), .seconds(30), .seconds(120), .seconds(600), .seconds(900)]
    ) {
        self.keychainService = keychainService
        self.cryptoService = cryptoService
        self.apiService = apiService
        self.retryDelays = retryDelays
        loadExistingKeys()
    }

    // MARK: - Key Management

    /// Load existing wake keys from Keychain if they exist.
    private func loadExistingKeys() {
        do {
            if let pubKeyData = try keychainService.retrieve(key: Self.wakePublicKeyAccount) {
                publicKeyHex = String(data: pubKeyData, encoding: .utf8)
            }
        } catch {
            publicKeyHex = nil
        }
    }

    /// Generate and store the wake keypair if it doesn't already exist.
    /// Uses random 32 bytes as an X25519 private key for HPKE decryption.
    /// This must be called early in the app lifecycle, before push token registration.
    func ensureKeypairExists() throws {
        // Migrate any legacy key stored with iCloud-syncable or wrong accessibility attributes.
        try migrateWakeKeyIfNeeded()

        if publicKeyHex != nil { return }

        // Generate 32 random bytes for the wake private key (X25519)
        var privateKeyBytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, 32, &privateKeyBytes)
        guard status == errSecSuccess else {
            throw WakeKeyError.keyGenerationFailed
        }

        let privateKeyHex = privateKeyBytes.map { String(format: "%02x", $0) }.joined()

        // Derive X25519 public key from private key
        let publicKey = try deriveX25519PublicKey(from: privateKeyHex)

        // Store private key with device-only, non-syncable attributes
        try storeWakePrivateKey(privateKeyHex)

        // Store public key normally
        if let pubData = publicKey.data(using: .utf8) {
            try keychainService.store(key: Self.wakePublicKeyAccount, data: pubData)
        }

        publicKeyHex = publicKey
    }

    /// Store the wake private key with device-only, non-syncable Keychain attributes (H8).
    ///
    /// Uses `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` — the key is never synced to iCloud
    /// Keychain and never migrates to a new device. `kSecAttrSynchronizable: false` is set
    /// explicitly as a defense-in-depth measure.
    ///
    /// Note: `kSecAttrTokenIDSecureEnclave` is intentionally omitted — the Secure Enclave only
    /// supports P-256/P-384 keys. X25519 wake keys must use the software Keychain.
    private func storeWakePrivateKey(_ privateKeyHex: String) throws {
        guard let data = privateKeyHex.data(using: .utf8) else {
            throw WakeKeyError.keyStorageFailed(errSecParam)
        }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "org.llamenos.hotline.wake",
            kSecAttrAccount as String: Self.wakePrivateKeyAccount,
            kSecValueData as String: data,
            // H8: WhenUnlockedThisDeviceOnly — never syncs to iCloud, never migrates to new device
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            // H8: Defense-in-depth — explicitly disable iCloud Keychain synchronization
            kSecAttrSynchronizable as String: kCFBooleanFalse!,
        ]

        // Delete any existing key first (including synced variants via kSecAttrSynchronizableAny)
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "org.llamenos.hotline.wake",
            kSecAttrAccount as String: Self.wakePrivateKeyAccount,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ]
        SecItemDelete(deleteQuery as CFDictionary)

        let addStatus = SecItemAdd(query as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw WakeKeyError.keyStorageFailed(addStatus)
        }
    }

    /// Migrate wake key from iCloud-syncable or wrong-accessibility storage to device-only.
    ///
    /// Older app versions stored the wake private key without explicit `kSecAttrSynchronizable`
    /// or with `kSecAttrAccessibleAfterFirstUnlock` (without `ThisDeviceOnly`), allowing iCloud
    /// Keychain to sync the key to other devices. This method detects such keys and re-stores
    /// them with the correct device-only attributes.
    private func migrateWakeKeyIfNeeded() throws {
        // Query for the key matching any sync state to detect legacy syncable items.
        let migrateQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "org.llamenos.hotline.wake",
            kSecAttrAccount as String: Self.wakePrivateKeyAccount,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(migrateQuery as CFDictionary, &result)

        // Nothing to migrate if not found
        guard status == errSecSuccess,
              let data = result as? Data,
              let privateKeyHex = String(data: data, encoding: .utf8) else {
            return
        }

        // Re-store with correct device-only, non-syncable attributes.
        // storeWakePrivateKey already deletes via kSecAttrSynchronizableAny before adding.
        try storeWakePrivateKey(privateKeyHex)
    }

    /// Retrieve the wake private key from Keychain.
    private func retrieveWakePrivateKey() throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "org.llamenos.hotline.wake",
            kSecAttrAccount as String: Self.wakePrivateKeyAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data,
              let hex = String(data: data, encoding: .utf8) else {
            throw WakeKeyError.keyRetrievalFailed(status)
        }
        return hex
    }

    // MARK: - Device Registration

    /// Record the APNs token and register it, if the device is unlocked. While locked
    /// the token is only held: the unlock hook registers it together with the keys.
    func updatePushToken(_ token: String) {
        pushToken = token
        registerDeviceIfUnlocked()
    }

    /// Start registering this device, signed, retrying until the server accepts it.
    ///
    /// A no-op while locked (an unsigned request is a guaranteed 401) and while an
    /// attempt is already running. Call it from every point the device becomes usable
    /// (unlock, onboarding) and whenever the push token changes.
    func registerDeviceIfUnlocked() {
        guard cryptoService.isUnlocked, registrationTask == nil else { return }
        registrationTask = Task { [weak self] in
            await self?.registerUntilAccepted()
            // A cancelled task was already replaced or cleared by cancelRegistration().
            if !Task.isCancelled { self?.registrationTask = nil }
        }
    }

    /// Stop any pending attempt. Called on lock and logout: the next unlock starts afresh.
    func cancelRegistration() {
        registrationTask?.cancel()
        registrationTask = nil
    }

    /// Whether a registration attempt (or a wait between two) is currently scheduled.
    var isRegistering: Bool { registrationTask != nil }

    private func registerUntilAccepted() async {
        var failures = 0
        while !Task.isCancelled {
            do {
                try await registerDevice()
                registrationError = nil
                // A token that arrived during the request changes the body: go again.
                guard let current = try? Self.fingerprint(of: registrationBody()),
                      current != registeredFingerprint else { return }
            } catch is CancellationError {
                return
            } catch WakeKeyError.deviceLocked {
                // Locked mid-flight; the next unlock registers.
                return
            } catch {
                registrationError = error.localizedDescription
                Self.log.error("Device registration failed: \(error.localizedDescription, privacy: .public)")
                if Self.isPermanent(error) { return }
                let delay = retryDelays.isEmpty ? .seconds(60) : retryDelays[min(failures, retryDelays.count - 1)]
                failures += 1
                do { try await Task.sleep(for: delay) } catch { return }
            }
        }
    }

    /// A body the server rejected as invalid will be rejected again; every other
    /// failure (network, 401 before the user row exists, 429, 5xx) can clear.
    private static func isPermanent(_ error: Error) -> Bool {
        if case WakeKeyError.registrationRejected = error { return true }
        return false
    }

    /// The body to register right now, built from the live device state.
    ///
    /// Always carries both public keys: identity is what the server seals to, and it
    /// must not depend on APNs having produced a token. The push fields ride along
    /// only once a token is known.
    func registrationBody() throws -> RegisterDeviceBody {
        guard cryptoService.isUnlocked else { throw WakeKeyError.deviceLocked }
        guard let signing = cryptoService.signingPubkeyHex, Self.isKeyHex(signing),
              let encryption = cryptoService.encryptionPubkeyHex, Self.isKeyHex(encryption) else {
            throw WakeKeyError.deviceKeysUnavailable
        }

        var wakePublicKey: String?
        if pushToken != nil {
            try ensureKeypairExists()
            guard let wake = publicKeyHex else { throw WakeKeyError.noPrivateKey }
            wakePublicKey = wake
        }

        let os = ProcessInfo.processInfo.operatingSystemVersion
        return RegisterDeviceBody(
            appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
            deviceModel: nil,
            deviceName: nil,
            ed25519Pubkey: signing,
            osVersion: "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)",
            platform: .ios,
            pushToken: pushToken,
            wakeKeyPublic: wakePublicKey,
            x25519Pubkey: encryption
        )
    }

    /// Register this device's keys (and push token, if known) with the server, signed.
    ///
    /// Throws when the device is locked or its keys are unavailable instead of sending
    /// a registration the server cannot use. Skips the request when the server already
    /// holds exactly this registration.
    func registerDevice() async throws {
        let body = try registrationBody()
        let fingerprint = try Self.fingerprint(of: body)
        if fingerprint == registeredFingerprint { return }

        do {
            try await apiService.request(method: "POST", path: "/api/devices/register", wireBody: body)
        } catch APIError.requestFailed(let statusCode, let responseBody) where statusCode == 400 || statusCode == 422 {
            throw WakeKeyError.registrationRejected("HTTP \(statusCode): \(responseBody)")
        } catch {
            throw WakeKeyError.registrationFailed(error.localizedDescription)
        }

        registeredFingerprint = fingerprint
    }

    private static func fingerprint(of body: RegisterDeviceBody) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return String(decoding: try encoder.encode(body), as: UTF8.self)
    }

    private static func isKeyHex(_ value: String) -> Bool {
        value.count == 64 && value.allSatisfy(\.isHexDigit)
    }

    // MARK: - Wake Payload Decryption

    /// Decrypt an HPKE-encrypted push notification payload using the wake private key.
    /// This is called by the notification service extension when a push arrives.
    ///
    /// The server encrypts the push payload using HPKE seal with the wake public key
    /// and the CryptoLabels.LABEL_PUSH_WAKE label. The payload is a JSON-encoded HpkeEnvelope.
    ///
    /// - Parameter envelopeJSON: JSON string of the HPKE envelope from the push payload.
    /// - Returns: The decrypted plaintext string (typically JSON).
    func decryptWakePayload(envelopeJSON: String) throws -> String {
        let privateKeyHex = try retrieveWakePrivateKey()

        guard let data = envelopeJSON.data(using: .utf8) else {
            throw WakeKeyError.decryptionFailed("Invalid JSON encoding")
        }

        let envelope = try JSONDecoder().decode(HpkeEnvelope.self, from: data)

        // Use the HPKE open function with the wake private key
        // Note: This calls into the Rust FFI which needs the wake private key directly,
        // not the device key state.
        let plaintextHex = try mobileHpkeOpen(
            envelope: envelope,
            expectedLabel: CryptoLabels.LABEL_PUSH_WAKE,
            aadHex: ""
        )

        guard let resultData = hexToData(plaintextHex),
              let result = String(data: resultData, encoding: .utf8) else {
            throw WakeKeyError.decryptionFailed("Invalid UTF-8 in decrypted payload")
        }
        return result
    }

    // MARK: - Key Derivation

    /// Derive an X25519 public key from a 32-byte private key hex string.
    /// Calls the Rust FFI `get_public_key` which uses x25519_dalek — not secp256k1.
    /// The wake private key is a random 32-byte X25519 scalar.
    private func deriveX25519PublicKey(from privateKeyHex: String) throws -> String {
        try getPublicKey(secretKeyHex: privateKeyHex)
    }

    // MARK: - Cleanup

    /// Remove wake keys and registration state. Called on logout.
    func cleanup() {
        // Use kSecAttrSynchronizableAny to delete both current and any legacy synced items.
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "org.llamenos.hotline.wake",
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ]
        SecItemDelete(deleteQuery as CFDictionary)
        keychainService.delete(key: Self.wakePublicKeyAccount)
        publicKeyHex = nil
        cancelRegistration()
        registeredFingerprint = nil
        registrationError = nil
    }

    // MARK: - Hex Utility

    private func hexToData(_ hex: String) -> Data? {
        var data = Data(capacity: hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let nextIndex = hex.index(index, offsetBy: 2)
            guard nextIndex <= hex.endIndex,
                  let byte = UInt8(hex[index..<nextIndex], radix: 16) else {
                return nil
            }
            data.append(byte)
            index = nextIndex
        }
        return data
    }
}
