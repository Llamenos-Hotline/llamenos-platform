import Foundation
import LocalAuthentication
import Security

// MARK: - KeychainError

enum KeychainError: LocalizedError {
    case storeFailed(OSStatus)
    case updateFailed(OSStatus)
    case retrieveFailed(OSStatus)
    case encodingFailed
    case decodingFailed

    var errorDescription: String? {
        switch self {
        case .storeFailed(let status):
            return "Keychain store failed with status \(status)"
        case .updateFailed(let status):
            return "Keychain update failed with status \(status)"
        case .retrieveFailed(let status):
            return "Keychain retrieve failed with status \(status)"
        case .encodingFailed:
            return "Failed to encode data for Keychain storage"
        case .decodingFailed:
            return "Failed to decode data from Keychain"
        }
    }
}

// MARK: - Keychain Keys

/// Well-known Keychain account keys for Llamenos data.
enum KeychainKey {
    static let encryptedKeys = "encrypted-keys"
    static let hubURL = "hub-url"
    static let deviceID = "device-id"
    static let biometricEnabled = "biometric-enabled"
    static let pinHash = "pin-verification"
    static let biometricPIN = "biometric-pin"
    static let pinLength = "pin-length"
    static let pinLockoutAttempts = "pin-lockout-attempts"
    static let pinLockoutUntil = "pin-lockout-until"
    static let adminDecryptionPubkey = "admin-decryption-pubkey"
}

// MARK: - KeychainService

/// Secure storage backed by iOS Keychain Services. All items are scoped to the
/// `org.llamenos.hotline` service identifier and restricted to
/// `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` — they do not sync to iCloud
/// Keychain or migrate to new devices.
final class KeychainService: @unchecked Sendable {
    private let service = "org.llamenos.hotline"

    /// Store data in the Keychain. If an item with the same key already exists, it is updated.
    ///
    /// - Parameters:
    ///   - key: The account identifier for this item.
    ///   - data: The raw bytes to store.
    ///   - biometric: If true, the item requires biometric authentication (Face ID / Touch ID)
    ///     to retrieve. Uses `.biometryCurrentSet` so re-enrollment invalidates the item.
    func store(key: String, data: Data, biometric: Bool = false) throws {
        // Build base query
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecValueData as String: data,
        ]

        // Explicitly disable iCloud Keychain sync — all items are device-only.
        query[kSecAttrSynchronizable as String] = kCFBooleanFalse!

        if biometric {
            var error: Unmanaged<CFError>?
            guard let access = SecAccessControlCreateWithFlags(
                nil,
                kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                .biometryCurrentSet,
                &error
            ) else {
                throw KeychainError.storeFailed(errSecParam)
            }
            query[kSecAttrAccessControl as String] = access
        } else {
            query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        }

        let addStatus = SecItemAdd(query as CFDictionary, nil)

        if addStatus == errSecDuplicateItem {
            // Item exists — update it. Build a lookup query without the value or access control.
            let lookupQuery: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: key,
                kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
            ]

            var updateAttributes: [String: Any] = [
                kSecValueData as String: data,
                // Ensure synchronizable remains false on updates too.
                kSecAttrSynchronizable as String: kCFBooleanFalse!,
            ]

            // Re-apply access control on update if biometric is requested.
            if biometric {
                var error: Unmanaged<CFError>?
                if let access = SecAccessControlCreateWithFlags(
                    nil,
                    kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                    .biometryCurrentSet,
                    &error
                ) {
                    updateAttributes[kSecAttrAccessControl as String] = access
                }
            } else {
                updateAttributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            }

