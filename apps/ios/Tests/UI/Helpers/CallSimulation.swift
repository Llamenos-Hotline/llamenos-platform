import XCTest

/// Giving a UI test a real call to act on.
///
/// A call stays active until it is ended or goes stale, and a hub's calls are listed to every
/// member — so a call left over from one test is state the next test in the class sees. A
/// test that depends on call state therefore runs on a hub of its own, and answers its call
/// as the identity the app is running as: the server authorises hang up, spam and ban on
/// `answeredBy`, and the dashboard shows the call card only for such a call (#2027).
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

    /// How long a call surface may take to follow the server on the slowest host we run on.
    /// A hosted macOS runner shares its cores between the simulator, the backend and the
    /// build: there the backend took 7-9s to answer GETs the app made while launching, and a
    /// first request has taken 30-49s (see `createClassHub`). 60s is that observed ceiling
    /// plus headroom — a ceiling on a condition that is normally met in well under a second,
    /// not a delay the tests wait out.
    static let slowHostTimeout: TimeInterval = 60

    /// Wait until the app's live-updates connection to the relay is up (the dashboard's
    /// connection card reads `wsConnected`, "Live updates active").
    ///
    /// The dashboard learns of a ring ONLY from the relay: it reads `calls/active` once on
    /// load, and again on a relay event. A ring the server publishes before this app has
    /// authenticated and subscribed is never delivered and nothing re-reads the list, so the
    /// card never appears. Fast hosts connect in well under a second, so every test passed
    /// by winning that race; a loaded host (run 41383568666, hosted shard 1: the app's first
    /// requests took 9s, the ring was posted at +10s and never arrived) loses it.
    func waitForRelayConnected(file: StaticString = #filePath, line: UInt = #line) {
        let connected = app.staticTexts.matching(NSPredicate(format: "label == %@", "Live updates active"))
        XCTAssertTrue(
            connected.firstMatch.waitForExistence(timeout: Self.slowHostTimeout),
            "The app should be connected to the relay before a call rings, or it never hears of the ring",
            file: file, line: line
        )
    }

    /// Ring a call on `hubId` and return its id. Fails the test unless the server accepted it.
    /// Waits for the app's relay connection first (see `waitForRelayConnected`): a ring the
    /// app is not yet subscribed for is lost, not late.
    func ringCall(callerNumber: String, hubId: String, file: StaticString = #filePath, line: UInt = #line) -> String {
        waitForRelayConnected(file: file, line: line)
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

    /// The ids of the calls the notes of `hubId` are filed under, read through the real
    /// authenticated API: the proof a saved note carries its call.
    func serverNoteCallIds(hubId: String, file: StaticString = #filePath, line: UInt = #line) -> [String] {
        guard let data = TestAdminAPI.send(
            "GET", "/api/hubs/\(hubId)/notes", baseURL: testHubURL, file: file, line: line
        ) else { return [] } // send() already failed the test
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let notes = json["notes"] as? [[String: Any]] else {
            XCTFail("GET /api/hubs/\(hubId)/notes did not return { notes: [...] }", file: file, line: line)
            return []
        }
        return notes.compactMap { $0["callId"] as? String }
    }

    /// Choose `callId` in the note editor's call picker (the editor is open).
    func chooseNoteCall(_ callId: String, file: StaticString = #filePath, line: UInt = #line) {
        let row = scrollToVisible("note-call-choice-\(callId)")
        XCTAssertTrue(
            row.waitForExistence(timeout: 20) && row.isHittable,
            "The editor's call picker should offer call \(callId)", file: file, line: line
        )
        row.tap()
    }

    /// Wait for a dashboard call card — the in-call card by default, or the ring's
    /// `incoming-call-card` — to leave the screen.
    func waitForCallCardToClear(_ identifier: String = "active-call-card", timeout: TimeInterval = BaseUITest.slowHostTimeout) -> Bool {
        let gone = NSPredicate(format: "exists == false")
        let expectation = XCTNSPredicateExpectation(predicate: gone, object: find(identifier))
        return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
    }
}
