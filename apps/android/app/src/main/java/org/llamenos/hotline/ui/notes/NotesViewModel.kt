package org.llamenos.hotline.ui.notes

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
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import org.llamenos.hotline.api.ApiException
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.api.SessionState
import org.llamenos.hotline.crypto.CryptoException
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.model.CustomFieldDef
import org.llamenos.hotline.model.CustomFieldDefinitionType
import org.llamenos.hotline.model.NotePayload
import org.llamenos.hotline.model.NoteRepliesResponse
import org.llamenos.hotline.model.NoteReply
import org.llamenos.hotline.model.NotesListResponse
import org.llamenos.protocol.CreateNoteBody
import org.llamenos.hotline.model.CreateNoteBodyAdminEnvelope
import org.llamenos.hotline.model.CreateNoteBodyAuthorEnvelope
import org.llamenos.protocol.CreateReplyBody
import org.llamenos.hotline.model.CreateReplyBodyReaderEnvelope
import org.llamenos.hotline.model.Note
import org.llamenos.protocol.NoteResponse
import org.llamenos.protocol.RecipientEnvelope
import javax.inject.Inject

/**
 * Decrypted note for UI display. Combines the API response metadata with
 * the decrypted plaintext content.
 */
data class DecryptedNote(
    val id: String,
    val text: String,
    val fields: Map<String, JsonElement>?,
    val authorPubkey: String,
    val callId: String?,
    val conversationId: String?,
    val replyCount: Int = 0,
    val createdAt: String,
    val updatedAt: String?,
)

/**
 * A decrypted note reply for display.
 */
data class DecryptedReply(
    val id: String,
    val authorPubkey: String,
    val text: String,
    val createdAt: String,
)

data class NotesUiState(
    val notes: List<DecryptedNote> = emptyList(),
    val isLoading: Boolean = false,
    val isRefreshing: Boolean = false,
    val error: String? = null,
    val currentPage: Int = 1,
    val totalNotes: Int = 0,
    val hasMorePages: Boolean = false,

    // Search
    val searchQuery: String = "",

    // Note creation / editing
    val customFields: List<CustomFieldDef> = emptyList(),
    val isSaving: Boolean = false,
    val saveError: String? = null,
    val saveSuccess: Boolean = false,

    // Note detail
    val selectedNote: DecryptedNote? = null,
    val isEditing: Boolean = false,

    // Thread replies
    val replies: List<DecryptedReply> = emptyList(),
    val isLoadingReplies: Boolean = false,
    val isSendingReply: Boolean = false,
)

/**
 * ViewModel for the Notes feature.
 *
 * Handles fetching, decrypting, and creating encrypted notes.
 * Each note is encrypted with per-note forward secrecy — a unique random key
 * per note, HPKE-wrapped for the author and each admin.
 *
 * Decryption: find the HPKE envelope matching our encryption pubkey, unwrap the
 * symmetric key via HPKE open, then decrypt the note ciphertext with AES-256-GCM.
 */