            let updateStatus = SecItemUpdate(lookupQuery as CFDictionary, updateAttributes as CFDictionary)
            guard updateStatus == errSecSuccess else {
                throw KeychainError.updateFailed(updateStatus)
            }
        } else if addStatus != errSecSuccess {
            throw KeychainError.storeFailed(addStatus)
        }
    }

    /// Retrieve data from the Keychain. Returns nil if no item exists for the given key.
    /// If the item was stored with biometric protection, the system will prompt for
    /// Face ID / Touch ID automatically.
    func retrieve(key: String) throws -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecItemNotFound {
            return nil
        }

        guard status == errSecSuccess else {
            throw KeychainError.retrieveFailed(status)
        }

        return result as? Data
    }

    /// Delete an item from the Keychain. No error if the item does not exist.
    func delete(key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }

    /// Destroy all Keychain items for this app. Called during device wipe sequence.
    func wipeAll() {
        let keys = [
            KeychainKey.encryptedKeys,
            KeychainKey.hubURL,
            KeychainKey.deviceID,
            KeychainKey.biometricEnabled,
            KeychainKey.pinHash,
            KeychainKey.biometricPIN,
            KeychainKey.pinLength,
            KeychainKey.pinLockoutAttempts,
            KeychainKey.pinLockoutUntil,
            KeychainKey.adminDecryptionPubkey,
        ]
        for key in keys {
            delete(key: key)
        }
    }

    /// Delete all items for this service. Used during account reset / logout.
    func deleteAll() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        SecItemDelete(query as CFDictionary)
    }

    // MARK: - Typed Convenience Methods

    /// Store a Codable value as JSON in the Keychain.
    func storeJSON<T: Encodable>(_ value: T, key: String, biometric: Bool = false) throws {
        let data = try JSONEncoder().encode(value)
        try store(key: key, data: data, biometric: biometric)
    }

    /// Retrieve and decode a JSON-encoded Codable value from the Keychain.
    func retrieveJSON<T: Decodable>(_ type: T.Type, key: String) throws -> T? {
        guard let data = try retrieve(key: key) else { return nil }
        return try JSONDecoder().decode(T.self, from: data)
    }

    // MARK: - Biometric PIN Storage (C5)

    /// Store a PIN behind biometric-protected Keychain item.
    /// The item requires Face ID / Touch ID to retrieve, using `.biometryCurrentSet`
    /// so re-enrollment invalidates the stored PIN (user must re-enter PIN after
    /// changing biometrics).
    func storePINForBiometric(_ pin: String) throws {
        guard let data = pin.data(using: .utf8) else {
            throw KeychainError.encodingFailed
        }
        try store(key: KeychainKey.biometricPIN, data: data, biometric: true)
    }

    /// Retrieve the PIN using a pre-authenticated LAContext (from biometric evaluation).
    ///
    /// Pass the `LAContext` returned after a successful `evaluatePolicy` call.
    /// Using `kSecUseAuthenticationContext` prevents the Keychain from triggering a
    /// second biometric challenge — the caller already authenticated.
    ///
    /// Returns nil if no biometric PIN is stored or the context is invalid.
    /// Throws on unexpected Keychain errors.
    func retrievePINWithBiometric(context: LAContext) throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: KeychainKey.biometricPIN,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecUseAuthenticationContext as String: context,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecItemNotFound || status == errSecUserCanceled || status == errSecAuthFailed {
            return nil
        }

        guard status == errSecSuccess, let data = result as? Data else {
            throw KeychainError.retrieveFailed(status)
        }

        return String(data: data, encoding: .utf8)
    }

    /// Remove the biometric PIN. Called when biometric unlock is disabled.
    func deleteBiometricPIN() {
        delete(key: KeychainKey.biometricPIN)
    }

    // MARK: - PIN Length Persistence

    /// Store the user's chosen PIN length (6 or 8) for unlock screen.
    func storePINLength(_ length: Int) {
        let data = withUnsafeBytes(of: length) { Data($0) }
        setKeychainItem(account: KeychainKey.pinLength, data: data)
    }

    /// Retrieve the stored PIN length. Returns 6 as default if not set.
    func getPINLength() -> Int {
        guard let data = getKeychainItem(account: KeychainKey.pinLength),
              data.count == MemoryLayout<Int>.size else { return 6 }
        // `loadUnaligned`, here and below: a small `Data` keeps its bytes inline with no
        // alignment guarantee, and `load(as:)` traps on a misaligned pointer. Thread
        // Sanitizer's allocator exposed it — `AuthLoginBDDTests` crashed with "load from
        // misaligned raw pointer" on every TSan run (#1920 audit).
        let length = data.withUnsafeBytes { $0.loadUnaligned(as: Int.self) }
        return (length == 6 || length == 8) ? length : 6
    }

    // MARK: - PIN Lockout Persistence (H7)

    /// Persist the PIN failed attempt count in the Keychain.
    func setLockoutAttempts(_ count: Int) {
        let data = withUnsafeBytes(of: count) { Data($0) }
        setKeychainItem(account: KeychainKey.pinLockoutAttempts, data: data)
    }

    /// Read the PIN failed attempt count from the Keychain. Returns 0 if not set.
    func getLockoutAttempts() -> Int {
        guard let data = getKeychainItem(account: KeychainKey.pinLockoutAttempts),
              data.count == MemoryLayout<Int>.size else { return 0 }
        return data.withUnsafeBytes { $0.loadUnaligned(as: Int.self) }
    }

    /// Persist the lockout expiry timestamp in the Keychain.
    func setLockoutUntil(_ date: Date) {
        let interval = date.timeIntervalSince1970
        let data = withUnsafeBytes(of: interval) { Data($0) }
        setKeychainItem(account: KeychainKey.pinLockoutUntil, data: data)
    }

    /// Read the lockout expiry timestamp from the Keychain. Returns `.distantPast` if not set.
    func getLockoutUntil() -> Date {
        guard let data = getKeychainItem(account: KeychainKey.pinLockoutUntil),
              data.count == MemoryLayout<Double>.size else { return .distantPast }
        let interval = data.withUnsafeBytes { $0.loadUnaligned(as: Double.self) }
        return Date(timeIntervalSince1970: interval)
    }

    /// Clear all lockout state. Called on successful PIN entry.
    func clearLockoutState() {
        delete(key: KeychainKey.pinLockoutAttempts)
        delete(key: KeychainKey.pinLockoutUntil)
    }

    // MARK: - Low-Level Keychain Helpers

    /// Write raw data to a Keychain item, creating or updating as needed.
    /// Uses default accessibility (WhenUnlockedThisDeviceOnly).
    private func setKeychainItem(account: String, data: Data) {
        // Try update first, then add
        do {
            try store(key: account, data: data)
        } catch {
            // Silently fail for lockout persistence — non-critical
        }
    }

    /// Read raw data from a Keychain item. Returns nil if not found.
    private func getKeychainItem(account: String) -> Data? {
        return try? retrieve(key: account)
    }

    /// Store a UTF-8 string in the Keychain.
    func storeString(_ value: String, key: String, biometric: Bool = false) throws {
        guard let data = value.data(using: .utf8) else {
            throw KeychainError.encodingFailed
        }
        try store(key: key, data: data, biometric: biometric)
    }

    /// Retrieve a UTF-8 string from the Keychain.
    func retrieveString(key: String) throws -> String? {
        guard let data = try retrieve(key: key) else { return nil }
        guard let string = String(data: data, encoding: .utf8) else {
            throw KeychainError.decodingFailed
        }
        return string
    }
}
