import Foundation
import XCTest
@testable import Llamenos

/// `@MainActor`: `OfflineQueue` is main-actor isolated (#1920 audit).
@MainActor
final class OfflineQueueTests: XCTestCase {

    private var queue: OfflineQueue!
    private var api: APIService!

    override func setUp() {
        super.setUp()
        let crypto = CryptoService()
        let hubContext = HubContext()
        api = APIService(cryptoService: crypto, hubContext: hubContext)
        queue = OfflineQueue(apiService: api)
        // Start each test with an empty queue
        queue.clear()
    }

    override func tearDown() {
        queue.stopMonitoring()
        queue.clear()
        queue = nil
        api = nil
        super.tearDown()
    }

    // MARK: - classifyOperation

    func testClassifyNoteCreate() {
        XCTAssertEqual(OfflineQueue.classifyOperation(path: "/api/hubs/1/notes", method: "POST"), .noteCreate)
    }

    func testClassifyNoteUpdate() {
        XCTAssertEqual(OfflineQueue.classifyOperation(path: "/api/hubs/1/notes/abc", method: "PATCH"), .noteUpdate)
    }

    func testClassifyMessageSend() {
        XCTAssertEqual(OfflineQueue.classifyOperation(path: "/api/hubs/1/messages", method: "POST"), .messageSend)
    }

    func testClassifyShiftToggle() {
        XCTAssertEqual(OfflineQueue.classifyOperation(path: "/api/hubs/1/shifts/my-status", method: "PATCH"), .shiftToggle)
    }

    func testClassifyReportCreate() {
        XCTAssertEqual(OfflineQueue.classifyOperation(path: "/api/hubs/1/reports", method: "POST"), .reportCreate)
    }

    func testClassifyReportMessage() {
        XCTAssertEqual(OfflineQueue.classifyOperation(path: "/api/hubs/1/reports/42/messages", method: "POST"), .reportMessage)
    }

    func testClassifyBanAdd() {
        XCTAssertEqual(OfflineQueue.classifyOperation(path: "/api/hubs/1/bans", method: "POST"), .banAdd)
    }

    func testClassifyBanRemove() {
        XCTAssertEqual(OfflineQueue.classifyOperation(path: "/api/hubs/1/bans/xyz", method: "DELETE"), .banRemove)
    }

    func testClassifyGenericFallback() {
        XCTAssertEqual(OfflineQueue.classifyOperation(path: "/api/unknown/path", method: "PUT"), .genericWrite)
    }

    // MARK: - isQueueableMethod

    func testQueueableMethods() {
        XCTAssertTrue(OfflineQueue.isQueueableMethod("POST"))
        XCTAssertTrue(OfflineQueue.isQueueableMethod("PUT"))
        XCTAssertTrue(OfflineQueue.isQueueableMethod("PATCH"))
        XCTAssertTrue(OfflineQueue.isQueueableMethod("DELETE"))
    }

    func testNonQueueableMethods() {
        XCTAssertFalse(OfflineQueue.isQueueableMethod("GET"))
        XCTAssertFalse(OfflineQueue.isQueueableMethod("HEAD"))
        XCTAssertFalse(OfflineQueue.isQueueableMethod("OPTIONS"))
    }

    func testQueueableMethodIsCaseInsensitive() {
        XCTAssertTrue(OfflineQueue.isQueueableMethod("post"))
        XCTAssertTrue(OfflineQueue.isQueueableMethod("Post"))
        XCTAssertFalse(OfflineQueue.isQueueableMethod("get"))
    }

    // MARK: - enqueue / pendingCount

    func testEnqueueIncreasesPendingCount() {
        XCTAssertEqual(queue.pendingCount, 0)
        queue.enqueue(path: "/api/notes", method: "POST", body: nil)
        XCTAssertEqual(queue.pendingCount, 1)
        queue.enqueue(path: "/api/messages", method: "POST", body: "{}")
        XCTAssertEqual(queue.pendingCount, 2)
    }

    func testEnqueueReturnsUniqueIDs() {
        let id1 = queue.enqueue(path: "/api/notes", method: "POST", body: nil)
        let id2 = queue.enqueue(path: "/api/notes", method: "POST", body: nil)
        XCTAssertNotEqual(id1, id2)
    }

