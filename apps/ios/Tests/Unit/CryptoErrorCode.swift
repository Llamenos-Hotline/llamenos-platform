import Foundation
@testable import Llamenos

/// The closed rejection code of a crate error (`CryptoError::code` in Rust,
/// spec §6.1). Vector tests assert this code, never merely that something threw.
func cryptoErrorCode(_ error: Error) -> String {
    guard let crypto = error as? CryptoError else { return "not-a-crypto-error: \(error)" }
    switch crypto {
    case .InvalidFormat, .HexError, .InvalidCiphertext, .InvalidNonce,
         .InvalidEphemeralKey, .InvalidPublicKey, .InvalidSecretKey:
        return "invalid_format"
    case .DecryptionFailed:
        return "decryption_failed"
    case .InvalidIdentifier:
        return "invalid_id"
    case .NoEventKey:
        return "no_event_key"
    default:
        return "invalid_input"
    }
}

/// The code `body` fails with, or `"no-error"` when it succeeds.
func codeOfFailure(_ body: () throws -> Void) -> String {
    do {
        try body()
        return "no-error"
    } catch {
        return cryptoErrorCode(error)
    }
}
