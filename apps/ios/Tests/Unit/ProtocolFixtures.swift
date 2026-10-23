import Foundation

/// Server-shaped response bodies for the list endpoints the case and event view
/// models decode. These screens decode the generated protocol types, which are
/// exactly as strict as the server's response schemas (`entityTypeListResponseSchema`,
/// `recordListResponseSchema`, `eventListResponseSchema`), so a fixture must carry
/// every field the server always sends — a trimmed body fails to decode.
enum ProtocolFixtures {
    /// One entity type as `GET /api/settings/cms/entity-types` returns it.
    static func entityTypeJSON(id: String, name: String, category: String) -> String {
        """
        {"id":"\(id)","hubId":"hub-1","name":"\(name)","label":"\(name.capitalized)",\
        "labelPlural":"\(name.capitalized)s","description":"","category":"\(category)",\
        "fields":[],"statuses":[{"label":"Open","order":0,"value":"open"}],\
        "defaultStatus":"open","closedStatuses":[],"piiFields":[],"requiredSpecializations":[],\
        "defaultAccessLevel":"hub","allowSubRecords":false,"allowFileAttachments":false,\
        "allowInteractionLinks":false,"autoAssign":false,"autoAssignThreshold":0,\
        "notifyContactsOnStatusChange":false,"numberingEnabled":false,\
        "showInDashboard":false,"showInNavigation":true,"isSystem":false,"isArchived":false,\
        "createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}
        """
    }

    static func entityTypeListJSON(_ entityTypes: [String]) -> String {
        #"{"entityTypes":[\#(entityTypes.joined(separator: ","))]}"#
    }

    static let emptyRecordList = #"{"records":[],"total":0,"page":1,"limit":50,"hasMore":false}"#
    static let emptyEventList = #"{"events":[],"total":0,"page":1,"limit":50,"hasMore":false}"#
}
