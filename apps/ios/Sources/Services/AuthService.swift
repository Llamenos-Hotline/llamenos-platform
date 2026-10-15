import Foundation

// MARK: - AuthError

enum AuthError: LocalizedError {
    case noStoredKeys
    case pinMismatch
    case credentialTooShort
    case pinTooShort
    case pinTooLong
    case pinNotNumeric
    case biometricNotAvailable
    case hubURLRequired
    case identityAlreadyExists

    var errorDescription: String? {
        switch self {
        case .noStoredKeys:
            return NSLocalizedString("error_no_stored_keys", comment: "No stored keys found")
        case .pinMismatch:
            return NSLocalizedString("error_pin_mismatch", comment: "Credentials do not match")
        case .credentialTooShort:
            return NSLocalizedString("error_credential_too_short", comment: "PIN or passphrase must be at least 8 characters")
        case .pinTooShort:
            return NSLocalizedString("error_pin_too_short", comment: "PIN or passphrase must be at least 8 characters")
        case .pinTooLong:
            return NSLocalizedString("error_pin_too_long", comment: "PIN must be at most 8 digits")
        case .pinNotNumeric:
            return NSLocalizedString("error_pin_not_numeric", comment: "PIN must contain only digits")
        case .biometricNotAvailable:
            return NSLocalizedString("error_biometric_not_available", comment: "Biometric authentication is not available")
        case .hubURLRequired:
            return NSLocalizedString("error_hub_url_required", comment: "Hub URL is required")
        case .identityAlreadyExists:
            return NSLocalizedString("error_identity_exists", comment: "An identity already exists")
        }
    }
}

// MARK: - AuthService

/// Coordinates CryptoService and KeychainService to implement the full auth lifecycle:
/// device key generation, PIN-based encryption/storage, PIN unlock, and biometric
/// unlock. This is the single point of truth for auth state transitions.
///
/// ## V3 Device Key Model
/// Device keys (Ed25519 signing + X25519 encryption) are generated once per device.
/// The PIN encrypts the device key blob which is stored in the Keychain.
/// Secrets are held exclusively in Rust memory and never exposed to Swift.
@Observable
final class AuthService {
    let cryptoService: CryptoService
    let keychainService: KeychainService

    /// Whether encrypted device keys exist in the Keychain (user has completed onboarding).
    private(set) var hasStoredKeys: Bool = false

    /// Whether biometric unlock is enabled for this identity.
    private(set) var isBiometricEnabled: Bool = false

    /// The hub URL, if configured.
    private(set) var hubURL: String?

    init(cryptoService: CryptoService, keychainService: KeychainService) {
        self.cryptoService = cryptoService
        self.keychainService = keychainService
        loadPersistedState()
    }

    // MARK: - State Loading

    /// Load persisted auth state from Keychain on startup.
    private func loadPersistedState() {
        do {
            hasStoredKeys = try keychainService.retrieve(key: KeychainKey.encryptedKeys) != nil
            hubURL = try keychainService.retrieveString(key: KeychainKey.hubURL)
            if let biometricData = try keychainService.retrieve(key: KeychainKey.biometricEnabled) {
                isBiometricEnabled = biometricData.first == 1
            }
        } catch {
            // Keychain read failures on first launch are expected (no items yet).
            hasStoredKeys = false
            hubURL = nil
            isBiometricEnabled = false
        }
    }

    // MARK: - Hub URL

