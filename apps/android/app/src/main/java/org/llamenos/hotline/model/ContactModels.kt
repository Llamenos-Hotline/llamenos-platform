package org.llamenos.hotline.model

import kotlinx.serialization.Serializable

// ── Contact types ───────────────────────────────────────────────────────────
// The generated contact types (ContactListResponseContact, etc.) use the
// full E2EE shape with blind indexes, encrypted PII, envelopes, etc.
// These client types use a simplified plain-text shape for UI display
// after server-side decryption. They remain as client-specific types.

/**
 * Summary of interactions with a single contact.
 */
@Serializable
data class ContactSummary(
    val contactHash: String,
    val last4: String? = null,
    val firstSeen: String,
    val lastSeen: String,
    val callCount: Int = 0,
    val conversationCount: Int = 0,
    val noteCount: Int = 0,
    val reportCount: Int = 0,
)

@Serializable
data class ContactsListResponse(
    val contacts: List<ContactSummary>,
    val total: Int,
)

@Serializable
data class ContactTimelineEvent(
    val id: String,
    val type: String,
    val timestamp: String,
    val summary: String? = null,
    val status: String? = null,
    val duration: Int? = null,
)

@Serializable
data class ContactDetail(
    val contactHash: String,
    val last4: String? = null,
    val firstSeen: String,
    val lastSeen: String,
    val callCount: Int = 0,
    val conversationCount: Int = 0,
    val noteCount: Int = 0,
    val reportCount: Int = 0,
    val contactType: String? = null,
    val linkedCases: List<ContactLinkedCase>? = null,
    val identifiers: List<ContactIdentifier>? = null,
)

@Serializable
data class ContactLinkedCase(
    val id: String,
    val caseNumber: String? = null,
    val entityTypeId: String,
    val statusHash: String,
    val role: String? = null,
    val createdAt: String,
)

@Serializable
data class ContactIdentifier(
    val type: String,
    val hash: String,
    val value: String? = null,
    val addedAt: String? = null,
)
