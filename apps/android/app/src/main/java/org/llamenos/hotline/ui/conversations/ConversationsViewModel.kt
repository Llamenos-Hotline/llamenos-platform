package org.llamenos.hotline.ui.conversations

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
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.api.SessionState
import org.llamenos.hotline.api.WebSocketService
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.model.CreateMessageEnvelope
import org.llamenos.hotline.model.DecryptedMessage
import org.llamenos.hotline.model.LlamenosEvent
import org.llamenos.hotline.model.SendMessageRequest
import org.llamenos.hotline.model.User
import org.llamenos.hotline.model.UsersListResponse
import org.llamenos.hotline.model.status
import org.llamenos.protocol.ConversationListResponse
import org.llamenos.protocol.ConversationListResponseConversation
import org.llamenos.protocol.Message
import org.llamenos.protocol.MessageListResponse
import org.llamenos.protocol.RecipientEnvelope
import org.llamenos.protocol.SharedReportResponseStatus
import org.llamenos.protocol.UpdateConversationBody
import javax.inject.Inject

/**
 * Filter options for the conversations list.
 */
enum class ConversationFilter(val queryParam: String) {
    ACTIVE("active"),
    CLOSED("closed"),
    ALL("all"),
}

data class ConversationsUiState(
    val conversations: List<ConversationListResponseConversation> = emptyList(),
    val isLoading: Boolean = false,
    val isRefreshing: Boolean = false,
    val error: String? = null,
    val filter: ConversationFilter = ConversationFilter.ACTIVE,
    val totalConversations: Int = 0,

    // Detail view
    val selectedConversation: ConversationListResponseConversation? = null,
    val messages: List<DecryptedMessage> = emptyList(),
    val isLoadingMessages: Boolean = false,
    val messagesError: String? = null,
    val totalMessages: Int = 0,

    // Sending
    val isSending: Boolean = false,
    val sendError: String? = null,

    // Search
    val searchQuery: String = "",

    // Actions
    val showAssignDialog: Boolean = false,
    val assignableVolunteers: List<User> = emptyList(),
    val isLoadingVolunteers: Boolean = false,
)

/**
 * ViewModel for the Conversations feature.
 *
 * Manages fetching, decrypting, and sending E2EE messages within conversations.
 * Each message is encrypted with per-message forward secrecy: a unique random
 * symmetric key per message, HPKE-wrapped for the assigned volunteer and admins.
 *
 * Subscribes to WebSocket events for real-time message delivery and conversation
 * status updates.
 */
