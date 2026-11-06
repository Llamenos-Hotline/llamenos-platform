import Security
import XCTest
@testable import Llamenos

/// Certificate pinning (#2159, #2160).
///
/// #2159: a pin is SHA-256 over the DER SubjectPublicKeyInfo. Hashing the bytes of
/// `SecKeyCopyExternalRepresentation` (PKCS#1 / X9.63) never equals an SPKI pin, so iOS
/// refused every real deployment.
///
/// #2160: the chain must be evaluated before pins are checked — a pinned key merely
/// appearing in what the server sent proves nothing.
///
/// These run against the simulator's real system trust store with real Let's Encrypt
/// certificates, evaluated at a fixed date; network fetches are disabled so the
/// outcome cannot depend on connectivity.
final class CertificatePinningTests: XCTestCase {

    private typealias F = CertificatePinningFixtures

    // MARK: - SPKI pin computation (#2159)

    func testISRGRootX1PinIsSPKIHash() throws {
        let root = try certificate(F.isrgRootX1)
        XCTAssertEqual(SubjectPublicKeyInfo.pin(of: root), CertificatePins.isrgRootX1Hash)
    }

    func testISRGRootX2PinIsSPKIHash() throws {
        let root = try certificate(F.isrgRootX2)
        XCTAssertEqual(SubjectPublicKeyInfo.pin(of: root), CertificatePins.isrgRootX2Hash)
    }

    /// The pre-fix computation, kept as a witness: hashing the external key
    /// representation of the very same roots does NOT produce the pins. If this ever
    /// started matching, the SPKI tests above would no longer be the thing proving
    /// correctness.
    func testRawKeyRepresentationHashNeverMatchesTheSPKIPins() throws {
        for der in [F.isrgRootX1, F.isrgRootX2] {
            let key = try XCTUnwrap(SecCertificateCopyKey(try certificate(der)))
            let raw = try XCTUnwrap(SecKeyCopyExternalRepresentation(key, nil) as Data?)
            XCTAssertFalse(CertificatePins.pinned.contains(SubjectPublicKeyInfo.sha256Base64(raw)))
        }
    }

    func testSPKIIsTheDERSequenceInsideTheCertificate() throws {
        let der = try XCTUnwrap(Data(base64Encoded: F.isrgRootX2))
        let spki = try XCTUnwrap(SubjectPublicKeyInfo.der(ofCertificateDER: der))
        XCTAssertEqual(spki.first, 0x30, "SPKI is a SEQUENCE")
        XCTAssertNotNil(der.range(of: spki), "SPKI bytes are taken verbatim from the certificate")
        // P-384 SPKI: 30 76 30 10 <ecPublicKey, secp384r1> 03 62 00 <97-byte point> = 120 bytes.
        XCTAssertEqual(spki.count, 120)
    }

    func testMalformedCertificateDERYieldsNoSPKI() throws {
        let der = try XCTUnwrap(Data(base64Encoded: F.isrgRootX1))
        XCTAssertNil(SubjectPublicKeyInfo.der(ofCertificateDER: Data()))
        XCTAssertNil(SubjectPublicKeyInfo.der(ofCertificateDER: der.prefix(200)), "truncated")
        XCTAssertNil(SubjectPublicKeyInfo.der(ofCertificateDER: der + Data([0x00])), "trailing bytes")
        XCTAssertNil(SubjectPublicKeyInfo.der(ofCertificateDER: Data([0x30, 0x84, 0xFF, 0xFF, 0xFF, 0xFF])))
        XCTAssertNil(SubjectPublicKeyInfo.der(ofCertificateDER: Data([0x30, 0x80, 0x00, 0x00])), "indefinite length")
    }

    // MARK: - Chain evaluation + pins (#2159, #2160)

    /// It actually connects: the chain a real Let's Encrypt host serves is evaluated by
    /// the system trust store up to ISRG Root X1, whose SPKI is pinned.
    func testRealLetsEncryptChainIsAccepted() throws {
        let trust = try serverTrust(F.letsEncryptChain)
        XCTAssertEqual(CertificatePinValidator.evaluate(trust, host: F.letsEncryptHost), .accept)
    }

    /// A chain that is valid but leads to none of the pinned keys — a CDN, a TLS-
    /// intercepting proxy, a certificate mis-issued by another public CA — is refused,
    /// and the observed pins are reported.
    func testValidChainWithoutAPinnedKeyIsRefused() throws {
        let trust = try serverTrust(F.letsEncryptChain)
        let otherPin = SubjectPublicKeyInfo.sha256Base64(Data("not an ISRG root".utf8))
        guard case .rejectPinMismatch(let observed) =
            CertificatePinValidator.evaluate(trust, host: F.letsEncryptHost, pins: [otherPin])
        else {
            return XCTFail("a valid chain with no pinned key must be refused as a pin mismatch")
        }
        XCTAssertTrue(observed.contains(CertificatePins.isrgRootX1Hash), "observed pins come from the evaluated chain")
    }

    /// An empty pin set refuses everything; it never means "pinning off".
    func testEmptyPinSetRefuses() throws {
        let trust = try serverTrust(F.letsEncryptChain)
        guard case .rejectPinMismatch = CertificatePinValidator.evaluate(trust, host: F.letsEncryptHost, pins: [])
        else { return XCTFail("an empty pin set must refuse, not pass") }
    }

