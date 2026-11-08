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
            identity.waitForExistence(timeout: Self.eventBackstop), "The dashboard should expose the signed-in identity",
            file: file, line: line
        )
        let pubkey = identity.label
        XCTAssertEqual(
            pubkey.count, 64, "The dashboard identity should be a 32-byte hex pubkey, got '\(pubkey)'",
            file: file, line: line
        )
        return pubkey
    }

    /// The backstop on every wait whose condition is observable: an element appearing or
    /// clearing, the relay connecting, a request answering. Each of those waits returns the
    /// instant its condition holds, so this number is never spent on a healthy run and is
    /// not a delay anything waits out — it only bounds how long a genuine fault (a screen
    /// that never arrives, a server that never answers) takes to be reported.
    ///
    /// It is sized to the slowest thing those conditions have been seen to wait on, which is
    /// the first response of a backend sharing a hosted runner's cores with the simulator: 7-9s
    /// for a GET during launch, 30-49s for a first request (see `createClassHub`). Never
    /// reach for it to make a test that fails because the app did not do something pass:
    /// find the event the app emits for that thing and wait on it.
    static let eventBackstop: TimeInterval = 60

    /// The app's own copy for `key`, from the generated strings bundled into this test target
    /// (`project.yml` shares the app's `Resources/Localizable` variant group, so every locale is
    /// in the bundle; this reads `en.lproj` explicitly). The app is launched pinned to English (`BaseUITest.setUp`), so this
    /// is exactly what it renders. Fails the test on a key the strings do not define, rather than
    /// returning the key and letting a wait time out on a label nothing will ever show.
    func appString(_ key: String, file: StaticString = #filePath, line: UInt = #line) -> String {
        let missing = "<<missing \(key)>>"
        guard let path = Bundle(for: BaseUITest.self).path(forResource: "en", ofType: "lproj"),
              let english = Bundle(path: path)
        else {
            XCTFail("The English strings are not bundled into the UI test target", file: file, line: line)
            return missing
        }
        let copy = english.localizedString(forKey: key, value: missing, table: nil)
        if copy == missing { XCTFail("'\(key)' is not in the generated English strings", file: file, line: line) }
        return copy
    }

    /// Wait until the app's live-updates connection to the relay is up: the dashboard's
    /// connection card renders `WebSocketService.ConnectionState.displayText`, which for
    /// `.connected` is `ws_connected`. That is the iOS app's own string, not the web client's
    /// `wsConnected` ("Live updates active"), which no iOS screen shows.
    ///
    /// The dashboard learns of a ring ONLY from the relay: it reads `calls/active` once on
    /// load, and again on a relay event. A ring the server publishes before this app has
    /// authenticated is never delivered and nothing re-reads the list, so the card never
    /// appears (#2424). Fast hosts connect in well under a second, so every test passed by
    /// winning that race; a loaded host (run 41383568666, hosted shard 1: the app's first
    /// requests took 9s, the ring was posted at +10s and never arrived) loses it.
    ///
    /// This is the closest signal the UI gives, not a complete one: the label turns to
    /// "connected" on the server's `authenticated` reply, and the app's hub subscriptions are
    /// sent after that. The server's `subscribed` acknowledgement is not surfaced anywhere on
    /// screen, so there is no event to wait on for "a ring posted now will reach me"; that
    /// residual window closes only when the app resyncs on (re)authentication (#2424).
    func waitForRelayConnected(file: StaticString = #filePath, line: UInt = #line) {
        let connected = app.staticTexts.matching(NSPredicate(format: "label == %@", appString("ws_connected", file: file, line: line)))
        XCTAssertTrue(
            connected.firstMatch.waitForExistence(timeout: Self.eventBackstop),
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
            row.waitForExistence(timeout: Self.eventBackstop) && row.isHittable,
            "The editor's call picker should offer call \(callId)", file: file, line: line
        )
        row.tap()
    }

    /// Wait for a dashboard call card — the in-call card by default, or the ring's
    /// `incoming-call-card` — to leave the screen.
    func waitForCallCardToClear(_ identifier: String = "active-call-card", timeout: TimeInterval = BaseUITest.eventBackstop) -> Bool {
        find(identifier).waitForNonExistence(timeout: timeout)
    }
}