@HiltViewModel
class ConversationsViewModel @Inject constructor(
    private val apiService: ApiService,
    private val cryptoService: CryptoService,
    private val webSocketService: WebSocketService,
    private val sessionState: SessionState,
    private val activeHubState: ActiveHubState,
) : ViewModel() {

    private val _uiState = MutableStateFlow(ConversationsUiState())
    val uiState: StateFlow<ConversationsUiState> = _uiState.asStateFlow()

    init {
        activeHubState.activeHubId
            .filterNotNull()
            .onEach { loadConversations() }
            .launchIn(viewModelScope)
        subscribeToEvents()
    }

    /**
     * Subscribe to real-time conversation and message events from the WebSocket.
     * Guard: skip events from non-active hubs to prevent spurious UI refreshes.
     */
    private fun subscribeToEvents() {
        viewModelScope.launch {
            webSocketService.typedEvents.collect { attributed ->
                if (attributed.hubId.isNotEmpty() && attributed.hubId != activeHubState.activeHubId.value) return@collect
                val event = attributed.event
                when (event) {
                    is LlamenosEvent.MessageNew -> {
                        // If we are viewing this conversation, reload messages
                        val selected = _uiState.value.selectedConversation
                        if (selected != null && selected.id == event.conversationId) {
                            loadMessages(event.conversationId)
                        }
                        // Refresh conversation list for unread count update
                        loadConversations()
                    }
                    is LlamenosEvent.ConversationAssigned,
                    is LlamenosEvent.ConversationClosed -> {
                        loadConversations()
                    }
                    else -> { /* ignore non-conversation events */ }
                }
            }
        }
    }

    /**
     * Load conversations from the API, filtered by the current status filter.
     */
    fun loadConversations() {
        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isLoading = it.conversations.isEmpty(),
                    isRefreshing = it.conversations.isNotEmpty(),
                    error = null,
                )
            }

            try {
                val filter = _uiState.value.filter
                val response = apiService.request<ConversationListResponse>(
                    "GET",
                    apiService.hp("/api/conversations") + "?status=${filter.queryParam}",
                )

                _uiState.update {
                    it.copy(
                        conversations = response.conversations,
                        isLoading = false,
                        isRefreshing = false,
                        totalConversations = response.total.toInt(),
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        isRefreshing = false,
                        error = e.message ?: "Failed to load conversations",
                    )
                }
            }
        }
    }

    /**
     * Change the status filter and reload.
     */
    fun setFilter(filter: ConversationFilter) {
        _uiState.update { it.copy(filter = filter) }
        loadConversations()
    }

    /**
     * Pull-to-refresh.
     */
    fun refresh() {
        loadConversations()
    }

    /**
     * Select a conversation and load its messages.
     */
    fun openConversation(conversation: ConversationListResponseConversation) {
        _uiState.update {
            it.copy(
                selectedConversation = conversation,
                messages = emptyList(),
                isLoadingMessages = true,
                messagesError = null,
            )
        }
        loadMessages(conversation.id)
    }

    /**
     * Clear the selected conversation (navigating back).
     */
    fun closeConversation() {
        _uiState.update {
            it.copy(
                selectedConversation = null,
                messages = emptyList(),
                messagesError = null,
            )
        }
    }

    /**
     * Load and decrypt messages for a conversation.
     */
    fun loadMessages(conversationId: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingMessages = true, messagesError = null) }

            try {
                val response = apiService.request<MessageListResponse>(
                    "GET",
                    apiService.hp("/api/conversations/$conversationId/messages"),
                )

                val channelType = _uiState.value.selectedConversation?.channelType.orEmpty()
                val decrypted = response.messages.mapNotNull { message ->
                    decryptMessage(message, channelType)
                }

                _uiState.update {
                    it.copy(
                        messages = decrypted,
                        isLoadingMessages = false,
                        totalMessages = response.total.toInt(),
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingMessages = false,
                        messagesError = e.message ?: "Failed to load messages",
                    )
                }
            }
        }
    }

    /**
     * Send an encrypted reply in the current conversation.
     *
     * @param text The plaintext message to send
     */
    fun sendReply(text: String) {
        val conversation = _uiState.value.selectedConversation ?: return
        if (text.isBlank()) return

        viewModelScope.launch {
            _uiState.update { it.copy(isSending = true, sendError = null) }

            try {
                sessionState.ensureAdminPubkeyLoaded(apiService)
                // Collect reader pubkeys: self + assigned volunteer (if different) + admins
                val readerPubkeys = buildList {
                    cryptoService.encryptionPubkeyHex?.let { add(it) }
                    conversation.assignedTo?.let { volunteerPub ->
                        if (volunteerPub != cryptoService.encryptionPubkeyHex) add(volunteerPub)
                    }
                    // Include admin pubkeys so admins can decrypt messages
                    sessionState.adminPubkeys.forEach { adminPub ->
                        if (adminPub !in this) add(adminPub)
                    }
                }

                val encrypted = cryptoService.encryptMessage(text, readerPubkeys)

                val envelopes = encrypted.envelopes.map { env ->
                    CreateMessageEnvelope(
                        pubkey = env.pubkey,
                        enc = env.enc,
                        ct = env.ct,
                    )
                }

                val request = SendMessageRequest(
                    encryptedContent = encrypted.ciphertextHex,
                    readerEnvelopes = envelopes,
                )

                apiService.request<Message>(
                    "POST",
                    apiService.hp("/api/conversations/${conversation.id}/messages"),
                    request,
                )

                _uiState.update { it.copy(isSending = false) }

                // Reload messages to include the sent message
                loadMessages(conversation.id)
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isSending = false,
                        sendError = e.message ?: "Failed to send message",
                    )
                }
            }
        }
    }

    /**
     * Clear the send error.
     */
    fun clearSendError() {
        _uiState.update { it.copy(sendError = null) }
    }

    fun dismissError() {
        _uiState.update { it.copy(error = null) }
    }

    // ---- Search ----

    /**
     * Set the search query and filter conversations.
     */
    fun setSearchQuery(query: String) {
        _uiState.update { it.copy(searchQuery = query) }
    }

    /**
     * Get conversations filtered by the current search query.
     */
    fun filteredConversations(): List<ConversationListResponseConversation> {
        val query = _uiState.value.searchQuery.lowercase()
        if (query.isBlank()) return _uiState.value.conversations
        return _uiState.value.conversations.filter { conversation ->
            conversation.contactIdentifierHash.lowercase().contains(query) ||
                    conversation.channelType.lowercase().contains(query)
        }
    }

    // ---- Conversation Actions ----
    //
    // The server has no close/reopen/assign sub-routes. A conversation is changed
    // with `PATCH /conversations/:id` carrying `{ status }` and/or `{ assignedTo }`
    // (`updateConversationBodySchema`); the desktop client does the same. All three
    // used to POST to `/:id/close`, `/:id/reopen` and `/:id/assign`, which 404 (#1730).

    private suspend fun patchSelectedConversation(conversationId: String, body: UpdateConversationBody) {
        apiService.requestNoContent("PATCH", apiService.hp("/api/conversations/$conversationId"), body)
    }

    /**
     * Close/resolve the currently selected conversation.
     */
    fun closeSelectedConversation() {
        val conversation = _uiState.value.selectedConversation ?: return
        viewModelScope.launch {
            try {
                patchSelectedConversation(
                    conversation.id,
                    UpdateConversationBody(status = SharedReportResponseStatus.Closed),
                )
                _uiState.update {
                    it.copy(
                        selectedConversation = it.selectedConversation?.copy(
                            status = SharedReportResponseStatus.Closed,
                        ),
                    )
                }
                loadConversations()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(sendError = e.message ?: "Failed to close conversation")
                }
            }
        }
    }

    /**
     * Reopen a closed conversation.
     */
    fun reopenSelectedConversation() {
        val conversation = _uiState.value.selectedConversation ?: return
        viewModelScope.launch {
            try {
                patchSelectedConversation(
                    conversation.id,
                    UpdateConversationBody(status = SharedReportResponseStatus.Active),
                )
                _uiState.update {
                    it.copy(
                        selectedConversation = it.selectedConversation?.copy(
                            status = SharedReportResponseStatus.Active,
                        ),
                    )
                }
                loadConversations()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(sendError = e.message ?: "Failed to reopen conversation")
                }
            }
        }
    }

    /**
     * Assign the current conversation to a volunteer.
     */
    fun assignConversation(volunteerPubkey: String) {
        val conversation = _uiState.value.selectedConversation ?: return
        viewModelScope.launch {
            _uiState.update { it.copy(showAssignDialog = false) }
            try {
                patchSelectedConversation(
                    conversation.id,
                    UpdateConversationBody(assignedTo = volunteerPubkey),
                )
                _uiState.update {
                    it.copy(
                        selectedConversation = it.selectedConversation?.copy(
                            assignedTo = volunteerPubkey,
                        ),
                    )
                }
                loadConversations()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(sendError = e.message ?: "Failed to assign conversation")
                }
            }
        }
    }

    fun showAssignDialog() {
        _uiState.update { it.copy(showAssignDialog = true) }
        loadUsersForAssign()
    }

    fun dismissAssignDialog() {
        _uiState.update { it.copy(showAssignDialog = false) }
    }

    private fun loadUsersForAssign() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingVolunteers = true) }
            try {
                val response = apiService.request<UsersListResponse>(
                    "GET",
                    "/api/users?limit=100",
                )
                _uiState.update {
                    it.copy(
                        assignableVolunteers = response.users.filter { v -> v.status == "active" },
                        isLoadingVolunteers = false,
                    )
                }
            } catch (_: Exception) {
                _uiState.update { it.copy(isLoadingVolunteers = false) }
            }
        }
    }

    /**
     * Decrypt a single message. CryptoService hands all of the message's reader
     * envelopes to Rust, which opens the one addressed to this device.
     */
    private suspend fun decryptMessage(message: Message, channelType: String): DecryptedMessage? {
        return try {
            val plaintext = cryptoService.decryptMessage(
                encryptedContent = message.encryptedContent,
                envelopes = message.readerEnvelopes.map { RecipientEnvelope(ct = it.ct, enc = it.enc, pubkey = it.pubkey) },
            )

            if (plaintext != null) {
                DecryptedMessage(
                    id = message.id,
                    text = plaintext,
                    direction = message.direction?.value.orEmpty(),
                    channelType = channelType,
                    createdAt = message.createdAt,
                    isRead = message.readAt != null,
                )
            } else {
                null
            }
        } catch (_: Exception) {
            null
        }
    }
}