    func testEnqueueSetsCorrectFields() {
        let path = "/api/hubs/1/notes"
        let method = "POST"
        let body = #"{"encryptedContent":"abc"}"#
        queue.enqueue(path: path, method: method, body: body)

        let ops = queue.getQueue()
        XCTAssertEqual(ops.count, 1)
        let op = ops[0]
        XCTAssertEqual(op.path, path)
        XCTAssertEqual(op.method, method)
        XCTAssertEqual(op.body, body)
        XCTAssertEqual(op.attempts, 0)
        XCTAssertNil(op.lastError)
        XCTAssertEqual(op.type, .noteCreate)
        // queuedAt should be a valid ISO 8601 timestamp
        XCTAssertFalse(op.queuedAt.isEmpty)
    }

    // MARK: - remove

    func testRemoveByID() {
        let id = queue.enqueue(path: "/api/notes", method: "POST", body: nil)
        queue.enqueue(path: "/api/messages", method: "POST", body: nil)
        XCTAssertEqual(queue.pendingCount, 2)

        queue.remove(id: id)

        XCTAssertEqual(queue.pendingCount, 1)
        XCTAssertFalse(queue.getQueue().contains { $0.id == id })
    }

    func testRemoveNonExistentIDIsNoOp() {
        queue.enqueue(path: "/api/notes", method: "POST", body: nil)
        queue.remove(id: "nonexistent-id")
        XCTAssertEqual(queue.pendingCount, 1)
    }

    // MARK: - clear

    func testClearEmptiesQueue() {
        queue.enqueue(path: "/api/notes", method: "POST", body: nil)
        queue.enqueue(path: "/api/messages", method: "POST", body: nil)
        queue.enqueue(path: "/api/reports", method: "POST", body: nil)
        XCTAssertEqual(queue.pendingCount, 3)

        queue.clear()

        XCTAssertEqual(queue.pendingCount, 0)
        XCTAssertTrue(queue.getQueue().isEmpty)
    }

    // MARK: - getQueue (snapshot)

    func testGetQueueReturnsFIFOOrder() {
        let id1 = queue.enqueue(path: "/api/notes", method: "POST", body: nil)
        let id2 = queue.enqueue(path: "/api/messages", method: "POST", body: nil)
        let id3 = queue.enqueue(path: "/api/reports", method: "POST", body: nil)

        let ops = queue.getQueue()
        XCTAssertEqual(ops.map(\.id), [id1, id2, id3])
    }

    func testGetQueueReturnsCopy() {
        queue.enqueue(path: "/api/notes", method: "POST", body: nil)
        let snapshot = queue.getQueue()
        queue.clear()
        // snapshot is independent of queue state
        XCTAssertEqual(snapshot.count, 1)
        XCTAssertEqual(queue.pendingCount, 0)
    }

    // MARK: - Disk persistence