    /// #2160: an attacker's self-signed leaf for the right host, sent together with the
    /// public ISRG Root X1 certificate. The pinned key is in the presented chain; the
    /// chain is not valid, so it must be refused.
    func testSelfSignedLeafWithAppendedPinnedRootIsRefused() throws {
        let trust = try serverTrust([F.selfSignedImpostorLeaf, F.isrgRootX1])
        XCTAssertEqual(CertificatePinValidator.evaluate(trust, host: F.letsEncryptHost), .rejectUntrustedChain)
    }

    /// Same attack, presenting the genuine Let's Encrypt intermediates after the forged leaf.
    func testSelfSignedLeafWithGenuineIntermediatesIsRefused() throws {
        let trust = try serverTrust([F.selfSignedImpostorLeaf] + F.letsEncryptChain.dropFirst() + [F.isrgRootX1])
        XCTAssertEqual(CertificatePinValidator.evaluate(trust, host: F.letsEncryptHost), .rejectUntrustedChain)
    }

    /// A genuine pinned chain presented for a different host name is refused: the
    /// evaluation is bound to the host being connected to.
    func testPinnedChainForAnotherHostIsRefused() throws {
        let trust = try serverTrust(F.letsEncryptChain)
        XCTAssertEqual(CertificatePinValidator.evaluate(trust, host: "api.example.org"), .rejectUntrustedChain)
    }

    func testExpiredChainIsRefused() throws {
        let trust = try serverTrust(F.letsEncryptChain, at: Date(timeIntervalSince1970: 1_893_456_000)) // 2030-01-01
        XCTAssertEqual(CertificatePinValidator.evaluate(trust, host: F.letsEncryptHost), .rejectUntrustedChain)
    }

    // MARK: - Loopback (explicit, not an accident)

    func testLoopbackHostsAreExemptAndGetDefaultHandling() throws {
        let trust = try serverTrust([F.selfSignedImpostorLeaf])
        for host in ["localhost", "LOCALHOST", "127.0.0.1", "::1", "[::1]"] {
            XCTAssertEqual(CertificatePinValidator.evaluate(trust, host: host), .loopbackExempt, host)
        }
    }

    func testHostsMerelyResemblingLoopbackArePinned() throws {
        let trust = try serverTrust(F.letsEncryptChain)
        for host in ["localhost.evil.example", "127.0.0.1.evil.example", "evil-localhost"] {
            XCTAssertEqual(CertificatePinValidator.evaluate(trust, host: host), .rejectUntrustedChain, host)
        }
    }

    // MARK: - Pin set

    func testPinSetIsTheTwoISRGRootsAndMatchesAndroid() {
        // Android pins the same two hashes (network_security_config.xml, ApiService.kt).
        XCTAssertEqual(
            CertificatePins.pinned,
            ["C5+lpZ7tcVwmwQIMcRtPbsQtWLABXhQzejna0wHFr8M=", "diGVwiVYbubAI3RW4hB9xU8e/CH2GnkuvVFZE8zmgzI="]
        )
    }

    // MARK: - Live handshake (opt-in)

    /// A real TLS handshake through `CertificatePinningDelegate` to Let's Encrypt's
    /// X1- and X2-rooted test hosts, plus a valid non-Let's-Encrypt host that must be
    /// refused. Needs the network, so it runs only with `LLAMENOS_LIVE_TLS=1`
    /// (`TEST_RUNNER_LLAMENOS_LIVE_TLS=1` through xcodebuild).
    func testLiveHandshakeThroughPinningDelegate() async throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["LLAMENOS_LIVE_TLS"] == "1",
            "live network test — set LLAMENOS_LIVE_TLS=1"
        )
        let delegate = CertificatePinningDelegate()
        let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
        defer { session.invalidateAndCancel() }

        for host in ["valid-isrgrootx1.letsencrypt.org", "valid-isrgrootx2.letsencrypt.org"] {
            let (_, response) = try await session.data(from: URL(string: "https://\(host)/")!)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, host)
        }
        do {
            _ = try await session.data(from: URL(string: "https://www.google.com/")!)
            XCTFail("a host outside the pinned roots must be refused")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .cancelled)
        }
    }

    // MARK: - Helpers

    private func certificate(_ base64: String) throws -> SecCertificate {
        let der = try XCTUnwrap(Data(base64Encoded: base64))
        return try XCTUnwrap(SecCertificateCreateWithData(nil, der as CFData))
    }

    /// A server trust as URLSession would hand it over: the presented certificates and an
    /// SSL policy, evaluated at `date` with network fetches disabled.
    private func serverTrust(
        _ chain: [String],
        at date: Date = CertificatePinningFixtures.letsEncryptChainVerifyDate
    ) throws -> SecTrust {
        let certificates = try chain.map(certificate)
        var trust: SecTrust?
        let status = SecTrustCreateWithCertificates(
            certificates as CFArray, SecPolicyCreateSSL(true, nil), &trust
        )
        XCTAssertEqual(status, errSecSuccess)
        let serverTrust = try XCTUnwrap(trust)
        XCTAssertEqual(SecTrustSetVerifyDate(serverTrust, date as CFDate), errSecSuccess)
        XCTAssertEqual(SecTrustSetNetworkFetchAllowed(serverTrust, false), errSecSuccess)
        return serverTrust
    }
}
