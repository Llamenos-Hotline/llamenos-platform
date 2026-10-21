package org.llamenos.hotline.model

import kotlinx.serialization.Serializable

// ── Generated re-exports ────────────────────────────────────────────────────

typealias AssignReportRequest = org.llamenos.protocol.AssignReportBody
typealias ReportCategoriesResponse = org.llamenos.protocol.ReportCategoriesResponse

// ── Client-specific types ───────────────────────────────────────────────────
// The generated ReportListResponse/ReportResponse use E2EE shapes with
// encrypted content and reader envelopes. These client types use a
// simplified shape for the reports UI.

@Serializable
data class Report(
    val id: String,
    val channelType: String = "reports",
    val contactHash: String? = null,
    val assignedTo: String? = null,
    val status: String,
    val createdAt: String,
    val updatedAt: String? = null,
    val lastMessageAt: String? = null,
    val messageCount: Int = 0,
    val metadata: ReportMetadata? = null,
)

@Serializable
data class ReportMetadata(
    val type: String = "report",
    val reportTitle: String? = null,
    val reportCategory: String? = null,
    val reportTypeId: String? = null,
    val linkedCallId: String? = null,
    val reportId: String? = null,
    val conversionStatus: String? = null,
)

@Serializable
data class ReportsListResponse(
    val conversations: List<Report>,
    val total: Int = 0,
)

@Serializable
data class CreateReportRequest(
    val title: String,
    val category: String? = null,
    val encryptedContent: String,
    val readerEnvelopes: List<ReportEnvelope>,
)

@Serializable
data class ReportEnvelope(
    val pubkey: String,
    val enc: String,
    val ct: String,
)

@Serializable
data class UpdateReportRequest(
    val status: String,
)

// EP06-A3: Atomic report-to-entity conversion — request body is the generated
// org.llamenos.protocol.ConvertFromReportBody.

typealias ConvertFromReportResponse = org.llamenos.protocol.ConvertFromReportResponse
