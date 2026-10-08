import Foundation
import XCTest
@testable import Llamenos

/// #1659 — the bytes `GET /api/telephony/sip-token` really returns, decoded through the
/// production decoder.
///
/// The pre-existing tests built `SipTokenResponse(username:domain:password:transport:expiry:)`
/// in Swift and handed it to `registerHubAccount`. That exercises the registration logic
/// perfectly and says nothing about whether the server's bytes can produce that value —
/// so they CONFIRMED a model that could not decode a single real response, rather than
/// catching it. In-app SIP registration was unreachable on every build.
///
/// These decode `apps/ios/Tests/Wire/sip-token-response.json`, whose payloads come from
/// calling `buildVolunteerSipParams` itself. `apps/worker/__tests__/unit/sip-token-wire-body.test.ts`
/// holds those same bytes to `sipTokenResponseSchema` and asserts every key this model
/// requires is a key the schema declares — and it runs on every PR, which (per #1584) an
/// iOS test does not.
final class SipTokenResponseDecodingTests: XCTestCase {

    /// The production decoder, not a re-created one.
    private let decoder = APIService.makeResponseDecoder()

    /// Shared with every other token test — see `SipTokenFixture`.
    private func payload(_ id: String) throws -> Data { try SipTokenFixture.bytes(id) }

    // MARK: - The regression

    func testARealSipTokenDecodes() throws {
        let token = try decoder.decode(SipTokenResponse.self, from: try payload("sipTokenWithTurn"))

        XCTAssertEqual(token.provider, "asterisk")
        XCTAssertEqual(token.sip.domain, "sip.hotline.example.org")
        XCTAssertEqual(token.sip.transport, "tls")
        // `vol_` + the first 16 hex characters of the volunteer's pubkey. The fixture's
        // is a repeated byte pattern, not a plausible-looking one: a realistic 16-hex-char
        // identity read right after the word `token` is what `gitleaks`' generic-api-key
        // rule matched on this line (4.32 bits/char, threshold 3.5).
        XCTAssertEqual(token.sip.username, "vol_abababababababab")
        XCTAssertFalse(token.sip.password.isEmpty)
        // Read, not hardcoded: the registrar provisions a matching PJSIP endpoint, and a
        // client that mandates a different algorithm cannot negotiate with it (#1188).
        XCTAssertEqual(token.sip.mediaEncryption, "dtls-srtp")
    }

    /// The whole point of #1657: the relay candidate has to reach the client.
    func testTheIssuedIceServersCarryATurnRelayWithCredentials() throws {
        let token = try decoder.decode(SipTokenResponse.self, from: try payload("sipTokenWithTurn"))

        XCTAssertEqual(token.sip.iceServers.count, 3)
        let relays = token.sip.iceServers.filter(\.isTurnRelay)
        XCTAssertEqual(relays.count, 2, "a UDP and a TCP relay entry")
        for relay in relays {
            XCTAssertEqual(relay.hostAndPort, "turn.hotline.example.org:3478")
            XCTAssertNotNil(relay.username)
            XCTAssertNotNil(relay.credential)
        }
        XCTAssertEqual(Set(relays.compactMap(\.turnTransport)), ["udp", "tcp"])

        // STUN needs no credential, and must not be mistaken for a relay.
        let stun = token.sip.iceServers.filter { $0.scheme == "stun" }
        XCTAssertEqual(stun.count, 1)
        XCTAssertFalse(stun[0].isTurnRelay)
        XCTAssertEqual(stun[0].hostAndPort, "turn.hotline.example.org:3478")
    }

    /// coturn's long-term-credential REST convention puts the expiry in the username, so
    /// the client can see it without the server sending an `expiry` field — which is why
    /// dropping the old required `expiry` loses nothing.
    func testTheTurnCredentialExpiryComesFromItsOwnUsername() throws {
        let token = try decoder.decode(SipTokenResponse.self, from: try payload("sipTokenWithTurn"))
        XCTAssertEqual(token.sip.turnCredentialExpiresAt, 1_767_229_200)

        let stunOnly = try decoder.decode(SipTokenResponse.self, from: try payload("sipTokenStunOnly"))
        XCTAssertNil(stunOnly.sip.turnCredentialExpiresAt, "no relay issued, so nothing expires")
    }

    func testTheTrustAnchorDecodesAndCarriesNoKeyMaterial() throws {
        let token = try decoder.decode(SipTokenResponse.self, from: try payload("sipTokenWithTurn"))
        let pem = try XCTUnwrap(token.sip.tlsTrustAnchorPem)
        XCTAssertTrue(pem.contains("-----BEGIN CERTIFICATE-----"))
        XCTAssertFalse(pem.contains("PRIVATE KEY"))
    }

    /// A deployed host with no `TURN_HOST`/`TURN_SECRET` and no published anchor — which
    /// is every Ansible-deployed host before #1657 was fixed. It must decode: a client
    /// that cannot read the degraded response cannot register at all, which is strictly
    /// worse than registering without a relay.
    func testAStunOnlyTokenWithNoAnchorStillDecodes() throws {
        let token = try decoder.decode(SipTokenResponse.self, from: try payload("sipTokenStunOnly"))

        XCTAssertNil(token.sip.tlsTrustAnchorPem, "absent means 'use the device trust store'")
        XCTAssertEqual(token.sip.iceServers.count, 1)
        XCTAssertTrue(token.sip.iceServers.allSatisfy { !$0.isTurnRelay })
    }

