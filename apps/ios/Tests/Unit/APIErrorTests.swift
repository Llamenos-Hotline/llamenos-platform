import Foundation
import XCTest
@testable import Llamenos

/// What a volunteer is shown for a failed request (#2207). The body of a refusal is
/// server text — it can name the required permission, or carry a development-only
/// `debug` field — and must never reach the screen or a log line.
final class APIErrorTests: XCTestCase {

    private let body = #"{"error":"Forbidden","required":"calls:read-history","debug":"secret-internal-detail"}"#

    func testStatusMapsToTheLocalizedErrorsKeys() {
        XCTAssertEqual(APIError.messageKey(forStatus: 401), "errors_device_not_registered")
        XCTAssertEqual(APIError.messageKey(forStatus: 403), "errors_forbidden")
        XCTAssertEqual(APIError.messageKey(forStatus: 404), "errors_not_found")
        for status in [0, 408, 429, 500, 502, 503] {
            XCTAssertEqual(APIError.messageKey(forStatus: status), "errors_server_unavailable", "\(status)")
        }
        XCTAssertEqual(APIError.messageKey(forStatus: 422), "error_boundary_title")
    }

    func testEveryMappedKeyResolvesToARealString() {
        for status in [0, 401, 403, 404, 422, 503] {
            let key = APIError.messageKey(forStatus: status)
            let resolved = NSLocalizedString(key, value: "<<missing>>", comment: "")
            XCTAssertNotEqual(resolved, "<<missing>>", "\(key) is not in Localizable.strings — run `bun run i18n:codegen`")
        }
    }

    func testRefusalDescriptionNeverShowsStatusLineOrBody() throws {
        for status in [400, 401, 403, 404, 409, 429, 500, 503] {
            let description = try XCTUnwrap(APIError.requestFailed(statusCode: status, body: body).errorDescription)
            XCTAssertFalse(description.contains("HTTP"), "\(status): \(description)")
            XCTAssertFalse(description.contains("calls:read-history"), "\(status): \(description)")
            XCTAssertFalse(description.contains("secret-internal-detail"), "\(status): \(description)")
            XCTAssertFalse(description.contains("{"), "\(status): \(description)")
        }
    }

    func testDebugDescriptionCarriesTheStatusButNotTheBody() {
        let debug = APIError.requestFailed(statusCode: 403, body: body).debugDescription
        XCTAssertEqual(debug, "HTTP 403")
    }

    func testNetworkAndDecodingFailuresAreLocalizedSentences() throws {
        let network = try XCTUnwrap(APIError.networkError(URLError(.notConnectedToInternet)).errorDescription)
        XCTAssertEqual(network, NSLocalizedString("errors_server_unavailable", comment: ""))

        let decoding = APIError.decodingError(DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "bad shape")))
        let description = try XCTUnwrap(decoding.errorDescription)
        XCTAssertFalse(description.contains("bad shape"))
        XCTAssertTrue(decoding.debugDescription.contains("bad shape"), "the decoder path is still available to logs")
    }
}
