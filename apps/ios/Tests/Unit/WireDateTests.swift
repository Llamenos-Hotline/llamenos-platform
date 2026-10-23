import Foundation
import XCTest
@testable import Llamenos

/// Dates on the wire. Every `z.iso.datetime()` in `packages/protocol/schemas/` is
/// generated as a Swift `Date`; a `Date` coded with Foundation's default strategy is a
/// `Double`, and the server only speaks ISO-8601 strings. The merge-queue run that
/// ejected #1653 (`ios-e2e / ui (2)`) failed 21 CaseManagementUITests with
/// "expected Double at .entityTypes[0].fields[0].createdAt" for exactly that reason —
/// no unit test decoded a populated date through the production decoder.
final class WireDateTests: XCTestCase {

    private let decoder = APIService.makeResponseDecoder()

    func testResponseDecoderReadsAnIsoDateWithFractionalSeconds() throws {
        let json = #"{"mergedAt":"2026-10-23T07:08:27.123Z","primaryId":"a","secondaryId":"b"}"#
        let merged = try decoder.decode(MergeContactsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(merged.mergedAt.timeIntervalSince1970, 1_792_739_307.123, accuracy: 0.001)
    }

    func testResponseDecoderReadsAnIsoDateWithoutFractionalSeconds() throws {
        let json = #"{"mergedAt":"2026-10-23T07:08:27Z","primaryId":"a","secondaryId":"b"}"#
        let merged = try decoder.decode(MergeContactsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(merged.mergedAt.timeIntervalSince1970, 1_792_739_307, accuracy: 0.001)
    }

    func testResponseDecoderRejectsAMalformedDateLoudly() {
        let json = #"{"mergedAt":"yesterday","primaryId":"a","secondaryId":"b"}"#
        XCTAssertThrowsError(try decoder.decode(MergeContactsResponse.self, from: Data(json.utf8))) { error in
            XCTAssertTrue(
                APIError.describe(decoding: error).contains("ISO-8601"),
                "the failure should say what was expected, got: \(APIError.describe(decoding: error))"
            )
        }
    }

    /// The shape that took the Cases screen down: a populated `createdAt` on an
    /// entity-type field, nested two levels under the list response.
    func testAnEntityTypeListWithAPopulatedFieldCreatedAtDecodes() throws {
        let field = """
        {"id":"f1","name":"severity","label":"Severity","type":"text","required":false,
         "order":0,"indexable":false,"indexType":"none","accessLevel":"all",
         "visibleToUsers":true,"editableByUsers":true,"hubEditable":true,
         "createdAt":"2026-10-23T07:08:27.123Z"}
        """
        let fieldValue = try decoder.decode(SharedEntityTypeDefinitionField.self, from: Data(field.utf8))
        XCTAssertNotNil(fieldValue.createdAt)
    }

    func testWireEncoderWritesAnIsoDateTheSchemaAccepts() throws {
        let body = ScheduleBlastBody(scheduledAt: Date(timeIntervalSince1970: 1_792_739_307.123))
        let data = try APIService.makeWireEncoder().encode(body)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["scheduledAt"] as? String, "2026-10-23T07:08:27.123Z")
    }

    func testEncodeThenDecodeIsStableToTheMillisecond() throws {
        let original = Date(timeIntervalSince1970: 1_792_739_307.456)
        let data = try APIService.makeWireEncoder().encode(ScheduleBlastBody(scheduledAt: original))
        let back = try decoder.decode(ScheduleBlastBody.self, from: data)
        XCTAssertEqual(back.scheduledAt.timeIntervalSince1970, original.timeIntervalSince1970, accuracy: 0.001)
    }
}
