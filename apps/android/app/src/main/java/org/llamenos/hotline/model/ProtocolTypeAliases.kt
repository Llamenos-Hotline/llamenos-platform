package org.llamenos.hotline.model

/**
 * Typealiases mapping old quicktype-generated type names to the new deduplicated names.
 *
 * The protocol codegen deduplicates identical anonymous inline schemas into shared
 * top-level types prefixed with "Shared". These aliases preserve backward compatibility
 * so that existing Android code continues to compile without renaming every reference.
 */

import org.llamenos.protocol.SharedCall
import org.llamenos.protocol.SharedHub
import org.llamenos.protocol.SharedNote
import org.llamenos.protocol.SharedStatus
import org.llamenos.protocol.SharedHubDetailResponseStatus
import org.llamenos.protocol.SharedProviderType
import org.llamenos.protocol.SharedCustomFieldDefinitionType
import org.llamenos.protocol.SharedAdminEnvelope
import org.llamenos.protocol.SharedAuthorEnvelope
import org.llamenos.protocol.SharedChannelConfig
import org.llamenos.protocol.SharedClassification
import org.llamenos.protocol.SharedDevice
import org.llamenos.protocol.SharedEventType
import org.llamenos.protocol.SharedField
import org.llamenos.protocol.SharedInteractionType
import org.llamenos.protocol.SharedType

// Call types — ActiveCallsResponse.calls[] and CallHistoryResponse.calls[] both deduplicated to SharedCall
typealias ActiveCallsResponseCall = SharedCall
typealias CallHistoryResponseCall = SharedCall

// Envelope types — all admin/author/reader envelopes with same shape deduplicated
typealias HubKeyEnvelopeResponseEnvelope = SharedAdminEnvelope
typealias CreateNoteBodyAdminEnvelope = SharedAdminEnvelope
typealias CreateNoteBodyAuthorEnvelope = SharedAuthorEnvelope
typealias CreateReplyBodyReaderEnvelope = SharedAdminEnvelope
typealias CreateInteractionBodyContentEnvelope = SharedAdminEnvelope

// Channel config inner type
typealias ChannelConfigClass = SharedChannelConfig

// Evidence/interaction/event enum types
typealias EvidenceClassification = SharedClassification
typealias InteractionType = SharedInteractionType
typealias EventType = SharedEventType

// Field definition types (ReportTypeDefinition.fields[] → SharedField)
typealias ReportTypeDefinitionField = SharedField
typealias JoinFieldType = SharedType

// Device list inner type
typealias DeviceDetailListResponseDevice = SharedDevice

// Hub list inner type — HubListResponse.hubs[] deduplicated to SharedHub
typealias HubListResponseHub = SharedHub

// Hub status enum — HubResponse.status and SharedHub.status use SharedHubDetailResponseStatus
typealias HubStatus = SharedHubDetailResponseStatus

// Provider type enum — deduplicated across telephony schemas
typealias ProviderType = SharedProviderType

// Custom field definition type enum — deduplicated across custom field schemas
typealias CustomFieldDefinitionType = SharedCustomFieldDefinitionType


// Message envelope — SendMessageBody.readerEnvelopes deduplicated to SharedAdminEnvelope
typealias SendMessageBodyReaderEnvelope = SharedAdminEnvelope

// Entity type definition status struct — EntityTypeDefinition.statuses[] deduplicated to SharedStatus
typealias EntityTypeDefinitionStatus = SharedStatus

// Note reply — NoteRepliesResponse.replies deduplicated to SharedNote
typealias Reply = SharedNote
typealias Note = SharedNote
