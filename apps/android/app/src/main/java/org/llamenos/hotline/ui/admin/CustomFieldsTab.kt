package org.llamenos.hotline.ui.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.List
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R
import org.llamenos.hotline.model.CustomFieldDef
import org.llamenos.protocol.SharedContext
import org.llamenos.hotline.model.CustomFieldDefinitionType

/**
 * Custom fields administration tab in the admin panel.
 *
 * Allows admins to define, edit, and delete custom fields for notes
 * and reports. Fields support text, number, select, checkbox, and textarea types.
 */
@Composable
fun CustomFieldsTab(
    viewModel: AdminViewModel,
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()

    if (uiState.showCreateFieldDialog) {
        CustomFieldDialog(
            existingField = uiState.editingField,
            onDismiss = { viewModel.dismissFieldDialog() },
            onSave = { field -> viewModel.saveCustomField(field) },
        )
    }

    Scaffold(
        floatingActionButton = {
            FloatingActionButton(
                onClick = { viewModel.showCreateFieldDialog() },
                modifier = Modifier.testTag("create-field-fab"),
            ) {
                Icon(
                    imageVector = Icons.Filled.Add,
                    contentDescription = stringResource(R.string.field_add),
                )
            }
        },
        modifier = modifier,
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues),
        ) {
            when {
                uiState.isLoadingFields -> {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .testTag("fields-loading"),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator()
                    }
                }

                uiState.customFields.isEmpty() && !uiState.isLoadingFields -> {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(32.dp)
                            .testTag("fields-empty"),
                        contentAlignment = Alignment.Center,
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Icon(
                                imageVector = Icons.Filled.List,
                                contentDescription = null,
                                modifier = Modifier.size(48.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                            )
                            Spacer(Modifier.height(12.dp))
                            Text(
                                text = stringResource(R.string.custom_fields_empty),
                                style = MaterialTheme.typography.bodyLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }

                else -> {
                    LazyColumn(
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier
                            .fillMaxSize()
                            .testTag("fields-list"),
                    ) {
                        items(
                            items = uiState.customFields,
                            key = { it.id },
                        ) { field ->
                            CustomFieldCard(
                                field = field,
                                onEdit = { viewModel.showEditFieldDialog(field) },
                                onDelete = { viewModel.deleteCustomField(field.id) },
                            )
                        }
                    }
                }
            }

            if (uiState.fieldsError != null) {
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp)
                        .testTag("fields-error"),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer,
                    ),
                ) {
                    Text(
                        text = uiState.fieldsError ?: "",
                        modifier = Modifier.padding(16.dp),
                        color = MaterialTheme.colorScheme.onErrorContainer,
                    )
                }
            }
        }
    }
}

