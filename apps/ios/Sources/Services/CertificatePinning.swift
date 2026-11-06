import CommonCrypto
import Foundation
import Security

// MARK: - Certificate Pinning (H14, #2159, #2160)
//
// A pin is base64(SHA-256(DER SubjectPublicKeyInfo)) — the RFC 7469 definition, the
// format OkHttp's `CertificatePinner` and Android's `<pin-set>` use, and what
// `openssl x509 -pubkey | openssl pkey -pubin -outform der | openssl dgst -sha256`
// produces. iOS has no API that returns a certificate's SPKI:
// `SecKeyCopyExternalRepresentation` returns PKCS#1 `RSAPublicKey` for RSA keys and the
// ANSI X9.63 point for EC keys, so hashing it can never equal an SPKI pin (#2159).
// The SPKI is therefore read straight out of the certificate's DER, byte for byte.

/// The certificate pins every non-loopback connection is held to.
///
/// The pins are Let's Encrypt's four ROOTS — ISRG Root X1, X2 and the Generation-Y roots
/// YR, YE — not an intermediate or the leaf: Caddy on the origin host terminates TLS with
/// a Let's Encrypt certificate and `acme_ca` has no fallback issuer, so every valid chain
/// for a deployment leads to one of these roots, and routine leaf/intermediate rotation
/// never breaks the pin. A CDN or proxy in front of the host presents its own chain and is
/// refused — deliberately.
///
/// Why four (#2505): since 2026-05-13 Let's Encrypt issues under Root YR / Root YE, served
/// cross-signed by X1 / X2. Apple's trust store anchors X1 / X2 only, so today the
/// evaluated chain still ends there. The day a trust store adds YR / YE, path building
/// stops at them, X1 / X2 are no longer on the chain, and a client that pinned only X1 / X2
/// would refuse every connection with no in-app remedy — and this set is immutable, so the
/// fix has to ship before then. A chain carrying ANY pinned key is accepted.
///
/// These are the same hashes Android pins (`network_security_config.xml` and
/// `ApiService.DEFAULT_PIN_HASHES`) and desktop pins (`ISRG_ROOT_PINS` in `cert_pin.rs`).
/// Change all platforms together.
///
/// The set is immutable: there is no runtime pin update on iOS, so there is no code path
/// that can empty it and turn pinning off.
enum CertificatePins {

    /// ISRG Root X1 (RSA 4096). Every pin below is derived from the certificate Let's
    /// Encrypt publishes — never copied from a page — and re-derived by
    /// `CertificatePinningTests` from the fixtures. Regenerate with:
    ///   curl -s https://letsencrypt.org/certs/isrgrootx1.pem \
    ///     | openssl x509 -pubkey -noout | openssl pkey -pubin -outform der \
    ///     | openssl dgst -sha256 -binary | base64
    static let isrgRootX1Hash = "C5+lpZ7tcVwmwQIMcRtPbsQtWLABXhQzejna0wHFr8M="

    /// ISRG Root X2 (ECDSA P-384). Same procedure against `isrg-root-x2.pem`.
    static let isrgRootX2Hash = "diGVwiVYbubAI3RW4hB9xU8e/CH2GnkuvVFZE8zmgzI="

    /// ISRG Root YR (RSA 4096). Same procedure against `gen-y/root-yr.pem`; the copy
    /// cross-signed by X1 (`gen-y/root-yr-by-x1.pem`) carries the same key, so one pin
    /// matches the root in both forms.
    static let isrgRootYRHash = "fk6IOKit1ild5647BH06ujSIq5XbCgqlbYl6ANhhi88="

    /// ISRG Root YE (ECDSA P-384). Same procedure against `gen-y/root-ye.pem`; the copy
    /// cross-signed by X2 carries the same key.
    static let isrgRootYEHash = "sCkq5UWXjg+7mKu9lMhhYF5bGLsy7VI/UNW3tccdR7w="

    /// Four independent roots so any one can be retired without locking clients out
    /// (RFC 7469 §2.5).
    static let pinned: Set<String> = [isrgRootX1Hash, isrgRootX2Hash, isrgRootYRHash, isrgRootYEHash]
}

/// Reads a certificate's SubjectPublicKeyInfo and computes its pin.
enum SubjectPublicKeyInfo {

    /// base64(SHA-256(SPKI DER)) of `certificate`, or nil if its DER cannot be parsed.
    static func pin(of certificate: SecCertificate) -> String? {
        guard let spki = der(ofCertificateDER: SecCertificateCopyData(certificate) as Data) else {
            return nil
        }
        return sha256Base64(spki)
    }

