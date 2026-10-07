import Foundation
import XCTest
@testable import Llamenos

/// Wire-contract coverage for two fields that a documented-schema projection
/// hid from the iOS client, and that PR #1546 initially dropped along with the
/// hand-written models that had (incorrectly) declared them.
///
/// Both are emitted by the server on every response but were absent from the
/// Zod schema the client decodes, so nothing failed when the client stopped
/// reading them — it just quietly lost the data. These tests decode payloads
/// shaped like the real service output, so re-narrowing either schema fails
/// here instead of silently regressing a screen.
final class WireShapeRestorationTests: XCTestCase {

    /// `settings.getCustomFields` maps every stored column, including
    /// `editableByUsers` (which gates whether the note form renders an input
    /// for a field at all) and `validation`.
    func testCustomFieldsListDecodesEditableByUsersAndValidation() throws {
        let payload = Data("""
        {
          "fields": [
            {
              "id": "cf-1",
              "name": "severity",
              "label": "Severity",
              "type": "number",
              "required": true,
              "validation": { "min": 1, "max": 5 },
              "visibleToUsers": true,
              "editableByUsers": false,
              "context": "call-notes",
              "maxFiles": 1,
              "order": 0,
              "createdAt": "2026-01-01T00:00:00.000Z"
            }
          ]
        }
        """.utf8)

        let response = try JSONDecoder().decode(CustomFieldsListResponse.self, from: payload)
        let field = try XCTUnwrap(response.fields.first)

        XCTAssertEqual(field.id, "cf-1")
        XCTAssertFalse(
            field.editableByUsers,
            "a read-only field must decode as read-only — the note form filters on this"
        )
        XCTAssertTrue(field.visibleToUsers)
        XCTAssertEqual(field.validation?.min, 1)
        XCTAssertEqual(field.validation?.max, 5)
        XCTAssertEqual(field.context, .callNotes)
        XCTAssertTrue(field.isRequired)
    }

    /// `A2pRegistrationService.toPublic` always emits `error`,
    /// `brandSidMasked` and `campaignSidMasked`. `error` is the only thing that
    /// tells an admin *why* a brand or campaign registration failed.
    func testA2pRegistrationStateDecodesFailureReason() throws {
        let payload = Data("""
        {
          "id": "a2p-1",
          "hubId": "hub-1",
          "providerType": "twilio",
          "brandStatus": "failed",
          "campaignStatus": "not_submitted",
          "brandSidMasked": "BN***1234",
          "campaignSidMasked": null,
          "error": "EIN does not match business name on record",
          "submittedAt": "2026-01-01T00:00:00.000Z",
          "createdAt": "2026-01-01T00:00:00.000Z",
          "updatedAt": "2026-01-02T00:00:00.000Z"
        }
        """.utf8)

        let state = try JSONDecoder().decode(A2PRegistrationState.self, from: payload)

        XCTAssertEqual(state.brandStatus, .failed)
        XCTAssertEqual(
            state.error, "EIN does not match business name on record",
            "the failure reason must reach the client or the admin cannot act on it"
        )
        XCTAssertEqual(state.brandSidMasked, "BN***1234")
        XCTAssertNil(state.campaignSidMasked)
    }

    /// `skipped`/`failed` are real server states; decoding must not throw on them.
    func testA2pRegistrationStateDecodesSkippedBrand() throws {
        let payload = Data("""
        {
          "id": "a2p-2",
          "hubId": "hub-1",
          "providerType": "twilio",
          "brandStatus": "skipped",
          "campaignStatus": "skipped",
          "createdAt": "2026-01-01T00:00:00.000Z",
          "updatedAt": "2026-01-01T00:00:00.000Z"
        }
        """.utf8)

        let state = try JSONDecoder().decode(A2PRegistrationState.self, from: payload)
        XCTAssertEqual(state.brandStatus, .skipped)
        XCTAssertNil(state.error)
    }
}
