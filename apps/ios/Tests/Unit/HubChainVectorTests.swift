import XCTest
@testable import Llamenos

/// `packages/crypto/tests/fixtures/v2/hub-chain.json` and `recovery.json` (#2963;
/// wire spec §6.2) through this app's production reader:
/// ``CryptoService/hubChainCall(requestJson:)`` over UniFFI, the call
/// ``HubChainService`` verifies every served chain with. Each positive yields the
/// crate's head and state hash; each negative — the forked pair, the revoked-admin
/// race, a server-substituted epoch pk, `migration: 1`, … — fails with its closed
/// rejection code, never merely an error.
final class HubChainVectorTests: XCTestCase {

    private func load(_ name: String) throws -> [String: Any] {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { dir.deleteLastPathComponent() }   // Unit, Tests, ios, apps, <repo>
        let url = dir.appendingPathComponent("packages/crypto/tests/fixtures/v2/\(name)")
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: try Data(contentsOf: url)) as? [String: Any])
    }

    private func json(_ object: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
    }

    /// The case's `HubChainInput` as a `verify` request.
    private func verifyRequest(_ f: [String: Any], _ c: [String: Any]) throws -> String {
        let chain = try XCTUnwrap(f["chain"] as? [Any])
        let prefix = try XCTUnwrap(c["prefix"] as? Int)
        let append = try XCTUnwrap(c["append"] as? [Any])
        var request: [String: Any] = [
            "op": "verify",
            "links": Array(chain.prefix(prefix)) + append,
            "userChains": f["userChains"] as Any,
        ]
        if let anchor = c["anchor"] { request["anchor"] = anchor }
        return try json(request)
    }

    func testHubChainPositivesYieldTheCratesHeadAndState() throws {
        let f = try load("hub-chain.json")
        let positives = try XCTUnwrap(f["positives"] as? [[String: Any]])
        XCTAssertEqual(positives.count, 14)
        for p in positives {
            let answer = try CryptoService().hubChainCall(requestJson: try verifyRequest(f, p))
            let verified = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(answer.utf8)) as? [String: Any])
            let expect = try XCTUnwrap(p["expect"] as? [String: Any])
            XCTAssertEqual(verified["stateHash"] as? String, expect["stateHash"] as? String, p["name"] as? String ?? "")
            XCTAssertEqual(
                (verified["head"] as? [String: Any])?["hash"] as? String,
                (expect["head"] as? [String: Any])?["hash"] as? String,
                p["name"] as? String ?? ""
            )
        }
    }

    func testHubChainNegativesFailWithTheirCode() throws {
        let f = try load("hub-chain.json")
        let negatives = try XCTUnwrap(f["negatives"] as? [[String: Any]])
        XCTAssertEqual(negatives.count, 19)
        for n in negatives {
            let request = try verifyRequest(f, n)
            XCTAssertEqual(
                codeOfFailure { _ = try CryptoService().hubChainCall(requestJson: request) },
                n["expect"] as? String,
                n["name"] as? String ?? ""
            )
        }
    }

    func testRecoveryVectorsOpenAndFailByCode() throws {
        let f = try load("recovery.json")
        func request(_ c: [String: Any]) throws -> String {
            try json([
                "op": "verifySigchain",
                "links": c["chain"] as Any,
                "userChains": f["userChains"] as Any,
                "hubChains": f["hubChains"] as Any,
                "hubAnchors": c["hubAnchors"] as Any,
            ])
        }
        for p in try XCTUnwrap(f["positives"] as? [[String: Any]]) {
            let answer = try CryptoService().hubChainCall(requestJson: try request(p))
            let state = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(answer.utf8)) as? [String: Any])
            XCTAssertEqual(
                state["activeDevicePubkeys"] as? [String],
                (p["expect"] as? [String: Any])?["activeDevicePubkeys"] as? [String]
            )
        }
        let negatives = try XCTUnwrap(f["negatives"] as? [[String: Any]])
        XCTAssertEqual(negatives.count, 8)
        for n in negatives {
            let r = try request(n)
            XCTAssertEqual(codeOfFailure { _ = try CryptoService().hubChainCall(requestJson: r) }, n["expect"] as? String, n["name"] as? String ?? "")
        }
    }
}