    /// The SubjectPublicKeyInfo element of an X.509 certificate, exactly as it is encoded
    /// in the certificate (tag and length included).
    ///
    /// RFC 5280 §4.1:
    ///   Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }
    ///   TBSCertificate ::= SEQUENCE {
    ///     version [0] EXPLICIT OPTIONAL, serialNumber INTEGER, signature AlgorithmIdentifier,
    ///     issuer Name, validity Validity, subject Name, subjectPublicKeyInfo SEQUENCE, ... }
    static func der(ofCertificateDER certificate: Data) -> Data? {
        let bytes = [UInt8](certificate)
        var outer = DERReader(bytes: bytes, range: 0..<bytes.count)
        guard let cert = outer.next(), cert.tag == DERReader.sequence, cert.end == bytes.count else {
            return nil
        }
        var certBody = DERReader(bytes: bytes, range: cert.content)
        guard let tbs = certBody.next(), tbs.tag == DERReader.sequence else { return nil }

        var fields = DERReader(bytes: bytes, range: tbs.content)
        guard var field = fields.next() else { return nil }
        if field.tag == DERReader.explicitVersion {
            guard let next = fields.next() else { return nil }
            field = next
        }
        guard field.tag == DERReader.integer else { return nil } // serialNumber
        // signature, issuer, validity, subject — all SEQUENCEs.
        for _ in 0..<4 {
            guard let skipped = fields.next(), skipped.tag == DERReader.sequence else { return nil }
        }
        guard let spki = fields.next(), spki.tag == DERReader.sequence else { return nil }
        return Data(bytes[spki.start..<spki.end])
    }

    static func sha256Base64(_ data: Data) -> String {
        var hash = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        data.withUnsafeBytes { buffer in
            _ = CC_SHA256(buffer.baseAddress, CC_LONG(data.count), &hash)
        }
        return Data(hash).base64EncodedString()
    }
}

/// Minimal, bounds-checked DER element walker — just enough to locate the SPKI.
private struct DERReader {
    static let sequence: UInt8 = 0x30
    static let integer: UInt8 = 0x02
    static let explicitVersion: UInt8 = 0xA0

    struct Element {
        let tag: UInt8
        /// Offset of the tag byte.
        let start: Int
        /// The element's value bytes.
        let content: Range<Int>
        /// One past the last byte of the element.
        var end: Int { content.upperBound }
    }

    let bytes: [UInt8]
    private var offset: Int
    private let limit: Int

    init(bytes: [UInt8], range: Range<Int>) {
        self.bytes = bytes
        self.offset = range.lowerBound
        self.limit = range.upperBound
    }

    /// The next element, or nil at the end of the range or on malformed DER
    /// (indefinite length, high tag numbers, a length running past the range).
    mutating func next() -> Element? {
        let start = offset
        guard start + 2 <= limit else { return nil }
        let tag = bytes[start]
        guard tag & 0x1F != 0x1F else { return nil }
        var cursor = start + 1
        let first = bytes[cursor]
        cursor += 1
        let length: Int
        if first < 0x80 {
            length = Int(first)
        } else {
            let count = Int(first & 0x7F)
            guard count >= 1, count <= 4, cursor + count <= limit else { return nil }
            var value = 0
            for byte in bytes[cursor..<cursor + count] {
                value = (value << 8) | Int(byte)
            }
            cursor += count
            length = value
        }
        guard length <= limit - cursor else { return nil }
        offset = cursor + length
        return Element(tag: tag, start: start, content: cursor..<(cursor + length))
    }
}

/// Outcome of judging one server-trust challenge.
enum PinningDecision: Equatable {
    /// Loopback host: pinning does not apply, the system's default TLS handling does.
    case loopbackExempt
    /// The chain is valid for the host and a pinned key is on it.
    case accept
    /// The chain itself is not valid for the host (untrusted anchor, expired, wrong
    /// name, ...). Refused before any pin is looked at (#2160).
    case rejectUntrustedChain
    /// The chain is valid, but no certificate on it carries a pinned key — e.g. a CDN,
    /// a corporate proxy, or a mis-issued certificate from another public CA.
    case rejectPinMismatch(observed: [String])
}

enum CertificatePinValidator {

    /// Hosts exempt from pinning: a loopback connection never crosses the network, and
    /// local dev/test backends do not hold a Let's Encrypt certificate. They get the
    /// system's default TLS handling — not a pass. Same set `WebSocketService` treats as
    /// loopback for `ws://`.
    static func isLoopback(host: String) -> Bool {
        switch host.lowercased() {
        case "localhost", "127.0.0.1", "::1", "[::1]": return true
        default: return false
        }
    }

    /// Judge `trust` for a connection to `host`.
    ///
    /// Order matters (#2160): the chain is evaluated FIRST, with an SSL policy bound to
    /// `host`, and pins are checked only against the chain the evaluation built.
    /// Checking pins against an unevaluated chain would accept an attacker's self-signed
    /// leaf sent alongside a copy of the (public) ISRG root certificate.
    ///
    /// `SecTrustEvaluateWithError` may block on revocation/AIA fetches, so call this off
    /// the main thread (URLSession delegate queues already are).
    static func evaluate(
        _ trust: SecTrust,
        host: String,
        pins: Set<String> = CertificatePins.pinned
    ) -> PinningDecision {
        if isLoopback(host: host) { return .loopbackExempt }

        guard SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString)) == errSecSuccess,
              SecTrustEvaluateWithError(trust, nil),
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              !chain.isEmpty
        else {
            return .rejectUntrustedChain
        }

        var observed: [String] = []
        for certificate in chain {
            guard let pin = SubjectPublicKeyInfo.pin(of: certificate) else { continue }
            if pins.contains(pin) { return .accept }
            observed.append(pin)
        }
        return .rejectPinMismatch(observed: observed)
    }
}
