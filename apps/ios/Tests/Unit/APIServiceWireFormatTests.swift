import Foundation
import XCTest
@testable import Llamenos

/// #1633 — the wire bytes, not the Swift model.
///
/// `APIService` used to set `.convertToSnakeCase` on the encoder shared by every
/// `body:` request. That strategy rewrites a type's own `CodingKeys` (and a
/// `Dictionary`'s keys), so `UpdateContactBody.hubID = "hubId"` shipped as `hub_id`
/// and `encryptedPII` as `encrypted_pii`. No input schema under
/// `packages/protocol/schemas/` declares a snake_case field, and none is `strict()`,
/// so the server *ignored* those keys instead of rejecting them: a required field
/// 400'd, an optional one was silently dropped.
///
/// Every iOS test that existed asserted against the Swift objects, which is exactly
/// why this survived. These tests assert the serialized bytes that leave the socket,
/// captured out of the real `APIService` request path — not out of a re-created
/// encoder, which would only prove the test's own configuration.
///
/// The bytes are also written to `apps/ios/Tests/Wire/ios-request-bodies.json`, which
/// `apps/worker/__tests__/unit/ios-wire-bodies.test.ts` round-trips through the real
/// Zod schemas. Neither side can drift: this test pins what iOS emits, that one pins
/// what the contract accepts, and the fixture is the single artefact between them.
final class APIServiceWireFormatTests: XCTestCase {

    // MARK: - Capture harness

    /// Captures the request bodies `APIService` actually puts on the wire.
    private final class CapturingURLProtocol: URLProtocol {
        private static let lock = NSLock()
        private static var bodies: [Data] = []

        static func reset() {
            lock.lock(); defer { lock.unlock() }
            bodies = []
        }

        static func captured() -> [Data] {
            lock.lock(); defer { lock.unlock() }
            return bodies
        }

        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

        override func startLoading() {
            let body = request.httpBody ?? request.httpBodyStream.map(Self.readStream) ?? Data()
            Self.lock.lock()
            Self.bodies.append(body)
            Self.lock.unlock()

            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data("{}".utf8))
            client?.urlProtocolDidFinishLoading(self)
        }

        override func stopLoading() {}

