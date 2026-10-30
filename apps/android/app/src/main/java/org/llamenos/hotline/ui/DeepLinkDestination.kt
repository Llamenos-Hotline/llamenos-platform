package org.llamenos.hotline.ui

/**
 * Sealed hierarchy representing deep link navigation destinations
 * parsed from `llamenos://` URIs. Consumed by [LlamenosNavigation]
 * to navigate to the correct screen after authentication.
 */
sealed interface DeepLinkDestination {
    data object Cases : DeepLinkDestination
    data class CaseDetail(val id: String) : DeepLinkDestination
    data object Notes : DeepLinkDestination
    data class NoteDetail(val id: String) : DeepLinkDestination
    data object CallHistory : DeepLinkDestination
    data class CallDetail(val id: String) : DeepLinkDestination
    data object Conversations : DeepLinkDestination
    data class ConversationDetail(val id: String) : DeepLinkDestination
    data object Reports : DeepLinkDestination
    data class ReportDetail(val id: String) : DeepLinkDestination
    data object Settings : DeepLinkDestination
    data object Admin : DeepLinkDestination
    /** The incident view — opened by tapping the content-free incident push. */
    data object Incidents : DeepLinkDestination
}
