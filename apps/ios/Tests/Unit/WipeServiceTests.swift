import XCTest
@testable import Llamenos

final class WipeServiceTests: XCTestCase {

    private var wipeService: WipeService!
    private var keychainService: KeychainService!
    private var cryptoService: CryptoService!

    /// Whatever cache was installed before this test ran.
    private var previousSharedCache: URLCache!

    override func setUp() {
        super.setUp()

        // These tests assert about the response cache, so they must not inherit the
        // one another test left installed process-wide — `wipeAll()` deliberately
        // leaves behind a cache that cannot store anything, which would make a seeding
        // test pass by storing nothing at all (#1658). Install a cache that really
        // does store, over the default on-disk store the app would use.
        previousSharedCache = URLCache.shared
        URLCache.shared = Self.makeCachingCache()

        let keychain = KeychainService()
        let crypto = CryptoService()
        let api = APIService(cryptoService: crypto, hubContext: HubContext())
        let wake = WakeKeyService(keychainService: keychain, cryptoService: crypto, apiService: api)
        let offline = OfflineQueue(apiService: api)
        let crashReporting = CrashReportingService()
        let ws = WebSocketService(cryptoService: crypto)

        keychainService = keychain
        cryptoService = crypto
        wipeService = WipeService(
            keychainService: keychain,
            cryptoService: crypto,
            wakeKeyService: wake,
            offlineQueue: offline,
            crashReportingService: crashReporting,
            webSocketService: ws
        )
    }

    override func tearDown() {
        URLCache.shared = previousSharedCache
        previousSharedCache = nil
        wipeService = nil
        keychainService = nil
        cryptoService = nil
        super.tearDown()
    }

    // MARK: - wipeAll

    func testWipeAllClearsUserDefaults() {
        // Populate a UserDefaults key
        let testKey = "wipeServiceTest_\(UUID().uuidString)"
        UserDefaults.standard.set("should-be-cleared", forKey: testKey)
        XCTAssertNotNil(UserDefaults.standard.string(forKey: testKey))

        wipeService.wipeAll()

        // After wiping the persistent domain, standard defaults are cleared
        XCTAssertNil(
            UserDefaults.standard.string(forKey: testKey),
            "UserDefaults should be cleared after wipeAll"
        )
    }

    /// Regression test for #1658.
    ///
    /// `wipeAll()` used to "clear" the response cache by replacing `URLCache.shared`
    /// with a fresh instance built with `diskPath: nil`. That instance inherits the
    /// *same* default on-disk store, so the swap deleted nothing and performed no
    /// operation the store could order anything against. A `storeCachedResponse(_:for:)`
    /// still in flight when the wipe ran therefore landed afterwards, and the
    /// replacement served it back.
    ///
    /// The seed is deliberately *not* awaited, because an unsettled write is the
    /// condition CI fails under, and the assertion is "gone, and stays gone" rather
    /// than "gone right now" — the old single-shot `XCTAssertNil` was satisfied by the
    /// replacement's empty in-memory layer, so on idle hardware it passed for the wrong
    /// reason.
    ///
    /// Measured honestly: this form still does **not** reproduce the CI failure on an
    /// idle Mac — it passed 12/12 there with the pre-fix wipe, matching the 6 clean
    /// local runs recorded on #1658. The deterministic catcher is
    /// `testWipeAllLeavesACacheThatCannotStoreAResponse` below. What this test does buy
    /// is that it can no longer pass *or* fail for timing reasons once the wipe leaves a
    /// cache that cannot store anything: the lookup is then unconditionally nil.
    func testWipeAllClearsURLCache() {
        // Per-run-unique, so a stale entry from an earlier run cannot be read as a
        // failure of this one.
        let url = URL(string: "https://test.llamenos.org/wipe-test-\(UUID().uuidString)")!
        let request = Self.seedCachedResponse(for: url)

        wipeService.wipeAll()

        XCTAssertFalse(
            waitUntil(timeout: 2) { URLCache.shared.cachedResponse(for: request) != nil },
            """
            URL cache should be cleared after wipeAll, and stay cleared. A response \
            appearing afterwards is an in-flight write the wipe raced instead of \
            ordering against.
            """
        )
    }

