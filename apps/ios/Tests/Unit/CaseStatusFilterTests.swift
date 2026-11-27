import Foundation
import XCTest
@testable import Llamenos

/// #2779, #3114 — a case's status lives in its sealed summary, and a status filter is
/// applied on this device.
///
/// The server pages the candidate set it CAN see (hub, entity type, assignee). These tests
/// serve that set the way the route does — `updated_at DESC`, `page`/`limit`, no knowledge of
/// any status — with REAL sealed summaries, and drive `CaseManagementViewModel` through it.
final class CaseStatusFilterTests: XCTestCase {

    private let testBaseURL = URL(string: "https://hub.example.org")!
    private let hubId = "hub-status-filter"

    override func setUp() {
        super.setUp()
        MockURLProtocol.reset()
        CryptoService().lock()
    }

    override func tearDown() {
        MockURLProtocol.reset()
        UserDefaults.standard.removeObject(forKey: "activeHubId")
        super.tearDown()
    }

    // MARK: - Matches beyond the first page

    /// 230 candidates; only the OLDEST five are `closed`, so none is on the first server page.
    /// Every one of them must be listed, and the filter must never reach the server.
    @MainActor
    func testStatusFilterFindsEveryMatchBeyondTheFirstServerPage() async throws {
        let crypto = try makeDevice()
        let open = try sealedSummary(crypto, status: "open")
        let closed = try sealedSummary(crypto, status: "closed")
        let ids = (0..<230).map { "rec-\($0)" }
        let closedIds = Array(ids.suffix(5))
        let records = ids.map { id in recordJSON(id: id, sealed: closedIds.contains(id) ? closed : open) }
        serve(records: records)

        let viewModel = CaseManagementViewModel(apiService: makeAPIService(crypto), cryptoService: crypto)
        viewModel.statusFilter = "closed"
        await viewModel.loadRecords()

        XCTAssertEqual(viewModel.records.map(\.id), closedIds)
        XCTAssertEqual(viewModel.totalRecords, 5, "the total is the size of the local result")
        XCTAssertFalse(viewModel.filterScanBounded)
        XCTAssertNil(viewModel.recordsLoadError)

        let urls = MockURLProtocol.capturedRequests.compactMap { $0.url?.absoluteString }
        XCTAssertEqual(urls.count, 3, "230 candidates are three server pages of 100; got \(urls)")
        for url in urls {
            XCTAssertFalse(url.contains("closed"), "the status must not travel in a query string: \(url)")
            XCTAssertFalse(url.lowercased().contains("statushash"), "no status field is sent: \(url)")
        }
    }

    @MainActor
    func testStatusFilterPagesTheLocalResult() async throws {
        let crypto = try makeDevice()
        let open = try sealedSummary(crypto, status: "open")
        let closed = try sealedSummary(crypto, status: "closed")
        // 120 candidates, every other one closed: 60 matches, a page of 50 and a page of 10.
        let records = (0..<120).map { recordJSON(id: "rec-\($0)", sealed: $0 % 2 == 0 ? closed : open) }
        serve(records: records)

        let viewModel = CaseManagementViewModel(apiService: makeAPIService(crypto), cryptoService: crypto)
        viewModel.statusFilter = "closed"
        await viewModel.loadRecords()
        XCTAssertEqual(viewModel.records.count, viewModel.pageSize)
        XCTAssertEqual(viewModel.totalRecords, 60)
        XCTAssertTrue(viewModel.hasMorePages)

        viewModel.currentPage = 2
        await viewModel.loadRecords()
        XCTAssertEqual(viewModel.records.count, 10)
        XCTAssertFalse(viewModel.hasMorePages)
    }

    // MARK: - The bound

    /// More candidates than the bound; every match is OLDER than it. The scan stops at the
    /// bound, opens nothing past it, and says so: an empty list here is not "no closed cases".
    @MainActor
    func testScanStopsAtTheBoundAndSaysSo() async throws {
        let crypto = try makeDevice()
        let open = try sealedSummary(crypto, status: "open")
        let records = (0..<(CaseTriage.scanLimit + 300)).map { recordJSON(id: "rec-\($0)", sealed: open) }
        serve(records: records)

        let viewModel = CaseManagementViewModel(apiService: makeAPIService(crypto), cryptoService: crypto)
        viewModel.statusFilter = "closed"

        let started = Date()
        await viewModel.loadRecords()
        let elapsed = Date().timeIntervalSince(started)

        XCTAssertTrue(viewModel.records.isEmpty)
        XCTAssertTrue(viewModel.filterScanBounded, "the scan stopped at the bound with candidates left")
        XCTAssertEqual(
            MockURLProtocol.capturedRequests.count, CaseTriage.scanLimit / CaseTriage.batchSize,
            "no record past the bound is requested"
        )

        // The time to open 2000 summaries (HPKE unwrap + AES-GCM each). On the oldest supported
        // phone this is the number to read; more than about 2 s means tune the batch or the bound.
        let attachment = XCTAttachment(string: "scan of \(CaseTriage.scanLimit) summaries: \(elapsed) s")
        attachment.lifetime = .keepAlways
        add(attachment)
        print("CaseStatusFilterTests: scan of \(CaseTriage.scanLimit) summaries took \(elapsed) s")
        XCTAssertLessThan(elapsed, 30, "a scan that takes this long on a simulator will not be usable on a phone")
    }

