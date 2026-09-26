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

extension KeyEnvelope: Codable {
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
        case deviceId, signingPubkeyHex, encryptionPubkeyHex
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            deviceId: try container.decode(String.self, forKey: .deviceId),
            signingPubkeyHex: try container.decode(String.self, forKey: .signingPubkeyHex),
            encryptionPubkeyHex: try container.decode(String.self, forKey: .encryptionPubkeyHex)
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(deviceId, forKey: .deviceId)
        try container.encode(signingPubkeyHex, forKey: .signingPubkeyHex)
        try container.encode(encryptionPubkeyHex, forKey: .encryptionPubkeyHex)
    }
}

extension HpkeEnvelope: Codable {
    enum CodingKeys: String, CodingKey {
        case v, labelId, enc, ct
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            v: try container.decode(UInt8.self, forKey: .v),
            labelId: try container.decode(UInt8.self, forKey: .labelId),
            enc: try container.decode(String.self, forKey: .enc),
            ct: try container.decode(String.self, forKey: .ct)
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(v, forKey: .v)
        try container.encode(labelId, forKey: .labelId)
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

/// JSON shape packages/crypto `SigchainLink` (serde camelCase) — the input of
/// `mobile_sigchain_verify`. `prevHash` is encoded as `null` for the genesis link.
extension SigchainLink: Codable {
    enum CodingKeys: String, CodingKey {
        case id, seq, prevHash, entryHash, signerDeviceId, signerPubkey, signature, timestamp, payloadJson
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try container.decode(String.self, forKey: .id),
            seq: try container.decode(UInt64.self, forKey: .seq),
            prevHash: try container.decodeIfPresent(String.self, forKey: .prevHash),
            entryHash: try container.decode(String.self, forKey: .entryHash),
            signerDeviceId: try container.decode(String.self, forKey: .signerDeviceId),
            signerPubkey: try container.decode(String.self, forKey: .signerPubkey),
            signature: try container.decode(String.self, forKey: .signature),
            timestamp: try container.decode(String.self, forKey: .timestamp),
            payloadJson: try container.decode(String.self, forKey: .payloadJson)
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(seq, forKey: .seq)
        try container.encode(prevHash, forKey: .prevHash)
        try container.encode(entryHash, forKey: .entryHash)
        try container.encode(signerDeviceId, forKey: .signerDeviceId)
        try container.encode(signerPubkey, forKey: .signerPubkey)
        try container.encode(signature, forKey: .signature)
        try container.encode(timestamp, forKey: .timestamp)
        try container.encode(payloadJson, forKey: .payloadJson)
    }
}
