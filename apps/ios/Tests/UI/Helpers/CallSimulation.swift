import XCTest

/// Giving a UI test a real call to act on.
///
/// The dashboard presents the first active call its hub holds, whoever answered it, and a
/// call stays active until it is ended or goes stale — so a call left over from one test is
/// the card the next test in the class sees (#2027). A test that depends on call state
/// therefore runs on a hub of its own, and answers its call as the identity the app is
/// running as: the server authorises hang up, spam and ban on `answeredBy`.
extension BaseUITest {

    /// A call row as the server reports it from `GET /hubs/:hub/calls/active`.
    struct ServerCall {
        let id: String
        let status: String
        let answeredBy: String?
    }

    /// Create a hub just for this test and launch the app as a super-admin of it.
    /// Returns nil — after failing the test with the server's answer — when the hub
    /// could not be created.
    func launchAsAdminOnFreshHub(named prefix: String) -> String? {
        guard let hubId = TestAdminAPI.createHub(
            name: "\(prefix)-\(UUID().uuidString.prefix(8))", baseURL: testHubURL
        ) else { return nil }
        launchAsAdminWithAPI(hubId: hubId)
        return hubId
    }

    /// The calls the server holds as active for `hubId`, read through the real
    /// authenticated API — the same route the dashboard polls.
    func serverActiveCalls(hubId: String, file: StaticString = #filePath, line: UInt = #line) -> [ServerCall] {
        guard let data = TestAdminAPI.send(
            "GET", "/api/hubs/\(hubId)/calls/active", baseURL: testHubURL, file: file, line: line
        ) else { return [] } // send() already failed the test
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let calls = json["calls"] as? [[String: Any]] else {
            XCTFail("GET /api/hubs/\(hubId)/calls/active did not return { calls: [...] }", file: file, line: line)
            return []
        }
        return calls.compactMap { row in
            guard let id = row["id"] as? String else { return nil }
            return ServerCall(id: id, status: row["status"] as? String ?? "", answeredBy: row["answeredBy"] as? String)
        }
    }

    /// The signing pubkey the app is running as.
    func appIdentityPubkey(file: StaticString = #filePath, line: UInt = #line) -> String {
        let identity = find("dashboard-identity")
        XCTAssertTrue(
            identity.waitForExistence(timeout: 15), "The dashboard should expose the signed-in identity",
            file: file, line: line
        )
        let pubkey = identity.label
        XCTAssertEqual(
            pubkey.count, 64, "The dashboard identity should be a 32-byte hex pubkey, got '\(pubkey)'",
            file: file, line: line
        )
        return pubkey
    }

    /// Ring a call on `hubId` and return its id. Fails the test unless the server accepted it.
    func ringCall(callerNumber: String, hubId: String, file: StaticString = #filePath, line: UInt = #line) -> String {
        let call = simulateIncomingCall(callerNumber: callerNumber, hubId: hubId)
        XCTAssertFalse(
            call.callId.isEmpty, "The simulated incoming call should be created (status '\(call.status)')",
            file: file, line: line
        )
        XCTAssertEqual(call.status, "ringing", "A new call should be ringing", file: file, line: line)
        return call.callId
    }

    /// Ring a call on `hubId` and answer it as the app's own identity. Fails the test
    /// unless the server reports the call in progress, answered by the app.
    func answerCallAsApp(
        callerNumber: String, hubId: String, file: StaticString = #filePath, line: UInt = #line
    ) -> String {
        let pubkey = appIdentityPubkey(file: file, line: line)
        let callId = ringCall(callerNumber: callerNumber, hubId: hubId, file: file, line: line)
        let answered = simulateAnswerCall(callId: callId, pubkey: pubkey)
        XCTAssertEqual(
            answered, "in-progress", "The call should be in progress once the app's identity answers it",
            file: file, line: line
        )
        let held = serverActiveCalls(hubId: hubId, file: file, line: line).first { $0.id == callId }
        XCTAssertEqual(
            held?.answeredBy, pubkey, "The server should record the app's identity as the call's answerer",
            file: file, line: line
        )
        return callId
    }

    /// Wait for the dashboard's call card to leave the screen.
    func waitForCallCardToClear(timeout: TimeInterval = 20) -> Bool {
        let gone = NSPredicate(format: "exists == false")
        let expectation = XCTNSPredicateExpectation(predicate: gone, object: find("active-call-card"))
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }
}
