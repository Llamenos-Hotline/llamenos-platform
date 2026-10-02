import Foundation
import Security

// MARK: - WakeKeyError

enum WakeKeyError: LocalizedError {
    case keyGenerationFailed
    case keyStorageFailed(OSStatus)
    case keyRetrievalFailed(OSStatus)
    case noPrivateKey
    case decryptionFailed(String)
    case registrationFailed(String)

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
        case .registrationFailed(let detail):
            return L10n.format("error_wake_register_failed", comment: "Device registration failed: %@", detail)
        }
    }
}

// MARK: - DeviceRegistrationRequest

/// Request body for `POST /api/devices/register`.
struct DeviceRegistrationRequest: Encodable, Sendable {
    let pushToken: String
    let wakeKeyPublic: String
    let platform: String
    let deviceId: String
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
/// 2. On push token receipt: `registerDevice(pushToken:)` sends wake pubkey + token to server
/// 3. On push receipt: notification service extension calls `decryptWakePayload()` to
///    decrypt the HPKE-encrypted notification content
@Observable
final class WakeKeyService: @unchecked Sendable {

    // MARK: - Public State

    /// The wake public key in hex, available after `ensureKeypairExists()`.
    private(set) var publicKeyHex: String?

    /// Whether the wake keypair has been generated.
    var hasKeypair: Bool { publicKeyHex != nil }

    /// Whether the device is registered with the server.
    private(set) var isRegistered: Bool = false

    // MARK: - Private Properties

    private let keychainService: KeychainService
    private let cryptoService: CryptoService
    private let apiService: APIService

    private static let wakePrivateKeyAccount = "wake-private-key"
    private static let wakePublicKeyAccount = "wake-public-key"
    private static let deviceRegisteredAccount = "device-registered"

    // MARK: - Initialization

    init(keychainService: KeychainService, cryptoService: CryptoService, apiService: APIService) {
        self.keychainService = keychainService
        self.cryptoService = cryptoService
        self.apiService = apiService
        loadExistingKeys()
    }

    // MARK: - Key Management

    /// Load existing wake keys from Keychain if they exist.
    private func loadExistingKeys() {
        do {
            if let pubKeyData = try keychainService.retrieve(key: Self.wakePublicKeyAccount) {
                publicKeyHex = String(data: pubKeyData, encoding: .utf8)
            }
            if let regData = try keychainService.retrieve(key: Self.deviceRegisteredAccount) {
                isRegistered = regData.first == 1
            }
        } catch {
            publicKeyHex = nil
            isRegistered = false
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

    /// Register this device's push token and wake public key with the server.
    func registerDevice(pushToken: String) async throws {
        guard let wakePublicKey = publicKeyHex else {
            throw WakeKeyError.noPrivateKey
        }

        // Get or generate device ID
        let deviceId: String
        if let existingId = try keychainService.retrieveString(key: KeychainKey.deviceID) {
            deviceId = existingId
        } else {
            deviceId = UUID().uuidString
            try keychainService.storeString(deviceId, key: KeychainKey.deviceID)
        }

        let request = DeviceRegistrationRequest(
            pushToken: pushToken,
            wakeKeyPublic: wakePublicKey,
            platform: "ios",
            deviceId: deviceId
        )

        do {
            try await apiService.request(method: "POST", path: "/api/devices/register", body: request)
            let regData = Data([1])
            try keychainService.store(key: Self.deviceRegisteredAccount, data: regData)
            isRegistered = true
        } catch {
            throw WakeKeyError.registrationFailed(error.localizedDescription)
        }
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
        keychainService.delete(key: Self.deviceRegisteredAccount)
        publicKeyHex = nil
        isRegistered = false
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
