import Foundation
import XCTest
@testable import Llamenos

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

    // MARK: - isQueueable (identity writes are never replayed)

    func testOrdinaryWritesAreQueueable() {
        XCTAssertTrue(OfflineQueue.isQueueable(method: "POST", path: "/api/notes"))
        XCTAssertTrue(OfflineQueue.isQueueable(method: "patch", path: "/api/notes/abc"))
        XCTAssertFalse(OfflineQueue.isQueueable(method: "GET", path: "/api/notes"))
    }

    func testSigchainAppendIsNotQueueable() {
        let path = "/api/users/\(String(repeating: "a", count: 64))/sigchain"
        XCTAssertTrue(OfflineQueue.isIdentityWrite(path: path))
        XCTAssertFalse(OfflineQueue.isQueueable(method: "POST", path: path))
    }

    func testPukEnvelopeWriteIsNotQueueable() {
        XCTAssertFalse(OfflineQueue.isQueueable(method: "POST", path: "/api/puk/envelopes"))
    }

    func testOtherUserRoutesStayQueueable() {
        XCTAssertTrue(OfflineQueue.isQueueable(method: "PATCH", path: "/api/users/\(String(repeating: "a", count: 64))"))
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
}