@Composable
private fun CustomFieldCard(
    field: CustomFieldDef,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .testTag("field-card-${field.id}"),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = field.label,
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(4.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    AssistChip(
                        onClick = {},
                        label = { Text(field.type.value, style = MaterialTheme.typography.labelSmall) },
                        modifier = Modifier.height(24.dp),
                    )
                    AssistChip(
                        onClick = {},
                        label = { Text(field.context.value, style = MaterialTheme.typography.labelSmall) },
                        modifier = Modifier.height(24.dp),
                    )
                    if (field.required) {
                        AssistChip(
                            onClick = {},
                            label = { Text(stringResource(R.string.field_required), style = MaterialTheme.typography.labelSmall) },
                            modifier = Modifier.height(24.dp),
                        )
                    }
                }
            }

            IconButton(
                onClick = onEdit,
                modifier = Modifier.testTag("edit-field-${field.id}"),
            ) {
                Icon(Icons.Filled.Edit, contentDescription = stringResource(R.string.field_edit_action))
            }

            IconButton(
                onClick = onDelete,
                modifier = Modifier.testTag("delete-field-${field.id}"),
            ) {
                Icon(Icons.Filled.Delete, contentDescription = stringResource(R.string.field_delete), tint = MaterialTheme.colorScheme.error)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CustomFieldDialog(
    existingField: CustomFieldDef?,
    onDismiss: () -> Unit,
    onSave: (CustomFieldDef) -> Unit,
) {
    var label by remember { mutableStateOf(existingField?.label ?: "") }
    var type by remember { mutableStateOf(existingField?.type?.value ?: "text") }
    var context by remember { mutableStateOf(existingField?.context?.value ?: "all") }
    var required by remember { mutableStateOf(existingField?.required ?: false) }
    var visibleToUsers by remember { mutableStateOf(existingField?.visibleToUsers ?: true) }
    var editableByUsers by remember { mutableStateOf(existingField?.editableByUsers ?: true) }
    val options = remember { mutableStateListOf<String>().apply { existingField?.options?.let { addAll(it) } } }
    var newOption by remember { mutableStateOf("") }
    var typeExpanded by remember { mutableStateOf(false) }
    var contextExpanded by remember { mutableStateOf(false) }

    val fieldTypes = listOf("text", "number", "select", "checkbox", "textarea")
    val contexts = listOf("all", "call-notes", "conversation-notes", "reports")

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (existingField != null) stringResource(R.string.field_edit) else stringResource(R.string.field_add)) },
        text = {
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                OutlinedTextField(
                    value = label,
                    onValueChange = { label = it },
                    label = { Text(stringResource(R.string.field_label)) },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("field-label-input"),
                )

                Spacer(Modifier.height(8.dp))

                // Type selector
                ExposedDropdownMenuBox(
                    expanded = typeExpanded,
                    onExpandedChange = { typeExpanded = it },
                ) {
                    OutlinedTextField(
                        value = type,
                        onValueChange = {},
                        readOnly = true,
                        label = { Text(stringResource(R.string.field_type)) },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = typeExpanded) },
                        modifier = Modifier
                            .fillMaxWidth()
                            .menuAnchor(MenuAnchorType.PrimaryNotEditable)
                            .testTag("field-type-select"),
                    )
                    ExposedDropdownMenu(
                        expanded = typeExpanded,
                        onDismissRequest = { typeExpanded = false },
                    ) {
                        fieldTypes.forEach { t ->
                            DropdownMenuItem(
                                text = { Text(t) },
                                onClick = { type = t; typeExpanded = false },
                            )
                        }
                    }
                }

                Spacer(Modifier.height(8.dp))

                // Context selector
                ExposedDropdownMenuBox(
                    expanded = contextExpanded,
                    onExpandedChange = { contextExpanded = it },
                ) {
                    OutlinedTextField(
                        value = context,
                        onValueChange = {},
                        readOnly = true,
                        label = { Text(stringResource(R.string.field_context)) },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = contextExpanded) },
                        modifier = Modifier
                            .fillMaxWidth()
                            .menuAnchor(MenuAnchorType.PrimaryNotEditable),
                    )
                    ExposedDropdownMenu(
                        expanded = contextExpanded,
                        onDismissRequest = { contextExpanded = false },
                    ) {
                        contexts.forEach { c ->
                            DropdownMenuItem(
                                text = { Text(c) },
                                onClick = { context = c; contextExpanded = false },
                            )
                        }
                    }
                }

                Spacer(Modifier.height(8.dp))

                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.field_required), modifier = Modifier.weight(1f))
                    Switch(
                        checked = required,
                        onCheckedChange = { required = it },
                        modifier = Modifier.testTag("field-required-toggle"),
                    )
                }

                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.field_visible_to_users), modifier = Modifier.weight(1f))
                    Switch(checked = visibleToUsers, onCheckedChange = { visibleToUsers = it })
                }

                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.field_editable_by_users), modifier = Modifier.weight(1f))
                    Switch(checked = editableByUsers, onCheckedChange = { editableByUsers = it })
                }

                // Options for select type
                if (type == "select") {
                    Spacer(Modifier.height(8.dp))
                    Text(stringResource(R.string.field_options), style = MaterialTheme.typography.titleSmall)
                    Spacer(Modifier.height(4.dp))
                    options.forEachIndexed { index, option ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.testTag("field-option-$index"),
                        ) {
                            Text(option, modifier = Modifier.weight(1f))
                            IconButton(onClick = { options.removeAt(index) }) {
                                Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.field_option_remove))
                            }
                        }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(
                            value = newOption,
                            onValueChange = { newOption = it },
                            placeholder = { Text(stringResource(R.string.field_option_new)) },
                            singleLine = true,
                            modifier = Modifier.weight(1f),
                        )
                        Spacer(Modifier.width(8.dp))
                        IconButton(
                            onClick = {
                                if (newOption.isNotBlank()) {
                                    options.add(newOption)
                                    newOption = ""
                                }
                            },
                            modifier = Modifier.testTag("add-field-option"),
                        ) {
                            Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.field_option_add))
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    val slug = label.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-')
                    val fieldType = CustomFieldDefinitionType.entries.find { it.value == type }
                        ?: CustomFieldDefinitionType.Text
                    val fieldContext = SharedContext.entries.find { it.value == context }
                        ?: SharedContext.All
                    val field = CustomFieldDef(
                        id = existingField?.id ?: slug,
                        name = existingField?.name ?: slug,
                        label = label,
                        type = fieldType,
                        required = required,
                        options = if (type == "select") options.toList() else null,
                        validation = null,
                        visibleToUsers = visibleToUsers,
                        editableByUsers = editableByUsers,
                        context = fieldContext,
                        order = existingField?.order ?: 0.0,
                        createdAt = existingField?.createdAt ?: "",
                    )
                    onSave(field)
                },
                enabled = label.isNotBlank(),
                modifier = Modifier.testTag("confirm-field-save"),
            ) {
                Text(stringResource(R.string.action_save))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(android.R.string.cancel))
            }
        },
    )
}
