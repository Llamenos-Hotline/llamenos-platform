package org.llamenos.hotline.ui.notes

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Save
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.llamenos.hotline.R
import org.llamenos.hotline.model.CustomFieldDef
import org.llamenos.hotline.model.CustomFieldDefinitionType
import org.llamenos.hotline.service.TranscriptionService
import org.llamenos.hotline.ui.components.LoadingOverlay

/**
 * Note creation screen with text input and dynamic custom fields.
 *
 * Custom fields are defined by admins and fetched from the settings API.
 * The screen renders appropriate input widgets based on each field's type:
 * text, number, select (dropdown), checkbox (switch), textarea.
 *
 * On save, the note payload is encrypted client-side with per-note forward
 * secrecy before being sent to the API.
 *
 * @param viewModel Shared NotesViewModel handling encryption and API calls
 * @param conversationId The conversation the note is about, if any
 * @param callId The call the note is about, if any. A note needs one or the other: the
 *   server refuses a note about nothing, so Save stays disabled without either.
 * @param hubId The hub [callId] belongs to; null files the note to the active hub
 * @param onNavigateBack Callback after successful save or user cancellation
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NoteCreateScreen(
    viewModel: NotesViewModel,
    onNavigateBack: () -> Unit,
    conversationId: String? = null,
    callId: String? = null,
    hubId: String? = null,
    transcriptionService: TranscriptionService? = null,
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()
    var noteText by remember { mutableStateOf("") }
    val fieldValues = remember { mutableStateMapOf<String, String>() }
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    var attachedTranscript by remember { mutableStateOf<String?>(null) }

    // Navigate back on successful save
    LaunchedEffect(uiState.saveSuccess) {
        if (uiState.saveSuccess) {
            viewModel.clearSaveSuccess()
            onNavigateBack()
        }
    }

    // Show error in snackbar
    LaunchedEffect(uiState.saveError) {
        uiState.saveError?.let { error ->
            scope.launch {
                snackbarHostState.showSnackbar(error)
                viewModel.clearSaveError()
            }
        }
    }

    Box(modifier = modifier) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = {
                        Text(
                            text = stringResource(R.string.notes_create),
                            modifier = Modifier.testTag("note-create-title"),
                        )
                    },
                    navigationIcon = {
                        IconButton(
                            onClick = onNavigateBack,
                            modifier = Modifier.testTag("note-create-back"),
                        ) {
                            Icon(
                                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = stringResource(R.string.nav_notes),
                            )
                        }
                    },
                    actions = {
                        IconButton(
                            onClick = {
                                if (noteText.isNotBlank()) {
                                    viewModel.createNote(noteText.trim(), fieldValues.toMap(), conversationId, callId, attachedTranscript, hubId)
                                }
                            },
                            enabled = noteText.isNotBlank() && !uiState.isSaving && (callId != null || conversationId != null),
                            modifier = Modifier.testTag("note-save-button"),
                        ) {
                            Icon(
                                imageVector = Icons.Filled.Save,
                                contentDescription = stringResource(R.string.notes_save),
                            )
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.surface,
                    ),
                )
            },
            snackbarHost = { SnackbarHost(snackbarHostState) },
        ) { paddingValues ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(paddingValues)
                    .verticalScroll(rememberScrollState())
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                // Main note text input
                OutlinedTextField(
                    value = noteText,
                    onValueChange = { noteText = it },
                    label = { Text(stringResource(R.string.notes_text_hint)) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(200.dp)
                        .testTag("note-text-input"),
                    maxLines = 10,
                    singleLine = false,
                )

                // Transcript attachment section
                if (transcriptionService != null) {
                    val finalTranscript by transcriptionService.finalTranscript.collectAsState()
                    val liveTranscript by transcriptionService.liveTranscript.collectAsState()
                    val availableTranscript = finalTranscript.ifEmpty { liveTranscript }

                    if (availableTranscript.isNotEmpty()) {
                        if (attachedTranscript != null) {
                            // Show attached transcript
                            Surface(
                                shape = RoundedCornerShape(8.dp),
                                tonalElevation = 1.dp,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .testTag("attached-transcript"),
                            ) {
                                Column(modifier = Modifier.padding(12.dp)) {
                                    Row(
                                        modifier = Modifier.fillMaxWidth(),
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.SpaceBetween,
                                    ) {
                                        Row(
                                            verticalAlignment = Alignment.CenterVertically,
                                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                                        ) {
                                            Icon(
                                                imageVector = Icons.Filled.GraphicEq,
                                                contentDescription = null,
                                                tint = MaterialTheme.colorScheme.primary,
                                                modifier = Modifier.size(20.dp),
                                            )
                                            Text(
                                                text = stringResource(R.string.transcription_transcript_label),
                                                style = MaterialTheme.typography.titleSmall,
                                            )
                                        }
                                        IconButton(
                                            onClick = { attachedTranscript = null },
                                            modifier = Modifier
                                                .size(24.dp)
                                                .testTag("remove-transcript"),
                                        ) {
                                            Icon(
                                                imageVector = Icons.Filled.Close,
                                                contentDescription = stringResource(R.string.a11y_remove_item),
                                                modifier = Modifier.size(16.dp),
                                            )
                                        }
                                    }
                                    Text(
                                        text = attachedTranscript ?: "",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 5,
                                        modifier = Modifier.padding(top = 4.dp),
                                    )
                                }
                            }
                        } else {
                            // Attach transcript button
                            OutlinedButton(
                                onClick = { attachedTranscript = availableTranscript },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .testTag("attach-transcript"),
                            ) {
                                Icon(
                                    imageVector = Icons.Filled.GraphicEq,
                                    contentDescription = null,
                                    modifier = Modifier
                                        .size(18.dp)
                                        .padding(end = 4.dp),
                                )
                                Text(stringResource(R.string.transcription_attach_to_note))
                            }
                        }
                    }
                }

                // Dynamic custom fields
                uiState.customFields.forEach { field ->
                    if (field.editableByUsers) {
                        CustomFieldInput(
                            definition = field,
                            value = fieldValues[field.name] ?: "",
                            onValueChange = { fieldValues[field.name] = it },
                        )
                    }
                }
            }
        }

        // Loading overlay during save
        LoadingOverlay(
            isLoading = uiState.isSaving,
            message = stringResource(R.string.notes_saving),
        )
    }
}

/**
 * Renders the appropriate input widget for a custom field definition.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CustomFieldInput(
    definition: CustomFieldDef,
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    when (definition.type) {
        CustomFieldDefinitionType.Text -> {
            OutlinedTextField(
                value = value,
                onValueChange = onValueChange,
                label = { Text(definition.label) },
                singleLine = true,
                isError = definition.required && value.isBlank(),
                modifier = modifier
                    .fillMaxWidth()
                    .testTag("field-${definition.name}"),
            )
        }

        CustomFieldDefinitionType.Number -> {
            OutlinedTextField(
                value = value,
                onValueChange = { newValue ->
                    // Only allow numeric input
                    if (newValue.isEmpty() || newValue.all { it.isDigit() || it == '-' || it == '.' }) {
                        onValueChange(newValue)
                    }
                },
                label = { Text(definition.label) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                isError = definition.required && value.isBlank(),
                modifier = modifier
                    .fillMaxWidth()
                    .testTag("field-${definition.name}"),
            )
        }

        CustomFieldDefinitionType.Select -> {
            var expanded by remember { mutableStateOf(false) }

            ExposedDropdownMenuBox(
                expanded = expanded,
                onExpandedChange = { expanded = it },
                modifier = modifier
                    .fillMaxWidth()
                    .testTag("field-${definition.name}"),
            ) {
                OutlinedTextField(
                    value = value,
                    onValueChange = {},
                    readOnly = true,
                    label = { Text(definition.label) },
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
                    isError = definition.required && value.isBlank(),
                    modifier = Modifier
                        .menuAnchor(MenuAnchorType.PrimaryNotEditable)
                        .fillMaxWidth(),
                )
                ExposedDropdownMenu(
                    expanded = expanded,
                    onDismissRequest = { expanded = false },
                ) {
                    definition.options?.forEach { option ->
                        DropdownMenuItem(
                            text = { Text(option) },
                            onClick = {
                                onValueChange(option)
                                expanded = false
                            },
                            modifier = Modifier.testTag("field-option-${definition.name}-$option"),
                        )
                    }
                }
            }
        }

        CustomFieldDefinitionType.Checkbox -> {
            Row(
                modifier = modifier
                    .fillMaxWidth()
                    .testTag("field-${definition.name}"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = definition.label,
                    style = MaterialTheme.typography.bodyLarge,
                )
                Switch(
                    checked = value.toBooleanStrictOrNull() ?: false,
                    onCheckedChange = { onValueChange(it.toString()) },
                    modifier = Modifier.testTag("field-switch-${definition.name}"),
                )
            }
        }

        CustomFieldDefinitionType.Textarea -> {
            OutlinedTextField(
                value = value,
                onValueChange = onValueChange,
                label = { Text(definition.label) },
                modifier = modifier
                    .fillMaxWidth()
                    .height(120.dp)
                    .testTag("field-${definition.name}"),
                maxLines = 5,
                singleLine = false,
                isError = definition.required && value.isBlank(),
            )
        }

        else -> {
            // Fallback for unknown field types — render as plain text input
            OutlinedTextField(
                value = value,
                onValueChange = onValueChange,
                label = { Text(definition.label) },
                singleLine = true,
                modifier = modifier
                    .fillMaxWidth()
                    .testTag("field-${definition.name}"),
            )
        }
    }
}
