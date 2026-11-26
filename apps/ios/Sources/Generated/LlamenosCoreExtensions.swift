import Foundation

// MARK: - Codable Conformance for UniFFI-Generated Types
// UniFFI generates Equatable + Hashable but not Codable.
// These extensions are needed for JSON serialization (Keychain storage, API payloads).

extension EncryptedKeyData: Codable {
    enum CodingKeys: String, CodingKey {
        case salt, iterations, nonce, ciphertext, pubkey
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            salt: try container.decode(String.self, forKey: .salt),
            iterations: try container.decode(UInt32.self, forKey: .iterations),
            nonce: try container.decode(String.self, forKey: .nonce),
            ciphertext: try container.decode(String.self, forKey: .ciphertext),
            pubkey: try container.decode(String.self, forKey: .pubkey)
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(salt, forKey: .salt)
        try container.encode(iterations, forKey: .iterations)
        try container.encode(nonce, forKey: .nonce)
        try container.encode(ciphertext, forKey: .ciphertext)
        try container.encode(pubkey, forKey: .pubkey)
    }
}

extension RecipientKeyEnvelope: Codable {
    enum CodingKeys: String, CodingKey {
        case pubkey, enc, ct
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            pubkey: try container.decode(String.self, forKey: .pubkey),
            enc: try container.decode(String.self, forKey: .enc),
            ct: try container.decode(String.self, forKey: .ct)
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(pubkey, forKey: .pubkey)
        try container.encode(enc, forKey: .enc)
        try container.encode(ct, forKey: .ct)
    }
}

extension DeviceKeyState: Codable {
    enum CodingKeys: String, CodingKey {
        case deviceId, signingPubkeyHex, encryptionPubkeyHex, kemPubkeyHex
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            deviceId: try container.decode(String.self, forKey: .deviceId),
            signingPubkeyHex: try container.decode(String.self, forKey: .signingPubkeyHex),
            encryptionPubkeyHex: try container.decode(String.self, forKey: .encryptionPubkeyHex),
            // Absent in a pilot blob stored before X-Wing keys existed (#2496);
            // unlocking gives the device one.
            kemPubkeyHex: try container.decodeIfPresent(String.self, forKey: .kemPubkeyHex)
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(deviceId, forKey: .deviceId)
        try container.encode(signingPubkeyHex, forKey: .signingPubkeyHex)
        try container.encode(encryptionPubkeyHex, forKey: .encryptionPubkeyHex)
        try container.encodeIfPresent(kemPubkeyHex, forKey: .kemPubkeyHex)
    }
}

/// The one HPKE envelope (spec D1, D2): `{enc, ct}`, lowercase hex. No version
/// and no `labelId` — the label is the shape's, supplied by the crate.
extension HpkeEnvelope: Codable {
    enum CodingKeys: String, CodingKey {
        case enc, ct
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            enc: try container.decode(String.self, forKey: .enc),
            ct: try container.decode(String.self, forKey: .ct)
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(enc, forKey: .enc)
        try container.encode(ct, forKey: .ct)
    }
}

extension EncryptedDeviceKeys: Codable {
    enum CodingKeys: String, CodingKey {
        case kdfVersion, salt, argon2MCost, argon2TCost, argon2PCost, nonce, ciphertext, state
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            kdfVersion: try container.decode(UInt8.self, forKey: .kdfVersion),
            salt: try container.decode(String.self, forKey: .salt),
            argon2MCost: try container.decode(UInt32.self, forKey: .argon2MCost),
            argon2TCost: try container.decode(UInt32.self, forKey: .argon2TCost),
            argon2PCost: try container.decode(UInt32.self, forKey: .argon2PCost),
            nonce: try container.decode(String.self, forKey: .nonce),
            ciphertext: try container.decode(String.self, forKey: .ciphertext),
            state: try container.decode(DeviceKeyState.self, forKey: .state)
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kdfVersion, forKey: .kdfVersion)
        try container.encode(salt, forKey: .salt)
        try container.encode(argon2MCost, forKey: .argon2MCost)
        try container.encode(argon2TCost, forKey: .argon2TCost)
        try container.encode(argon2PCost, forKey: .argon2PCost)
        try container.encode(nonce, forKey: .nonce)
        try container.encode(ciphertext, forKey: .ciphertext)
        try container.encode(state, forKey: .state)
    }
}