    /// `iceServers` is defaulted, not required: losing the whole credential because the
    /// list was omitted is a worse failure than registering with host candidates only.
    func testATokenWithNoIceServersKeyDecodesToAnEmptyList() throws {
        let data = Data(#"""
        {"provider":"asterisk","sip":{"domain":"d","transport":"tls","username":"u",
         "password":"p","mediaEncryption":"dtls-srtp"}}
        """#.utf8)
        let token = try decoder.decode(SipTokenResponse.self, from: data)
        XCTAssertEqual(token.sip.iceServers, [])
        XCTAssertNil(token.sip.turnCredentialExpiresAt)
    }

    // MARK: - The inverse: the old model must fail on the server's payload

    /// Guards the fix from being undone by a model that accepts either shape. If
    /// "it decodes" could be satisfied by tolerating the flat spelling, the next person
    /// to reintroduce it would see green.
    func testThePreFixModelThrowsOnTheServersPayload() throws {
        /// `SipTokenResponse` exactly as it was before this change —
        /// apps/ios/Sources/Services/LinphoneService.swift:40 on `origin/main`.
        struct LegacySipTokenResponse: Decodable {
            let username: String
            let domain: String
            let password: String
            let transport: String
            let expiry: Int
        }

        for id in ["sipTokenWithTurn", "sipTokenStunOnly"] {
            let data = try payload(id)
            XCTAssertThrowsError(
                try decoder.decode(LegacySipTokenResponse.self, from: data),
                """
                The pre-#1659 model required five flat fields. Four of them are nested \
                under `sip` and `expiry` is never sent, so decoding \(id) must throw — \
                otherwise this fix can be reverted without any test noticing.
                """
            ) { error in
                guard case DecodingError.keyNotFound(let key, _) = error else {
                    return XCTFail("expected keyNotFound, got \(error)")
                }
                XCTAssertTrue(
                    ["username", "domain", "password", "transport", "expiry"].contains(key.stringValue),
                    "unexpected missing key \(key.stringValue)"
                )
            }
        }
    }

    /// `expiry` is gone from the model, so a server that one day starts sending one is
    /// ignored rather than a decode failure. Pinned because the opposite — reinstating it
    /// as required — is the exact defect.
    func testAnUnexpectedExpiryKeyIsIgnoredRatherThanFatal() throws {
        var payload = try JSONSerialization.jsonObject(with: try payload("sipTokenStunOnly")) as! [String: Any]
        payload["expiry"] = 3600
        let data = try JSONSerialization.data(withJSONObject: payload)
        XCTAssertNoThrow(try decoder.decode(SipTokenResponse.self, from: data))
    }

    /// `.convertFromSnakeCase` is routinely mistaken for a safety net on this class of
    /// bug. It is not: it splits on underscores and cannot change a field's DEPTH.
    func testTheSnakeCaseStrategyCannotFlattenANestedResponse() throws {
        struct Flat: Decodable { let username: String }
        let nested = Data(#"{"sip":{"username":"vol_abc"}}"#.utf8)
        XCTAssertThrowsError(try decoder.decode(Flat.self, from: nested))
    }

    // MARK: - URI parsing (RFC 7064/7065 — not hierarchical, so URL mis-reads them)

    func testIceServerUriParsing() {
        let udp = SipIceServer(url: "turn:relay.example.org:3478?transport=udp", username: "1:u", credential: "c")
        XCTAssertEqual(udp.scheme, "turn")
        XCTAssertEqual(udp.hostAndPort, "relay.example.org:3478")
        XCTAssertEqual(udp.turnTransport, "udp")
        XCTAssertTrue(udp.isTurnRelay)

        // No ?transport= means UDP, and `turnTransport` says nil rather than guessing.
        let bare = SipIceServer(url: "turns:relay.example.org:5349", username: "1:u", credential: "c")
        XCTAssertEqual(bare.scheme, "turns")
        XCTAssertEqual(bare.hostAndPort, "relay.example.org:5349")
        XCTAssertNil(bare.turnTransport)
        XCTAssertTrue(bare.isTurnRelay)

        // An operator writing the (incorrect) hierarchical form is tolerated.
        XCTAssertEqual(SipIceServer(url: "stun://stun.example.org:3478").hostAndPort, "stun.example.org:3478")

        // A turn: URI missing either half of its credential is NOT a usable relay: the
        // allocation would be refused and the policy would advertise a relay that cannot
        // be allocated.
        XCTAssertFalse(SipIceServer(url: "turn:r.example.org:3478", username: "1:u").isTurnRelay)
        XCTAssertFalse(SipIceServer(url: "turn:r.example.org:3478", credential: "c").isTurnRelay)
        XCTAssertFalse(SipIceServer(url: "stun:r.example.org:3478", username: "1:u", credential: "c").isTurnRelay)
    }

    /// The password must not be reachable through a description — a crash report or log
    /// line carrying a live SIP credential is a credential leak.
    func testTheRedactedDescriptionHidesThePassword() throws {
        let token = try decoder.decode(SipTokenResponse.self, from: try payload("sipTokenWithTurn"))
        let text = token.sip.redactedDescription
        XCTAssertFalse(text.contains(token.sip.password))
        XCTAssertTrue(text.contains("<redacted>"))
        XCTAssertTrue(text.contains(token.sip.username), "the identity is not the secret")

        // And the TURN credential, which is a live secret for its lifetime, must not
        // reach a description either — the ICE list is interpolated into the one above.
        let relay = try XCTUnwrap(token.sip.iceServers.first(where: \.isTurnRelay))
        XCTAssertFalse(text.contains(try XCTUnwrap(relay.credential)))
        XCTAssertFalse("\(relay)".contains(try XCTUnwrap(relay.credential)))
    }
}
