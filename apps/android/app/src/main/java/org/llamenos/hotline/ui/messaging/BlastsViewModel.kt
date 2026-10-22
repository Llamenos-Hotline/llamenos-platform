package org.llamenos.hotline.ui.messaging

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.hub.ActiveHubState
import javax.inject.Inject

/**
 * Per-status delivery counts the server attaches to a blast (`blastResponseSchema.stats`).
 */
@Serializable
data class BlastStats(
    val totalRecipients: Int = 0,
    val sent: Int = 0,
    val delivered: Int = 0,
    val failed: Int = 0,
    val optedOut: Int = 0,
)

/**
 * One blast, as `GET /api/hubs/:hubId/blasts` returns it (`blastResponseSchema`).
 *
 * Hand-decoded rather than the generated `org.llamenos.protocol.Blast`: `content` is a
 * union — `{body, mediaUrl?}` for one language, or `{<lang>: {body, mediaUrl?}}` — and
 * quicktype emits it as a sealed class with no serializer, which cannot decode either
 * shape. It is kept as raw JSON here and read by [messagePreview].
 */
@Serializable
data class BlastItem(
    val id: String,
    val name: String,
    val content: JsonObject,
    val status: String,
    val targetChannels: List<String> = emptyList(),
    val createdAt: String = "",
    val scheduledAt: String? = null,
    val sentAt: String? = null,
    val stats: BlastStats? = null,
) {
    /** The single-language body, or the first language's body for multi-language content. */
    val messagePreview: String
        get() {
            content.bodyText()?.let { return it }
            return content.values.firstNotNullOfOrNull { (it as? JsonObject)?.bodyText() }.orEmpty()
        }

    val recipientCount: Int get() = stats?.totalRecipients ?: 0

    private fun JsonObject.bodyText(): String? = (this["body"] as? JsonPrimitive)?.takeIf { it.isString }?.content
}

@Serializable
data class BlastsListResponse(
    val blasts: List<BlastItem>,
    val total: Int = 0,
)

/** `{ blast }` — what create, send, schedule and cancel all return. */
@Serializable
data class BlastEnvelope(val blast: BlastItem)

/** Single-language blast content (`singleBlastContentSchema`). */
@Serializable
data class BlastMessageContent(val body: String)

/**
 * Body of `POST /api/hubs/:hubId/blasts` (`createBlastBodySchema`). A blast goes to the
 * hub's opted-in subscribers on the named channels — not to hub members.
 */
@Serializable
data class CreateBlastRequest(
    val name: String,
    val content: BlastMessageContent,
    val channels: List<String>,
)

/** Channels `createBlastBodySchema` accepts, in display order. */
val BLAST_CHANNELS: List<String> = listOf("sms", "whatsapp", "signal")

data class BlastsUiState(
    val blasts: List<BlastItem> = emptyList(),
    val isLoading: Boolean = false,
    val isSaving: Boolean = false,
    val error: String? = null,
    val showCreateDialog: Boolean = false,
)

/**
 * ViewModel for the Blasts screen.
 *
 * Lists the active hub's blasts and creates them against the hub-scoped `/blasts`
 * routes (`apps/worker/routes/blasts.ts`). "Send now" is two calls, exactly as on
 * desktop: create the draft, then `POST /blasts/:id/send`.
 */
@HiltViewModel
class BlastsViewModel @Inject constructor(
    private val apiService: ApiService,
    private val activeHubState: ActiveHubState,
) : ViewModel() {

    private val _uiState = MutableStateFlow(BlastsUiState())
    val uiState: StateFlow<BlastsUiState> = _uiState.asStateFlow()

    init {
        activeHubState.activeHubId
            .filterNotNull()
            .onEach { loadBlasts() }
            .launchIn(viewModelScope)
    }

    fun loadBlasts() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true, error = null) }
            fetchBlasts()
        }
    }

    /**
     * Reload the list without clearing [BlastsUiState.error] — after a mutation, so a failed
     * send stays on screen next to the list that shows what did get stored.
     */
    private suspend fun fetchBlasts() {
        try {
            val response = apiService.request<BlastsListResponse>(
                "GET", apiService.hp("/api/blasts"),
            )
            _uiState.update { it.copy(blasts = response.blasts, isLoading = false) }
        } catch (e: Exception) {
            _uiState.update {
                it.copy(isLoading = false, error = e.message ?: "Failed to load blasts")
            }
        }
    }

    fun showCreateDialog() {
        _uiState.update { it.copy(showCreateDialog = true) }
    }

    fun dismissCreateDialog() {
        _uiState.update { it.copy(showCreateDialog = false) }
    }

    /**
     * Create a blast as a draft, and — when [sendNow] — send it straight away.
     * A failed send leaves the draft listed, so it can be retried from its card.
     */
    fun createBlast(name: String, message: String, channels: List<String>, sendNow: Boolean) {
        viewModelScope.launch {
            _uiState.update { it.copy(isSaving = true, error = null) }
            try {
                val created = apiService.request<BlastEnvelope>(
                    "POST",
                    apiService.hp("/api/blasts"),
                    CreateBlastRequest(
                        name = name.trim(),
                        content = BlastMessageContent(body = message),
                        channels = channels,
                    ),
                )
                _uiState.update { it.copy(showCreateDialog = false) }
                if (sendNow) {
                    apiService.request<BlastEnvelope>(
                        "POST", apiService.hp("/api/blasts/${created.blast.id}/send"),
                    )
                }
            } catch (e: Exception) {
                _uiState.update { it.copy(error = e.message ?: "Failed to create blast") }
            }
            fetchBlasts()
            _uiState.update { it.copy(isSaving = false) }
        }
    }

    /** Send an existing draft. */
    fun sendBlast(id: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(isSaving = true, error = null) }
            try {
                apiService.request<BlastEnvelope>("POST", apiService.hp("/api/blasts/$id/send"))
            } catch (e: Exception) {
                _uiState.update { it.copy(error = e.message ?: "Failed to send blast") }
            }
            fetchBlasts()
            _uiState.update { it.copy(isSaving = false) }
        }
    }
}