        private static func readStream(_ stream: InputStream) -> Data {
            stream.open()
            defer { stream.close() }
            var data = Data()
            let size = 4096
            var buffer = [UInt8](repeating: 0, count: size)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: size)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            return data
        }
    }

    private var api: APIService!

    /// This suite drives the **real** `APIService` request path, which is the whole point
    /// — a re-created encoder would only prove the test's own configuration. The cost is
    /// that it performs real `URLSession` work, and process-global network state is
    /// exactly what `WipeServiceTests` asserts on: `URLCache.shared`,
    /// `HTTPCookieStorage.shared`. A suite that merely tidied up after itself would stay
    /// one forgotten `tearDown` away from breaking a security assertion in another file,
    /// and the breakage would be order-dependent and therefore invisible locally.
    ///
    /// So the session is built to be *incapable* of reaching shared state:
    ///
    ///   - `.ephemeral` — in-memory only; its `urlCache` is a private instance and its
    ///     `httpCookieStorage` a private store, neither of them the `.shared` singleton
    ///     (`.default`'s `urlCache` IS `URLCache.shared`, which is the trap).
    ///   - `urlCache = nil` and `requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData`
    ///     — belt and braces: no cache object at all, so there is nothing to write to
    ///     even if a future change swapped the configuration back to `.default`.
    ///   - `httpCookieStorage = nil`, `httpShouldSetCookies = false`,
    ///     `httpCookieAcceptPolicy = .never` — same reasoning for
    ///     `testWipeAllClearsCookies`.
    ///   - the stub answers every response with `.notAllowed`, so nothing is cacheable.
    ///   - releasing the `APIService` invalidates its session (`APIService.deinit`). A
    ///     `URLSession` created with a delegate is retained by the system until
    ///     invalidated, so without that each test leaked a live session and its pinning
    ///     delegate for the rest of the process — which is also a real leak in the app,
    ///     and is why the fix is a `deinit` on `APIService` and not test-only API here.
    override func setUp() {
        super.setUp()
        CapturingURLProtocol.reset()
        api = APIService(
            cryptoService: CryptoService(),
            hubContext: HubContext(),
            sessionConfiguration: Self.isolatedConfiguration()
        )
        api.configure(baseURL: URL(string: "https://hub.example.org")!)
    }

    override func tearDown() {
        api = nil   // triggers APIService.deinit, which invalidates the session
        CapturingURLProtocol.reset()
        super.tearDown()
    }

    private static func isolatedConfiguration() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CapturingURLProtocol.self]
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        return config
    }

    /// Guards the isolation itself, so "cannot pollute" is asserted rather than intended.
    /// `.default` would fail this: its `urlCache` is `URLCache.shared` by identity.
    func testTheStubSessionCannotReachProcessGlobalNetworkState() {
        let config = Self.isolatedConfiguration()
        XCTAssertNil(config.urlCache, "a nil urlCache cannot store into URLCache.shared")
        XCTAssertNil(config.httpCookieStorage)
        XCTAssertFalse(config.httpShouldSetCookies)

        // And the baseline that makes the above non-obvious.
        XCTAssertTrue(
            URLSessionConfiguration.default.urlCache === URLCache.shared,
            "`.default` shares the global cache — that is why this suite must not use it"
        )
        XCTAssertFalse(
            URLSessionConfiguration.ephemeral.urlCache === URLCache.shared,
            "`.ephemeral` must not share the global cache"
        )
    }

    /// Send `body` through the production `APIService` path and return the bytes it sent.
    private func wireBytes(
        method: String = "POST",
        path: String = "/api/wire-probe",
        body: any Encodable
    ) async throws -> Data {
        CapturingURLProtocol.reset()
        let _: EmptyResponse = try await api.request(method: method, path: path, body: body)
        let captured = CapturingURLProtocol.captured()
        XCTAssertEqual(captured.count, 1, "expected exactly one captured request")
        return captured.first ?? Data()
    }

    /// Canonical JSON string (sorted keys) so comparisons do not depend on key order.
    private func canonical(_ data: Data) throws -> String {
        let object = try JSONSerialization.jsonObject(with: data)
        let bytes = try JSONSerialization.data(
            withJSONObject: object,
            options: [.sortedKeys, .withoutEscapingSlashes]
        )
        return String(decoding: bytes, as: UTF8.self)
    }

    /// Every JSON object key reachable from `data`, at any depth.
    private func allKeys(_ data: Data) throws -> Set<String> {
        var keys: Set<String> = []
        func walk(_ value: Any) {
            if let dict = value as? [String: Any] {
                for (key, child) in dict {
                    keys.insert(key)
                    walk(child)
                }
            } else if let array = value as? [Any] {
                array.forEach(walk)
            }
        }
        walk(try JSONSerialization.jsonObject(with: data))
        return keys
    }

    // MARK: - Fixture bodies
    //
    // One per at-risk call site. Values are fixed strings so the bytes are stable.

    private static let enc = String(repeating: "cd", count: 32)
    private static let ct = "a1b2c3d4e5f60718293a4b5c6d7e8f90"
    private static let pubkey = String(repeating: "ab", count: 32)

    private static let recipient = RecipientEnvelope(ct: ct, enc: enc, pubkey: pubkey)
    private static let admin = SharedAdminEnvelope(ct: ct, enc: enc, pubkey: pubkey)

    /// `(fixtureId, body)` — mirrors the `cases[].id` in ios-request-bodies.json.
    private func fixtureBodies() -> [(String, any Encodable)] {
        [
            // POST /api/notes — createNoteBodySchema. authorEnvelope and adminEnvelopes
            // are `.optional()`: snake_cased, they were dropped rather than rejected.
            ("createNote", CreateNoteRequest(
                callId: "11111111-1111-4111-8111-111111111111",
                conversationId: nil,
                encryptedContent: Self.ct,
                authorEnvelope: ProtocolKeyEnvelope(ct: Self.ct, enc: Self.enc),
                adminEnvelopes: [Self.recipient]
            )),

            // POST /api/conversations/:id/messages — sendMessageBodySchema. BOTH the
            // ciphertext and the envelopes are `.optional()` here.
            ("sendMessage", SendMessageRequest(
                encryptedContent: Self.ct,
                readerEnvelopes: [Self.recipient]
            )),

            // POST /api/contacts-v2 — createContactBodySchema. Generated type; `hubID`
            // carries an explicit `CodingKeys` case of "hubId" that the strategy
            // overrode to "hub_id".
            ("createContact", CreateContactBody(
                blindIndexes: ["nameToken": .string("f00dcafe")],
                contactTypeHash: nil,
                encryptedPII: Self.ct,
                encryptedSummary: Self.ct,
                hubID: "22222222-2222-4222-8222-222222222222",
                identifierHashes: ["deadbeef"],
                nameHash: "cafed00d",
                piiEnvelopes: [Self.admin],
                statusHash: nil,
                summaryEnvelopes: [Self.admin],
                tagHashes: nil,
                trigramTokens: ["abc"]
            )),

            // PATCH /api/contacts-v2/:id — updateContactBodySchema is
            // createContactBodySchema.partial(): EVERY field optional. This is the
            // silent-loss case. Snake-cased, the whole body validated as `{}`,
            // `services.contacts.update(id, {})` wrote nothing, and iOS reported success.
            ("updateContact", UpdateContactBody(
                blindIndexes: ["nameToken": .string("f00dcafe")],
                contactTypeHash: nil,
                encryptedPII: Self.ct,
                encryptedSummary: Self.ct,
                hubID: "22222222-2222-4222-8222-222222222222",
                identifierHashes: ["deadbeef"],
                nameHash: "cafed00d",
                piiEnvelopes: [Self.admin],
                statusHash: nil,
                summaryEnvelopes: [Self.admin],
                tagHashes: nil,
                trigramTokens: ["abc"]
            )),

            // POST /api/reports — createReportBodySchema. Used to need a hand-rolled
            // plain-encoder `rawBody:` detour; now goes through `body:` like everything else.
            ("createTypedReport", CreateTypedReportRequest(
                title: "Wire probe",
                category: nil,
                reportTypeId: "33333333-3333-4333-8333-333333333333",
                encryptedContent: Self.ct,
                readerEnvelopes: [Self.recipient]
            )),

            // POST /api/reports/:id/assign — assignReportBodySchema requires `assignedTo`.
            ("assignReport", ReportAssignRequest(assignedTo: Self.pubkey)),

            // PATCH /api/records/:id — updateRecordBodySchema is `.partial()`, so a
            // snake_cased body validated as `{}`: the case status change silently did
            // not happen, and the route still wrote a `recordUpdated` audit entry.
            ("updateRecord", UpdateRecordRequest(statusHash: "aa11", severityHash: "bb22")),

            // POST /api/devices/register — registerDeviceBodySchema. The only body in
            // this set whose breakage was observed end to end against a live server
            // rather than inferred from the schema: the real client, on every launch,
            // sent {"device_id","push_token","wake_key_public","platform"} and the
            // server answered 400 "Provide pushToken … or x25519Pubkey …" because both
            // of the schema's `.refine()`s read keys that were no longer there.
            //
            // `pushToken` and `wakeKeyPublic` are `.optional()` on the object, so the
            // key-drop analysis alone puts this in the "silent" column — but the two
            // refines make them conditionally required, which is what turned it loud.
            // That is why it is here with `optionalKeys: []`: the refine, not the field
            // modifier, decides whether a dropped key 400s.
            //
            // A second defect this endpoint carries, unrelated to the key casing and
            // not fixed by it, is #1716: the schema does not declare `deviceId` at all.
            //
            // It failed in silence anyway, because
            // `LlamenosApp.didRegisterForRemoteNotificationsWithDeviceToken` swallows the
            // throw as "non-fatal" — so iOS has never had a row in `devices`, and no
            // push token, wake key or HPKE device recipient has ever been registered.
            ("registerDevice", DeviceRegistrationRequest(
                pushToken: Self.pubkey,
                wakeKeyPublic: Self.enc,
                platform: "ios",
                deviceId: "44444444-4444-4444-8444-444444444444"
            )),

            // POST /api/recovery-group/user-envelope — a `[String: String]` body.
            // A key strategy rewrites Dictionary keys too, so untyped bodies were
            // affected as much as the generated structs.
            ("storeUserRecoveryEnvelope", [
                "hubId": "22222222-2222-4222-8222-222222222222",
                "envelope": Self.ct,
            ] as [String: String]),
        ]
    }

    // MARK: - The wire bytes carry camelCase, and no snake_case

    func testEveryAtRiskBodyShipsCamelCaseKeys() async throws {
        for (id, body) in fixtureBodies() {
            let data = try await wireBytes(body: body)
            let keys = try allKeys(data)
            let snake = keys.filter { $0.contains("_") }
            XCTAssertTrue(
                snake.isEmpty,
                "\(id): shipped snake_case keys \(snake.sorted()) — no input schema accepts them"
            )
        }
    }

    func testTheIssuesOwnExampleShipsBanIdNotBanUnderscoreId() async throws {
        let data = try await wireBytes(body: ["banId": "44444444-4444-4444-8444-444444444444"])
        let json = String(decoding: data, as: UTF8.self)
        XCTAssertTrue(json.contains("\"banId\""), "expected banId, got: \(json)")
        XCTAssertFalse(json.contains("ban_id"), "ban_id is a key promoteBanBodySchema does not declare")
    }

    func testEnvelopeAndCiphertextKeysSurviveEncoding() async throws {
        let note = try await wireBytes(body: CreateNoteRequest(
            callId: "11111111-1111-4111-8111-111111111111",
            conversationId: nil,
            encryptedContent: Self.ct,
            authorEnvelope: ProtocolKeyEnvelope(ct: Self.ct, enc: Self.enc),
            adminEnvelopes: [Self.recipient]
        ))
        let noteKeys = try allKeys(note)
        for key in ["encryptedContent", "authorEnvelope", "adminEnvelopes", "callId"] {
            XCTAssertTrue(noteKeys.contains(key), "createNote lost \(key); keys were \(noteKeys.sorted())")
        }

        let message = try await wireBytes(body: SendMessageRequest(
            encryptedContent: Self.ct,
            readerEnvelopes: [Self.recipient]
        ))
        let messageKeys = try allKeys(message)
        for key in ["encryptedContent", "readerEnvelopes"] {
            XCTAssertTrue(messageKeys.contains(key), "sendMessage lost \(key); keys were \(messageKeys.sorted())")
        }
        XCTAssertFalse(
            messageKeys.contains("recipientEnvelopes"),
            "sendMessageBodySchema declares readerEnvelopes; recipientEnvelopes is dropped by the validator"
        )
    }

    func testGeneratedTypesOwnCodingKeysAreHonoured() async throws {
        // UpdateContactBody declares `case hubID = "hubId"`. A key strategy overrides
        // that; the absence of one is what makes the declared key authoritative.
        let data = try await wireBytes(method: "PATCH", body: UpdateContactBody(
            blindIndexes: nil, contactTypeHash: nil, encryptedPII: Self.ct,
            encryptedSummary: Self.ct, hubID: "h1", identifierHashes: nil, nameHash: nil,
            piiEnvelopes: [Self.admin], statusHash: nil, summaryEnvelopes: nil,
            tagHashes: nil, trigramTokens: nil
        ))
        let keys = try allKeys(data)
        XCTAssertTrue(keys.contains("hubId"))
        XCTAssertTrue(keys.contains("encryptedPII"))
        XCTAssertTrue(keys.contains("piiEnvelopes"))
        XCTAssertFalse(keys.contains("hub_id"))
        XCTAssertFalse(keys.contains("encrypted_pii"))
    }

    func testUntypedDictionaryBodiesShipTheirKeysVerbatim() async throws {
        let data = try await wireBytes(body: ["hubId": "h1", "envelope": Self.ct])
        XCTAssertEqual(try allKeys(data), ["hubId", "envelope"])

        let nested = try await wireBytes(body: ["blindIndexes": ["nameToken": "f00dcafe"]])
        XCTAssertEqual(try allKeys(nested), ["blindIndexes", "nameToken"])
    }

    /// Pins *which* keys a key strategy reaches, because it is not what you would guess
    /// and the guess changes how bad #1633 was. Measured on Swift 6.4 / Foundation:
    ///
    ///   - a type's own `CodingKeys`                         → converted
    ///   - the keys of a TOP-LEVEL `Dictionary` body         → converted, but only
    ///     because `request(body:)` wraps the body in `AnyEncodable`. Hand Foundation a
    ///     `Dictionary` it can see statically (`encoder.encode(dict)`) and it skips them.
    ///   - the keys of a NESTED `Dictionary`                 → NOT converted
    ///
    /// The last one matters: `blindIndexes` and `NotePayload.fields` are nested
    /// dictionaries of caller-chosen names. Had those been rewritten, the rename would
    /// not have been a droppable unknown key — a `z.record` accepts any key — so an
    /// iOS-written blind index or custom field would have been stored under the wrong
    /// name and silently broken search and display. It did not happen.
    ///
    /// The middle one matters too: anyone who "simplifies" `AnyEncodable` out of the
    /// `body:` path changes the wire format of every untyped dictionary body.
    func testWhichKeysAKeyStrategyActuallyReaches() throws {
        let legacy = JSONEncoder()
        legacy.keyEncodingStrategy = .convertToSnakeCase

        struct Holder: Encodable {
            let blindIndexes: [String: String]
            let encryptedPII: String
        }
        let holder = try allKeys(legacy.encode(Holder(
            blindIndexes: ["nameToken": "f00dcafe"],
            encryptedPII: Self.ct
        )))
        XCTAssertTrue(holder.contains("blind_indexes"), "a declared CodingKey is converted")
        XCTAssertTrue(holder.contains("encrypted_pii"))
        XCTAssertTrue(holder.contains("nameToken"), "a nested Dictionary key is NOT converted")
        XCTAssertFalse(holder.contains("name_token"))

        let seenStatically = try allKeys(legacy.encode(["hubId": "h1"]))
        XCTAssertEqual(seenStatically, ["hubId"], "a statically-known Dictionary is skipped")

        let typeErased = try allKeys(legacy.encode(AnyEncodable(["hubId": "h1"] as [String: String])))
        XCTAssertEqual(typeErased, ["hub_id"], "…but the AnyEncodable path APIService uses is not")
    }

    // MARK: - The regression witness, and the shared fixture

    /// The re-injection check, kept in code rather than done once by hand: encode the
    /// same bodies with `.convertToSnakeCase` restored and assert the keys the server
    /// needs are gone. If someone puts the strategy back on the shared encoder,
    /// `testEveryAtRiskBodyShipsCamelCaseKeys` goes red and this test explains why.
    func testRestoringTheStrategyDestroysTheKeysTheSchemaNeeds() throws {
        let legacy = JSONEncoder()
        legacy.keyEncodingStrategy = .convertToSnakeCase

        let note = try legacy.encode(CreateNoteRequest(
            callId: "c1", conversationId: nil, encryptedContent: Self.ct,
            authorEnvelope: ProtocolKeyEnvelope(ct: Self.ct, enc: Self.enc),
            adminEnvelopes: [Self.recipient]
        ))
        let noteKeys = try allKeys(note)
        XCTAssertTrue(noteKeys.contains("encrypted_content"))
        XCTAssertFalse(noteKeys.contains("encryptedContent"))
        XCTAssertFalse(noteKeys.contains("authorEnvelope"))
        XCTAssertFalse(noteKeys.contains("adminEnvelopes"))

        let contact = try legacy.encode(UpdateContactBody(
            blindIndexes: nil, contactTypeHash: nil, encryptedPII: Self.ct,
            encryptedSummary: Self.ct, hubID: "h1", identifierHashes: nil, nameHash: nil,
            piiEnvelopes: [Self.admin], statusHash: nil, summaryEnvelopes: nil,
            tagHashes: nil, trigramTokens: nil
        ))
        let contactKeys = try allKeys(contact)
        // Every key of the all-optional update body is unrecognisable, so the body the
        // validator sees is `{}` — accepted, and nothing written.
        XCTAssertTrue(contactKeys.isDisjoint(with: [
            "hubId", "encryptedPII", "encryptedSummary", "piiEnvelopes",
        ]))
    }

    /// Asserts the committed fixture matches what iOS actually emits — both the
    /// current bytes and the historic snake_cased ones — because
    /// `apps/worker/__tests__/unit/ios-wire-bodies.test.ts` validates that fixture
    /// against the real Zod schemas and must therefore be validating real bytes.
    ///
    /// On a mismatch the observed bytes are PRINTED, between markers, rather than
    /// written to a file: a simulator-hosted test is sandboxed to an app container
    /// that is torn down with the run, so a path in a failure message is a path to
    /// something that no longer exists by the time anyone reads it.
    func testCommittedFixtureMatchesWhatWeActuallySend() async throws {
        let legacy = JSONEncoder()
        legacy.keyEncodingStrategy = .convertToSnakeCase

        var observed: [String: [String: Any]] = [:]
        for (id, body) in fixtureBodies() {
            let wire = try await wireBytes(body: body)
            let snake = try legacy.encode(AnyEncodable(body))
            observed[id] = [
                "wire": try JSONSerialization.jsonObject(with: wire),
                "legacySnakeCase": try JSONSerialization.jsonObject(with: snake),
            ]
        }

        let observedJSON = try JSONSerialization.data(
            withJSONObject: observed,
            options: [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
        )

        guard let url = Self.fixtureURL else {
            throw XCTSkip("fixture not reachable from the test bundle; run from a source checkout")
        }
        let committed = try Data(contentsOf: url)
        let committedBodies = (try JSONSerialization.jsonObject(with: committed) as? [String: Any])?["bodies"]
        let committedJSON = try JSONSerialization.data(
            withJSONObject: committedBodies ?? [:],
            options: [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
        )

        if committedJSON != observedJSON {
            print("---BEGIN OBSERVED ios-request-bodies.bodies---")
            print(String(decoding: observedJSON, as: UTF8.self))
            print("---END OBSERVED ios-request-bodies.bodies---")
            XCTFail("""
            apps/ios/Tests/Wire/ios-request-bodies.json is stale, so the Zod round-trip in \
            apps/worker/__tests__/unit/ios-wire-bodies.test.ts is validating bytes iOS no \
            longer sends. The observed "bodies" object is printed above between \
            ---BEGIN OBSERVED---/---END OBSERVED--- markers; copy it into the fixture.
            """)
        }
    }

    /// `apps/ios/Tests/Wire/ios-request-bodies.json`, found by walking up from this
    /// source file. `#filePath` is the only reliable anchor: the fixture is not a
    /// bundle resource, and the simulator's cwd is not the repo.
    private static var fixtureURL: URL? {
        var dir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // Tests/Unit
            .deletingLastPathComponent()   // Tests
        let candidate = dir.appendingPathComponent("Wire/ios-request-bodies.json")
        if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
        // Tolerate the file being moved up a level or two rather than silently passing.
        for _ in 0..<3 {
            dir = dir.deletingLastPathComponent()
            let alt = dir.appendingPathComponent("apps/ios/Tests/Wire/ios-request-bodies.json")
            if FileManager.default.fileExists(atPath: alt.path) { return alt }
        }
        return nil
    }
}
