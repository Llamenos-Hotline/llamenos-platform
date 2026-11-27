import Foundation
import XCTest
@testable import Llamenos

/// Destructive admin actions must be confirmed, and the confirmation must run the action it names (#2542).
///
/// Two defects pinned here:
/// - the custom-field swipe action deleted at once, with no confirmation;
/// - the platform-ban row confirmed, then ran the hub-ban removal (`DELETE /api/bans/:id`), so the
///   platform ban stayed. The platform route is `DELETE /api/admin/bans/:id` (routes/platform-bans.ts).
@MainActor
final class AdminViewModelDeleteConfirmationTests: XCTestCase {

    private let testBaseURL = URL(string: "https://hub.example.org")!

    // MARK: - Platform ban

    func testConfirmedPlatformBanRemovalCallsThePlatformRouteNotTheHubRoute() async throws {
        MockURLProtocol.reset()
        defer { MockURLProtocol.reset() }
        MockURLProtocol.requestHandler = { request in
            if request.httpMethod == "GET" {
                return (200, Data(#"{"bans":[],"reentries":[],"total":0}"#.utf8))
            }
            return (200, Data(#"{"ok":true}"#.utf8))
        }

        let viewModel = makeViewModel()
        viewModel.confirmDelete(id: "pban-1", type: .platformBan)
        XCTAssertTrue(viewModel.showDeleteConfirmation)
        XCTAssertTrue(
            MockURLProtocol.capturedRequests.isEmpty,
            "asking for confirmation must not send anything"
        )

        await viewModel.executeDelete()

        let deletes = MockURLProtocol.capturedRequests.filter { $0.httpMethod == "DELETE" }
        XCTAssertEqual(deletes.count, 1, "exactly one removal is sent")
        XCTAssertEqual(deletes.first?.url?.path, "/api/admin/bans/pban-1")
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertFalse(viewModel.showDeleteConfirmation)
        XCTAssertNil(viewModel.pendingDeleteId)
        XCTAssertNil(viewModel.pendingDeleteType)
    }

    func testPlatformBanConfirmationCarriesItsOwnConsequenceCopy() {
        XCTAssertEqual(
            DeleteType.platformBan.confirmTitle,
            NSLocalizedString("platform_bans_remove_confirm_title", comment: "")
        )
        XCTAssertEqual(
            DeleteType.platformBan.confirmMessage,
            NSLocalizedString("platform_bans_remove_confirm_message", comment: "")
        )
        XCTAssertNotEqual(DeleteType.platformBan.confirmMessage, DeleteType.ban.confirmMessage)
    }

    // MARK: - Custom field

    func testCustomFieldIsOnlyDeletedOnceTheDeletionIsConfirmed() async throws {
        MockURLProtocol.reset()
        defer { MockURLProtocol.reset() }
        MockURLProtocol.requestHandler = { _ in (200, Data(#"{"ok":true}"#.utf8)) }

        let viewModel = makeViewModel()
        viewModel.customFields = [Self.field("keep"), Self.field("drop")]

        viewModel.confirmDelete(id: "drop", type: .customField)
        XCTAssertTrue(viewModel.showDeleteConfirmation)
        XCTAssertEqual(viewModel.customFields.map(\.name), ["keep", "drop"], "nothing is removed before confirming")
        XCTAssertTrue(MockURLProtocol.capturedRequests.isEmpty, "nothing is sent before confirming")

        await viewModel.executeDelete()

        XCTAssertEqual(viewModel.customFields.map(\.name), ["keep"])
        let puts = MockURLProtocol.capturedRequests.filter { $0.httpMethod == "PUT" }
        XCTAssertEqual(puts.count, 1)
        XCTAssertEqual(puts.first?.url?.path, "/api/settings/custom-fields")
        XCTAssertFalse(viewModel.showDeleteConfirmation)
    }

    func testCancellingACustomFieldDeletionKeepsTheField() {
        MockURLProtocol.reset()
        defer { MockURLProtocol.reset() }
        MockURLProtocol.requestHandler = { _ in (200, Data(#"{"ok":true}"#.utf8)) }

        let viewModel = makeViewModel()
        viewModel.customFields = [Self.field("keep")]

        viewModel.confirmDelete(id: "keep", type: .customField)
        viewModel.cancelDelete()

        XCTAssertEqual(viewModel.customFields.map(\.name), ["keep"])
        XCTAssertTrue(MockURLProtocol.capturedRequests.isEmpty)
        XCTAssertFalse(viewModel.showDeleteConfirmation)
        XCTAssertNil(viewModel.pendingDeleteType)
    }

    func testCustomFieldConfirmationStatesTheConsequence() {
        XCTAssertEqual(
            DeleteType.customField.confirmMessage,
            NSLocalizedString("custom_fields_delete_confirm", comment: "")
        )
    }

    // MARK: - Helpers

    private static func field(_ name: String) -> CustomFieldsBodyField {
        CustomFieldsBodyField(
            context: "call-notes", label: name, name: name,
            options: nil, order: 0, fieldRequired: false,
            type: .text, visibleToUsers: true
        )
    }

    private func makeViewModel() -> AdminViewModel {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let cryptoService = CryptoService()
        let apiService = APIService(
            cryptoService: cryptoService,
            hubContext: HubContext(),
            sessionConfiguration: config
        )
        apiService.configure(baseURL: testBaseURL)
        return AdminViewModel(apiService: apiService, cryptoService: cryptoService)
    }
}
