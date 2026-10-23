import Foundation

// MARK: - Event UI extensions
// Event lists (including sub-events) decode to generated `EventListResponse`
// whose elements are generated `EventListResponseEvent`; single-event
// responses decode to the structurally identical generated `ProtocolEvent`
// (packages/protocol/schemas/events.ts). Links decode to generated
// `CaseEventListResponse` / `ReportEventListResponse`. Only the display
// helpers below are client-side.

extension EventListResponseEvent: Identifiable {}

extension ProtocolEvent: Identifiable {}

// MARK: - Request Bodies
// Create/update bodies are the generated `CreateEventBody` / `UpdateEventBody`.