    /// Persist the hub URL for API connections.
    func setHubURL(_ url: String) throws {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw AuthError.hubURLRequired }
        try keychainService.storeString(trimmed, key: KeychainKey.hubURL)
        hubURL = trimmed
    }

    // MARK: - Onboarding (New Device Identity)

    /// Generate new device keys and persist them, protected by the user's PIN.
    /// In the v3 model, key generation and PIN encryption happen atomically —
    /// there is no separate "show device key" step. Device keys are non-exportable;
    /// multi-device support uses device linking via sigchain + PUK.
    ///
    /// Returns the DeviceKeyState (public keys) for display/registration.
    func createNewIdentity(pin: String, enableBiometric: Bool = false) throws -> DeviceKeyState {
        try validatePIN(pin)

        let deviceId = UUID().uuidString
        let encrypted = try cryptoService.generateDeviceKeys(deviceId: deviceId, pin: pin)

        // Persist the encrypted device key blob
        let jsonData = try JSONEncoder().encode(encrypted)
        try keychainService.store(key: KeychainKey.encryptedKeys, data: jsonData)

        // Store device ID for sigchain
        try keychainService.storeString(deviceId, key: KeychainKey.deviceID)

        // Store biometric preference
        let biometricByte: Data = enableBiometric ? Data([1]) : Data([0])
        try keychainService.store(key: KeychainKey.biometricEnabled, data: biometricByte)

        // Store PIN length for unlock screen
        keychainService.storePINLength(pin.count)

        if enableBiometric {
            try keychainService.storePINForBiometric(pin)
        }

        hasStoredKeys = true
        isBiometricEnabled = enableBiometric

        return encrypted.state
    }

    // MARK: - PIN Unlock

    /// Unlock the stored device identity using the user's PIN.
    /// Decrypts device keys from Keychain and loads them into Rust crypto state.
    func unlockWithPIN(_ pin: String) throws {
        guard let jsonData = try keychainService.retrieve(key: KeychainKey.encryptedKeys) else {
            throw AuthError.noStoredKeys
        }

        let encrypted = try JSONDecoder().decode(EncryptedDeviceKeys.self, from: jsonData)
        _ = try cryptoService.unlockWithPin(data: encrypted, pin: pin)
    }

    // MARK: - Biometric Unlock

    /// Enable or disable biometric unlock. When enabling, requires the current PIN
    /// to store it behind biometric-protected Keychain item (C5). When disabling,
    /// removes the biometric PIN.
    func setBiometricEnabled(_ enabled: Bool, pin: String? = nil) throws {
        let biometricByte: Data = enabled ? Data([1]) : Data([0])
        try keychainService.store(key: KeychainKey.biometricEnabled, data: biometricByte)
        isBiometricEnabled = enabled

        if enabled, let pin {
            try keychainService.storePINForBiometric(pin)
        } else if !enabled {
            keychainService.deleteBiometricPIN()
        }
    }

    // MARK: - Lock

    /// Lock the app by zeroizing device secrets in Rust memory.
    /// Public keys remain for display ("Locked as ...").
    func lock() {
        cryptoService.lock()
    }

    // MARK: - Logout / Reset

    /// Completely remove all stored identity data. This is destructive — the user
    /// must create a new identity afterwards (device linking is not offered, #1028).
    func logout() {
        cryptoService.lock()
        keychainService.delete(key: KeychainKey.encryptedKeys)
        keychainService.delete(key: KeychainKey.hubURL)
        keychainService.delete(key: KeychainKey.biometricEnabled)
        keychainService.delete(key: KeychainKey.deviceID)
        keychainService.deleteBiometricPIN()
        keychainService.clearLockoutState()
        keychainService.delete(key: KeychainKey.pinLength)
        hasStoredKeys = false
        isBiometricEnabled = false
        hubURL = nil
    }

    // MARK: - Credential Validation

    /// Validate credential format: numeric PIN (8+ digits) or alphanumeric passphrase (8+ chars with at least one letter).
    func validatePIN(_ credential: String) throws {
        guard credential.count >= 8 else { throw AuthError.credentialTooShort }
        // All digits = numeric PIN (valid)
        if credential.allSatisfy(\.isNumber) { return }
        // Alphanumeric passphrase: must contain at least one letter
        guard credential.contains(where: \.isLetter) else { throw AuthError.credentialTooShort }
    }

    /// Validate that two PINs match (for set/confirm flow).
    func validatePINConfirmation(_ pin: String, confirmation: String) throws {
        try validatePIN(pin)
        guard pin == confirmation else { throw AuthError.pinMismatch }
    }
}