    func testQueueSurvivestReinit() {
        queue.enqueue(path: "/api/notes", method: "POST", body: #"{"content":"hello"}"#)
        queue.enqueue(path: "/api/messages", method: "POST", body: nil)

        // Create a new queue instance pointing to the same file
        let queue2 = OfflineQueue(apiService: api)
        XCTAssertEqual(queue2.pendingCount, 2)

        let ops = queue2.getQueue()
        XCTAssertEqual(ops[0].path, "/api/notes")
        XCTAssertEqual(ops[1].path, "/api/messages")

        // Clean up
        queue2.clear()
    }

    func testClearPurgesDiskState() {
        queue.enqueue(path: "/api/notes", method: "POST", body: nil)
        queue.clear()

        let queue2 = OfflineQueue(apiService: api)
        XCTAssertEqual(queue2.pendingCount, 0)
    }

    // MARK: - replay

    /// Logout and wipe call `clear()` on main while `replay()` is suspended on a request.
    /// `replay()` used to write each result back with `queue[i] = op` against indices it
    /// took before the first `await` — so a clear that landed mid-request trapped with an
    /// out-of-range index, and an operation the user had just cleared was still sent.
    func testClearDuringReplayNeitherTrapsNorSendsTheClearedOperations() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [GatedReplayURLProtocol.self]
        let gatedAPI = APIService(cryptoService: CryptoService(), hubContext: HubContext(), sessionConfiguration: config)
        try gatedAPI.configure(hubURLString: "https://offline-queue.test")
        let gatedQueue = OfflineQueue(apiService: gatedAPI)
        gatedQueue.clear()
        GatedReplayURLProtocol.reset()

        gatedQueue.enqueue(path: "/api/notes", method: "POST", body: #"{"n":1}"#)
        gatedQueue.enqueue(path: "/api/notes", method: "POST", body: #"{"n":2}"#)

        let replay = Task { await gatedQueue.replay() }
        let arrived = await Task.detached { GatedReplayURLProtocol.firstRequestArrived.wait(timeout: .now() + 10) }.value
        XCTAssertEqual(arrived, .success, "replay() never sent the first queued operation")

        // The user logs out while that request is in flight.
        gatedQueue.clear()
        GatedReplayURLProtocol.releaseFirstRequest.signal()
        await replay.value

        XCTAssertEqual(GatedReplayURLProtocol.requestCount(), 1, "an operation cleared before its turn must not be sent")
        XCTAssertTrue(gatedQueue.getQueue().isEmpty, "replay() must not resurrect operations cleared while it ran")
        XCTAssertEqual(gatedQueue.pendingCount, 0)
        XCTAssertFalse(gatedQueue.isReplaying)
    }

    // MARK: - Permanent refusals (#2208)

    func testPermanentRefusalClassification() {
        for status in [400, 403, 404, 410, 413, 422] {
            XCTAssertTrue(APIError.isPermanentRefusal(status: status), "\(status) can never succeed on replay")
        }
        // 401 may clear once the device is registered; 408/429 are transient; 409 means
        // the write already landed; 5xx is the server's problem, not the request's.
        for status in [200, 201, 401, 408, 409, 429, 500, 502, 503] {
            XCTAssertFalse(APIError.isPermanentRefusal(status: status), "\(status) must not be rejected")
        }
    }

    func testRefusedWriteLeavesTheQueueAfterTheFirstRefusalAndKeepsItsBody() async throws {
        let (refusingQueue, _) = try makeQueue(answering: 404)
        let body = #"{"encryptedContent":"abc"}"#
        let id = refusingQueue.enqueue(path: "/api/notes", method: "POST", body: body)

        await refusingQueue.replay()

        XCTAssertEqual(StatusURLProtocol.requestCount(), 1)
        XCTAssertTrue(refusingQueue.getQueue().isEmpty, "a refused write must not stay queued as 'waiting to sync'")
        XCTAssertEqual(refusingQueue.pendingCount, 0)
        XCTAssertEqual(refusingQueue.rejected.map(\.id), [id])
        XCTAssertEqual(refusingQueue.rejected.first?.body, body, "the author's content must survive the refusal")
        XCTAssertEqual(refusingQueue.rejected.first?.rejectedStatus, 404)

        await refusingQueue.replay()
        XCTAssertEqual(StatusURLProtocol.requestCount(), 1, "a refused write must not be re-sent on the next replay")
        refusingQueue.clear()
    }

    func testRejectedWritesSurviveRelaunchAndClearPurgesThem() async throws {
        let (refusingQueue, refusingAPI) = try makeQueue(answering: 403)
        refusingQueue.enqueue(path: "/api/notes", method: "POST", body: #"{"n":1}"#)
        await refusingQueue.replay()

        let relaunched = OfflineQueue(apiService: refusingAPI)
        XCTAssertEqual(relaunched.rejected.count, 1, "a refusal the author has not seen yet must outlive the app")
        XCTAssertEqual(relaunched.pendingCount, 0)

        relaunched.clear()
        XCTAssertTrue(relaunched.rejected.isEmpty)
        XCTAssertTrue(OfflineQueue(apiService: refusingAPI).rejected.isEmpty, "logout and wipe must purge rejected writes too")
    }

    func testDismissRejectedDiscardsOnlyThatWrite() async throws {
        let (refusingQueue, _) = try makeQueue(answering: 400)
        let first = refusingQueue.enqueue(path: "/api/notes", method: "POST", body: #"{"n":1}"#)
        let second = refusingQueue.enqueue(path: "/api/notes", method: "POST", body: #"{"n":2}"#)
        await refusingQueue.replay()
        XCTAssertEqual(refusingQueue.rejected.map(\.id), [first, second])

        refusingQueue.dismissRejected(id: first)

        XCTAssertEqual(refusingQueue.rejected.map(\.id), [second])
        refusingQueue.clear()
    }

    func testRetryRejectedSendsTheSameContentAgain() async throws {
        let (refusingQueue, _) = try makeQueue(answering: 403)
        let body = #"{"encryptedContent":"keep-me"}"#
        let id = refusingQueue.enqueue(path: "/api/notes", method: "POST", body: body)
        await refusingQueue.replay()
        XCTAssertEqual(StatusURLProtocol.requestCount(), 1)

        // The refusal was fixed (a permission was granted): the server now accepts it.
        StatusURLProtocol.status = 201
        refusingQueue.retryRejected(id: id)
        XCTAssertTrue(refusingQueue.rejected.isEmpty)
        XCTAssertEqual(refusingQueue.pendingCount, 1)

        await refusingQueue.replay()

        XCTAssertEqual(StatusURLProtocol.requestCount(), 2)
        XCTAssertEqual(StatusURLProtocol.lastBody(), body, "the retry must carry the author's original content")
        XCTAssertTrue(refusingQueue.getQueue().isEmpty)
        XCTAssertTrue(refusingQueue.rejected.isEmpty)
        refusingQueue.clear()
    }

    func testAWriteClearedWhileInFlightIsNotResurrectedAsRejected() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [GatedReplayURLProtocol.self]
        let gatedAPI = APIService(cryptoService: CryptoService(), hubContext: HubContext(), sessionConfiguration: config)
        try gatedAPI.configure(hubURLString: "https://offline-queue.test")
        let gatedQueue = OfflineQueue(apiService: gatedAPI)
        gatedQueue.clear()
        GatedReplayURLProtocol.reset()

        gatedQueue.enqueue(path: "/api/notes", method: "POST", body: #"{"n":1}"#)
        let replay = Task { await gatedQueue.replay() }
        let arrived = await Task.detached { GatedReplayURLProtocol.firstRequestArrived.wait(timeout: .now() + 10) }.value
        XCTAssertEqual(arrived, .success)

        gatedQueue.clear()
        GatedReplayURLProtocol.releaseFirstRequest.signal()
        await replay.value

        XCTAssertTrue(gatedQueue.rejected.isEmpty, "a late 400 must not put a logged-out user's write back on disk")
    }

    // MARK: - Helpers

    /// A queue whose every request is answered with `status`.
    private func makeQueue(answering status: Int) throws -> (OfflineQueue, APIService) {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StatusURLProtocol.self]
        let statusAPI = APIService(cryptoService: CryptoService(), hubContext: HubContext(), sessionConfiguration: config)
        try statusAPI.configure(hubURLString: "https://offline-queue.test")
        let statusQueue = OfflineQueue(apiService: statusAPI)
        statusQueue.clear()
        StatusURLProtocol.reset(status: status)
        return (statusQueue, statusAPI)
    }
}

// MARK: - StatusURLProtocol

/// Answers every request with a fixed status and records how many arrived and the last
/// body. Registered per-session through `protocolClasses`, never globally.
private final class StatusURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var _status = 200
    private static var count = 0
    private static var _lastBody: String?

    static var status: Int {
        get { lock.withLock { _status } }
        set { lock.withLock { _status = newValue } }
    }

    static func reset(status: Int) {
        lock.withLock {
            _status = status
            count = 0
            _lastBody = nil
        }
    }

    static func requestCount() -> Int { lock.withLock { count } }
    static func lastBody() -> String? { lock.withLock { _lastBody } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body = request.httpBody ?? request.httpBodyStream.map { stream -> Data in
            stream.open()
            defer { stream.close() }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            return data
        }
        let code = Self.lock.withLock { () -> Int in
            Self.count += 1
            Self._lastBody = body.flatMap { String(data: $0, encoding: .utf8) }
            return Self._status
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

// MARK: - GatedReplayURLProtocol

/// Holds the first request until the test releases it, then answers 400 — a permanent
/// client error, which `replay()` moves to `rejected` (unless it was cleared meanwhile).
/// Registered per-session through `protocolClasses`, never globally.
private final class GatedReplayURLProtocol: URLProtocol {
    static let firstRequestArrived = DispatchSemaphore(value: 0)
    static let releaseFirstRequest = DispatchSemaphore(value: 0)
    private static let lock = NSLock()
    private static var count = 0

    static func reset() {
        lock.withLock { count = 0 }
    }

    static func requestCount() -> Int {
        lock.withLock { count }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let ordinal = Self.lock.withLock { () -> Int in
            Self.count += 1
            return Self.count
        }
        if ordinal == 1 {
            Self.firstRequestArrived.signal()
            Self.releaseFirstRequest.wait()
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 400, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