@HiltViewModel
class NotesViewModel @Inject constructor(
    private val apiService: ApiService,
    private val cryptoService: CryptoService,
    private val sessionState: SessionState,
    private val activeHubState: ActiveHubState,
) : ViewModel() {

    private val json = Json { ignoreUnknownKeys = true }

    private val _uiState = MutableStateFlow(NotesUiState())
    val uiState: StateFlow<NotesUiState> = _uiState.asStateFlow()

    init {
        activeHubState.activeHubId
            .filterNotNull()
            .onEach { loadNotes() }
            .launchIn(viewModelScope)
    }

    private suspend fun ensureAdminPubkeyLoaded() =
        sessionState.ensureAdminPubkeyLoaded(apiService)

    /**
     * Load notes from the API and decrypt them locally.
     */
    fun loadNotes(page: Int = 1) {
        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isLoading = page == 1 && it.notes.isEmpty(),
                    isRefreshing = page == 1 && it.notes.isNotEmpty(),
                    error = null,
                )
            }

            try {
                val response = apiService.request<NotesListResponse>(
                    "GET",
                    apiService.hp("/api/notes") + "?page=$page&limit=20",
                )

                val decrypted = response.notes.mapNotNull { note ->
                    decryptNote(note)
                }

                _uiState.update {
                    val allNotes = if (page == 1) decrypted else it.notes + decrypted
                    it.copy(
                        notes = allNotes,
                        isLoading = false,
                        isRefreshing = false,
                        currentPage = page,
                        totalNotes = response.total.toInt(),
                        hasMorePages = allNotes.size < response.total.toInt(),
                    )
                }
            } catch (e: ApiException) {
                // Hub-scoped 404/403 means the hub has no notes or user lacks
                // per-hub access — treat as empty rather than a user-facing error.
                if (e.code in listOf(403, 404)) {
                    _uiState.update {
                        it.copy(
                            notes = if (page == 1) emptyList() else it.notes,
                            isLoading = false,
                            isRefreshing = false,
                            totalNotes = 0,
                            hasMorePages = false,
                        )
                    }
                } else {
                    _uiState.update {
                        it.copy(
                            isLoading = false,
                            isRefreshing = false,
                            error = e.message ?: "Failed to load notes",
                        )
                    }
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        isRefreshing = false,
                        error = e.message ?: "Failed to load notes",
                    )
                }
            }
        }
    }

    /**
     * Pull-to-refresh — reload from page 1.
     */
    fun refresh() {
        loadNotes(page = 1)
    }

    /**
     * Load the next page of notes.
     */
    fun loadNextPage() {
        val state = _uiState.value
        if (!state.hasMorePages || state.isLoading) return
        loadNotes(page = state.currentPage + 1)
    }

    /**
     * Load custom field definitions from settings.
     */
    private fun loadCustomFields() {
        viewModelScope.launch {
            try {
                val fields = apiService.request<List<CustomFieldDef>>(
                    "GET",
                    "/api/settings/custom-fields",
                )
                _uiState.update {
                    it.copy(
                        customFields = fields.filter {  field ->
                            field.visibleToUsers && field.context.value in setOf("all", "call-notes", "conversation-notes")
                        },
                    )
                }
            } catch (_: Exception) {
                // Custom fields are optional — silent failure is acceptable
            }
        }
    }

    /**
     * Select a note for detail view.
     */
    fun selectNote(note: DecryptedNote) {
        _uiState.update { it.copy(selectedNote = note) }
    }

    /**
     * Clear the selected note (navigating back from detail).
     */
    fun clearSelectedNote() {
        _uiState.update { it.copy(selectedNote = null) }
    }

    /**
     * Create a new encrypted note.
     *
     * @param text The note body text
     * @param fieldValues Map of custom field name -> value
     */
    fun createNote(text: String, fieldValues: Map<String, String>, conversationId: String? = null, callId: String? = null, transcript: String? = null) {
        viewModelScope.launch {
            _uiState.update { it.copy(isSaving = true, saveError = null, saveSuccess = false) }

            try {
                // Build the payload with custom field values
                val fields: Map<String, JsonElement>? = if (fieldValues.isNotEmpty()) {
                    fieldValues.mapValues { (name, value) ->
                        val fieldDef = _uiState.value.customFields.find { it.name == name }
                        when (fieldDef?.type) {
                            CustomFieldDefinitionType.Checkbox -> JsonPrimitive(value.toBooleanStrictOrNull() ?: false)
                            CustomFieldDefinitionType.Number -> {
                                val num = value.toIntOrNull()
                                if (num != null) JsonPrimitive(num) else JsonPrimitive(value)
                            }
                            else -> JsonPrimitive(value)
                        }
                    }
                } else {
                    null
                }

                // Include transcript in note text if provided
                val noteText = if (transcript != null) {
                    "$text\n\n--- Transcript ---\n$transcript"
                } else {
                    text
                }
                val payload = NotePayload(text = noteText, fields = fields)
                val payloadJson = json.encodeToString(NotePayload.serializer(), payload)

                ensureAdminPubkeyLoaded()
                val authorPubkey = cryptoService.encryptionPubkeyHex
                    ?: throw CryptoException("No encryption key loaded")
                val encrypted = cryptoService.encryptNote(
                    payloadJson,
                    noteRecipientPubkeys(authorPubkey, sessionState.adminPubkeys),
                )

                val (authorEnv, adminEnvs) = splitAuthorAndAdminEnvelopes(
                    encrypted.envelopes,
                    authorPubkey,
                )

                val request = CreateNoteBody(
                    encryptedContent = encrypted.ciphertextHex,
                    authorEnvelope = CreateNoteBodyAuthorEnvelope(
                        enc = authorEnv.hpkeEnvelope.enc,
                        ct = authorEnv.hpkeEnvelope.ct,
                    ),
                    adminEnvelopes = adminEnvs.map { env ->
                        CreateNoteBodyAdminEnvelope(
                            pubkey = env.recipientPubkey,
                            ct = env.hpkeEnvelope.ct,
                            enc = env.hpkeEnvelope.enc,
                        )
                    },
                    conversationID = conversationId,
                    callID = callId,
                )

                apiService.request<NoteResponse>("POST", apiService.hp("/api/notes"), request)

                _uiState.update { it.copy(isSaving = false, saveSuccess = true) }

                // Refresh the notes list to include the new note
                refresh()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isSaving = false,
                        saveError = e.message ?: "Failed to save note",
                    )
                }
            }
        }
    }

    /**
     * Clear the save success flag after the UI has navigated back.
     */
    fun clearSaveSuccess() {
        _uiState.update { it.copy(saveSuccess = false) }
    }

    /**
     * Clear the save error.
     */
    fun clearSaveError() {
        _uiState.update { it.copy(saveError = null) }
    }

    fun dismissError() {
        _uiState.update { it.copy(error = null) }
    }

    // ---- Search ----

    /**
     * Set the search query for filtering notes.
     */
    fun setSearchQuery(query: String) {
        _uiState.update { it.copy(searchQuery = query) }
    }

    /**
     * Get notes filtered by the current search query.
     */
    fun filteredNotes(): List<DecryptedNote> {
        val query = _uiState.value.searchQuery.lowercase()
        if (query.isBlank()) return _uiState.value.notes
        return _uiState.value.notes.filter { note ->
            note.text.lowercase().contains(query)
        }
    }

    // ---- Note Editing ----

    /**
     * Enter edit mode for the selected note.
     */
    fun startEditing() {
        _uiState.update { it.copy(isEditing = true) }
    }

    /**
     * Cancel editing and return to read mode.
     */
    fun cancelEditing() {
        _uiState.update { it.copy(isEditing = false) }
    }

    /**
     * Update an existing note with new encrypted content.
     *
     * @param noteId The note to update
     * @param text Updated plaintext note body
     * @param fieldValues Updated custom field values
     */
    fun updateNote(noteId: String, text: String, fieldValues: Map<String, String>) {
        viewModelScope.launch {
            _uiState.update { it.copy(isSaving = true, saveError = null) }

            try {
                val fields: Map<String, JsonElement>? = if (fieldValues.isNotEmpty()) {
                    fieldValues.mapValues { (name, value) ->
                        val fieldDef = _uiState.value.customFields.find { it.name == name }
                        when (fieldDef?.type) {
                            CustomFieldDefinitionType.Checkbox -> JsonPrimitive(value.toBooleanStrictOrNull() ?: false)
                            CustomFieldDefinitionType.Number -> {
                                val num = value.toIntOrNull()
                                if (num != null) JsonPrimitive(num) else JsonPrimitive(value)
                            }
                            else -> JsonPrimitive(value)
                        }
                    }
                } else {
                    null
                }

                val payload = NotePayload(text = text, fields = fields)
                val payloadJson = json.encodeToString(NotePayload.serializer(), payload)

                ensureAdminPubkeyLoaded()
                val authorPubkey = cryptoService.encryptionPubkeyHex
                    ?: throw CryptoException("No encryption key loaded")
                val encrypted = cryptoService.encryptNote(
                    payloadJson,
                    noteRecipientPubkeys(authorPubkey, sessionState.adminPubkeys),
                )

                val (authorEnv, adminEnvs) = splitAuthorAndAdminEnvelopes(
                    encrypted.envelopes,
                    authorPubkey,
                )

                val request = CreateNoteBody(
                    encryptedContent = encrypted.ciphertextHex,
                    authorEnvelope = CreateNoteBodyAuthorEnvelope(
                        enc = authorEnv.hpkeEnvelope.enc,
                        ct = authorEnv.hpkeEnvelope.ct,
                    ),
                    adminEnvelopes = adminEnvs.map { env ->
                        CreateNoteBodyAdminEnvelope(
                            pubkey = env.recipientPubkey,
                            ct = env.hpkeEnvelope.ct,
                            enc = env.hpkeEnvelope.enc,
                        )
                    },
                )

                apiService.request<NoteResponse>("PUT", apiService.hp("/api/notes/$noteId"), request)

                // Update local state with edited content
                val updatedNote = _uiState.value.selectedNote?.copy(
                    text = text,
                    fields = fields,
                )
                _uiState.update {
                    it.copy(
                        isSaving = false,
                        isEditing = false,
                        selectedNote = updatedNote,
                        saveSuccess = true,
                    )
                }

                refresh()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isSaving = false,
                        saveError = e.message ?: "Failed to update note",
                    )
                }
            }
        }
    }

    // ---- Thread Replies ----

    /**
     * Load replies for the currently selected note.
     */
    fun loadReplies(noteId: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingReplies = true) }
            try {
                val response = apiService.request<NoteRepliesResponse>(
                    "GET", apiService.hp("/api/notes/$noteId/replies"),
                )
                val decrypted = response.replies.mapNotNull { reply ->
                    decryptReply(reply)
                }
                _uiState.update { it.copy(replies = decrypted, isLoadingReplies = false) }
            } catch (_: Exception) {
                _uiState.update { it.copy(isLoadingReplies = false) }
            }
        }
    }

    /**
     * Send an encrypted reply to a note thread.
     */
    fun sendReply(noteId: String, text: String) {
        if (text.isBlank()) return
        viewModelScope.launch {
            _uiState.update { it.copy(isSendingReply = true) }
            try {
                ensureAdminPubkeyLoaded()
                val authorPubkey = cryptoService.encryptionPubkeyHex
                    ?: throw CryptoException("No encryption key loaded")
                val encrypted = cryptoService.encryptNote(
                    text,
                    noteRecipientPubkeys(authorPubkey, sessionState.adminPubkeys),
                )

                val readerEnvelopes = encrypted.envelopes.map { env ->
                    CreateReplyBodyReaderEnvelope(
                        pubkey = env.recipientPubkey,
                        ct = env.hpkeEnvelope.ct,
                        enc = env.hpkeEnvelope.enc,
                    )
                }

                val request = CreateReplyBody(
                    encryptedContent = encrypted.ciphertextHex,
                    readerEnvelopes = readerEnvelopes,
                )

                apiService.requestNoContent("POST", apiService.hp("/api/notes/$noteId/replies"), request)

                // Increment local reply count
                val updatedNote = _uiState.value.selectedNote?.copy(
                    replyCount = (_uiState.value.selectedNote?.replyCount ?: 0) + 1,
                )
                _uiState.update { it.copy(isSendingReply = false, selectedNote = updatedNote) }

                // Reload replies
                loadReplies(noteId)
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isSendingReply = false,
                        saveError = e.message ?: "Failed to send reply",
                    )
                }
            }
        }
    }

    /**
     * Clear replies when leaving note detail.
     */
    fun clearReplies() {
        _uiState.update { it.copy(replies = emptyList()) }
    }

    /**
     * Decrypt a single reply by finding our HPKE envelope and calling CryptoService.
     */
    private suspend fun decryptReply(reply: NoteReply): DecryptedReply? {
        val ourPubkey = cryptoService.encryptionPubkeyHex ?: return null

        for (hpkeEnvelope in noteReadCandidates(reply, ourPubkey)) {
            val payload = try {
                cryptoService.decryptNote(reply.encryptedContent, hpkeEnvelope)
            } catch (_: Exception) {
                null
            }
            if (payload != null) {
                return DecryptedReply(
                    id = reply.id,
                    authorPubkey = reply.authorPubkey,
                    text = payload.text,
                    createdAt = reply.createdAt,
                )
            }
        }
        return null
    }

    /**
     * Decrypt a single note by finding our HPKE envelope and calling CryptoService.
     */
    private suspend fun decryptNote(note: Note): DecryptedNote? {
        val ourPubkey = cryptoService.encryptionPubkeyHex ?: return null

        for (hpkeEnvelope in noteReadCandidates(note, ourPubkey)) {
            val payload = try {
                cryptoService.decryptNote(note.encryptedContent, hpkeEnvelope)
            } catch (_: Exception) {
                null
            }
            if (payload != null) {
                return DecryptedNote(
                    id = note.id,
                    text = payload.text,
                    fields = payload.fields,
                    authorPubkey = note.authorPubkey,
                    callId = note.callID,
                    conversationId = note.conversationID,
                    replyCount = note.replyCount?.toInt() ?: 0,
                    createdAt = note.createdAt,
                    updatedAt = note.updatedAt,
                )
            }
        }
        return null
    }
}

/**
 * Extension to extract a display-friendly string from a [JsonElement] custom field value.
 */
fun JsonElement.displayValue(): String {
    val primitive = this.jsonPrimitive
    return when {
        primitive.booleanOrNull != null -> if (primitive.booleanOrNull == true) "Yes" else "No"
        primitive.contentOrNull != null -> primitive.content
        else -> toString()
    }
}