    @MainActor
    func testScanIsNotBoundedWhenTheCandidatesEndAtTheBound() async throws {
        let crypto = try makeDevice()
        let open = try sealedSummary(crypto, status: "open")
        serve(records: (0..<CaseTriage.scanLimit).map { recordJSON(id: "rec-\($0)", sealed: open) })

        let viewModel = CaseManagementViewModel(apiService: makeAPIService(crypto), cryptoService: crypto)
        viewModel.statusFilter = "closed"
        await viewModel.loadRecords()

        XCTAssertFalse(viewModel.filterScanBounded, "the candidates end exactly at the bound: nothing was left unchecked")
    }

    // MARK: - Local paging helper

    func testPageOfReturnsTheRequestedSlice() {
        let items = Array(0..<120)
        XCTAssertEqual(CaseTriage.page(of: items, page: 1, pageSize: 50), Array(0..<50))
        XCTAssertEqual(CaseTriage.page(of: items, page: 3, pageSize: 50), Array(100..<120))
        XCTAssertEqual(CaseTriage.page(of: items, page: 4, pageSize: 50), [])
    }

    func testStatusChangeIsSealedWithTheTransitionAndNothingElse() throws {
        let plaintext = try CaseTriage.statusChangePlaintext(previous: "open", next: "closed")
        let change = try XCTUnwrap(StatusChange(plaintext: plaintext))
        XCTAssertEqual(change.previous, "open")
        XCTAssertEqual(change.next, "closed")
    }

    // MARK: - Helpers

    private func makeDevice() throws -> CryptoService {
        let crypto = CryptoService()
        _ = try crypto.generateDeviceKeys(deviceId: UUID().uuidString, pin: "12345678")
        return crypto
    }

    private func makeAPIService(_ cryptoService: CryptoService) -> APIService {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        UserDefaults.standard.removeObject(forKey: "activeHubId")
        let hubContext = HubContext()
        hubContext.setActiveHub(hubId)
        let apiService = APIService(cryptoService: cryptoService, hubContext: hubContext, sessionConfiguration: config)
        apiService.configure(baseURL: testBaseURL)
        return apiService
    }

    /// A summary sealed to this device, the way a client writes one.
    private func sealedSummary(_ crypto: CryptoService, status: String) throws -> (content: String, envelopes: [[String: String]]) {
        let plaintext = #"{"title":"Case","description":"","status":"\#(status)"}"#
        let sealed = try crypto.sealCase(purpose: .summary, plaintext: plaintext, readerPubkeys: [])
        return (sealed.encryptedContent, sealed.envelopes.map { ["pubkey": $0.pubkey, "enc": $0.enc, "ct": $0.ct] })
    }

    private func recordJSON(id: String, sealed: (content: String, envelopes: [[String: String]])) -> [String: Any] {
        [
            "id": id,
            "hubId": hubId,
            "entityTypeId": "et-1",
            "assignedTo": [String](),
            "blindIndexes": [String: String](),
            "contactCount": 0,
            "fileCount": 0,
            "interactionCount": 0,
            "reportCount": 0,
            "eventIds": [String](),
            "reportIds": [String](),
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
            "createdBy": "creator",
            "encryptedSummary": sealed.content,
            "summaryEnvelopes": sealed.envelopes,
        ]
    }

    /// The records route: `page`/`limit` over a fixed candidate list, newest first.
    private func serve(records: [[String: Any]]) {
        MockURLProtocol.requestHandler = { request in
            let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let page = Int(items.first { $0.name == "page" }?.value ?? "1") ?? 1
            let limit = Int(items.first { $0.name == "limit" }?.value ?? "50") ?? 50
            let offset = (page - 1) * limit
            let slice = Array(records.dropFirst(offset).prefix(limit))
            let body: [String: Any] = [
                "records": slice, "total": records.count, "page": page, "limit": limit,
                "hasMore": offset + limit < records.count,
            ]
            return (200, (try? JSONSerialization.data(withJSONObject: body)) ?? Data())
        }
    }
}
