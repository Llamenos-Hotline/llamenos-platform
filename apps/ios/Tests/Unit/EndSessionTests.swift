import Foundation
import XCTest
@testable import Llamenos

// MARK: - LogoutStubURLProtocol

/// Records every request and answers with a canned status. Registered per-session
/// (protocolClasses), never globally, so no other suite's traffic can reach it.
private final class LogoutStubURLProtocol: URLProtocol {
    static var status = 200
    static var requests: [String] = []
    private static let lock = NSLock()

    static func reset(status: Int) {
        lock.lock(); defer { lock.unlock() }
        self.status = status
        requests = []
    }

    static func recorded() -> [String] {
        lock.lock(); defer { lock.unlock() }
        return requests
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.requests.append("\(request.httpMethod ?? "GET") \(request.url?.path ?? "")")
        let status = Self.status
        Self.lock.unlock()

        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data((status == 200 ? #"{"ok":true}"# : #"{"error":"no"}"#).utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

// MARK: - EndSessionTests

/// #2205: iOS made no server call on logout, so the server never learned the session
/// had ended and kept ringing a volunteer who had left. `endSession()` is that call.
@MainActor
final class EndSessionTests: XCTestCase {

    private func makeStubbedAPI() throws -> APIService {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [LogoutStubURLProtocol.self]
        let api = APIService(
            cryptoService: CryptoService(),
            hubContext: HubContext(),
            sessionConfiguration: config
        )
        try api.configure(hubURLString: "https://end-session.test")
        return api
    }

    func testEndSessionPostsToTheLogoutEndpoint() async throws {
        let api = try makeStubbedAPI()
        LogoutStubURLProtocol.reset(status: 200)

        try await api.endSession()

        XCTAssertEqual(LogoutStubURLProtocol.recorded(), ["POST /api/auth/me/logout"])
    }

    /// A refusal must reach the caller: `AppState.logOut()` logs it rather than
    /// treating a logout the server never heard about as a clean one.
    func testEndSessionSurfacesAServerRefusal() async throws {
        let api = try makeStubbedAPI()
        LogoutStubURLProtocol.reset(status: 401)

        do {
            try await api.endSession()
            XCTFail("a rejected logout must throw")
        } catch APIError.requestFailed(let statusCode, _) {
            XCTAssertEqual(statusCode, 401)
        }
    }
}