    /// The other half of #1658: the entry must be gone from the *store*, not just from
    /// whichever cache handle `wipeAll()` happened to leave installed.
    ///
    /// Reading back through a fresh cache over the same default on-disk store is the
    /// distinction the old test could not make, and it is where the pre-fix code was
    /// wrong in principle: replacing `URLCache.shared` with a `diskPath: nil` instance
    /// deletes nothing, because the replacement inherits that same store.
    ///
    /// Note what this does and does not establish. Waiting for the seeded response to
    /// be readable rules out asserting against a cache that was never populated, but it
    /// does not prove the write reached disk — in the simulator it is observable through
    /// an independent instance before that. So treat this as a structural assertion
    /// about where the wipe looks, not as a reproduction of the CI timing failure.
    func testWipeAllDeletesCachedResponsesFromTheStore() {
        let url = URL(string: "https://test.llamenos.org/wipe-store-\(UUID().uuidString)")!
        let request = Self.seedCachedResponse(for: url)

        let observer = Self.makeCachingCache()
        XCTAssertTrue(
            waitUntil { observer.cachedResponse(for: request) != nil },
            "the seeded response should have reached the store before the wipe — otherwise this test proves nothing"
        )

        wipeService.wipeAll()

        URLCache.shared = Self.makeCachingCache()
        XCTAssertNil(
            URLCache.shared.cachedResponse(for: request),
            "wipeAll must delete cached responses from the store, not hide them behind a replacement cache"
        )
    }

    // MARK: - ResponseCachePolicy (#1658)

    /// The wipe is reliable only because nothing can be cached in the first place: a
    /// write already in flight when the wipe runs has to be refused, not merely raced.
    func testInstalledSharedCacheCannotStoreAResponse() {
        ResponseCachePolicy.installNonCachingSharedCache()

        let url = URL(string: "https://test.llamenos.org/non-caching-\(UUID().uuidString)")!
        let request = Self.seedCachedResponse(for: url)

        XCTAssertFalse(
            waitUntil(timeout: 1) { URLCache.shared.cachedResponse(for: request) != nil },
            "the cache installed by ResponseCachePolicy must refuse to store a response"
        )
    }

    /// A wipe left behind a cache that cannot store anything, so a late write from an
    /// in-flight request has nowhere to land.
    func testWipeAllLeavesACacheThatCannotStoreAResponse() {
        wipeService.wipeAll()

        let url = URL(string: "https://test.llamenos.org/post-wipe-\(UUID().uuidString)")!
        let request = Self.seedCachedResponse(for: url)

        XCTAssertFalse(
            waitUntil(timeout: 1) { URLCache.shared.cachedResponse(for: request) != nil },
            "a response stored after wipeAll must not be retained — a wipe races in-flight writes otherwise"
        )
    }

    /// `URLSessionConfiguration.default.urlCache` *is* `URLCache.shared`, so a
    /// default-configured session writes hub API responses — E2EE envelopes, hub
    /// rosters, call history — into the process-wide on-disk store unless it is
    /// hardened. Asserted rather than left to a comment, because that identity being
    /// easy to miss is the whole of #1658.
    func testAPIServiceSessionDoesNotCacheResponses() {
        let config = URLSessionConfiguration.default
        XCTAssertNotNil(config.urlCache, "precondition: .default starts out with a response cache")

        _ = APIService(cryptoService: CryptoService(), hubContext: HubContext(), sessionConfiguration: config)

        XCTAssertNil(config.urlCache, "the API session must have no response cache")
        XCTAssertEqual(
            config.requestCachePolicy,
            .reloadIgnoringLocalCacheData,
            "the API session must never serve a cached response"
        )
    }

    func testWipeAllClearsCookies() {
        // Seed a cookie
        let props: [HTTPCookiePropertyKey: Any] = [
            .name: "wipetest",
            .value: "secret",
            .domain: "test.llamenos.org",
            .path: "/",
        ]
        if let cookie = HTTPCookie(properties: props) {
            HTTPCookieStorage.shared.setCookie(cookie)
        }

        wipeService.wipeAll()

        let remaining = HTTPCookieStorage.shared.cookies?.filter { $0.name == "wipetest" }
        XCTAssertTrue(
            remaining?.isEmpty ?? true,
            "Cookies should be cleared after wipeAll"
        )
    }

