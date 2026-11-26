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
    case .SigchainRejected(let message):
        // A flat error: the closed code is carried as `sigchain rejected (<code>): …`.
        if let open = message.range(of: "sigchain rejected ("),
           let close = message[open.upperBound...].firstIndex(of: ")") {
            return String(message[open.upperBound..<close])
        }
        return "invalid_input"
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