    func testWipeAllCleansTempDirectory() throws {
        // Create a temp file
        let tempFile = FileManager.default.temporaryDirectory.appendingPathComponent("wipe-test-\(UUID().uuidString).txt")
        try "sensitive".write(to: tempFile, atomically: true, encoding: .utf8)
        XCTAssertTrue(FileManager.default.fileExists(atPath: tempFile.path))

        wipeService.wipeAll()

        XCTAssertFalse(
            FileManager.default.fileExists(atPath: tempFile.path),
            "Temp files should be cleared after wipeAll"
        )
    }

    func testWipeAllCleansCachesDirectory() throws {
        guard let cachesDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            XCTFail("No caches directory")
            return
        }
        let cacheFile = cachesDir.appendingPathComponent("wipe-test-\(UUID().uuidString).txt")
        try "cached-data".write(to: cacheFile, atomically: true, encoding: .utf8)
        XCTAssertTrue(FileManager.default.fileExists(atPath: cacheFile.path))

        wipeService.wipeAll()

        XCTAssertFalse(
            FileManager.default.fileExists(atPath: cacheFile.path),
            "Caches directory should be cleared after wipeAll"
        )
    }

    // MARK: - logout

    func testLogoutPreservesUserDefaults() {
        let testKey = "wipeServiceLogoutTest_\(UUID().uuidString)"
        UserDefaults.standard.set("should-remain", forKey: testKey)

        wipeService.logout()

        XCTAssertEqual(
            UserDefaults.standard.string(forKey: testKey),
            "should-remain",
            "UserDefaults should NOT be cleared on logout"
        )

        // Clean up
        UserDefaults.standard.removeObject(forKey: testKey)
    }

    func testLogoutPreservesURLCache() {
        let url = URL(string: "https://test.llamenos.org/logout-test-\(UUID().uuidString)")!
        let request = Self.seedCachedResponse(for: url)

        // The seed is asynchronous; wait for it rather than racing it in the other
        // direction and failing a wipe-preservation assertion for the wrong reason.
        XCTAssertTrue(
            waitUntil { URLCache.shared.cachedResponse(for: request) != nil },
            "the seeded response should be readable before logout"
        )

        wipeService.logout()

        XCTAssertNotNil(
            URLCache.shared.cachedResponse(for: request),
            "URL cache should NOT be cleared on logout"
        )

        // Clean up
        URLCache.shared.removeCachedResponse(for: request)
    }

    func testLogoutPreservesTempFiles() throws {
        let tempFile = FileManager.default.temporaryDirectory.appendingPathComponent("logout-test-\(UUID().uuidString).txt")
        try "data".write(to: tempFile, atomically: true, encoding: .utf8)

        wipeService.logout()

        XCTAssertTrue(
            FileManager.default.fileExists(atPath: tempFile.path),
            "Temp files should NOT be cleared on logout"
        )

        // Clean up
        try? FileManager.default.removeItem(at: tempFile)
    }

    // MARK: - Helpers

    /// A cache that really stores responses, over the default on-disk store — the same
    /// store a stock `URLSessionConfiguration.default` would write to. The test has to
    /// use that store, not a private one, or it could not observe a wipe that swaps in
    /// a `diskPath: nil` instance and leaves the entries where they were.
    private static func makeCachingCache() -> URLCache {
        URLCache(memoryCapacity: 512_000, diskCapacity: 20_000_000, directory: nil)
    }

    /// Store a small response for `url` in `URLCache.shared` and return its request.
    @discardableResult
    private static func seedCachedResponse(for url: URL) -> URLRequest {
        let request = URLRequest(url: url)
        let response = URLResponse(
            url: url,
            mimeType: "text/plain",
            expectedContentLength: 5,
            textEncodingName: nil
        )
        let cachedResponse = CachedURLResponse(response: response, data: "hello".data(using: .utf8)!)
        URLCache.shared.storeCachedResponse(cachedResponse, for: request)
        return request
    }

    /// Poll until `condition` holds, or the timeout expires.
    ///
    /// `URLCache.storeCachedResponse(_:for:)` is asynchronous, so a test that seeds the
    /// cache and asserts in the next statement asserts against a cache that may still
    /// be empty. That is how #1658 stayed hidden on fast hardware for so long.
    private func waitUntil(timeout: TimeInterval = 5, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        }
        return condition()
    }
}
