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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Upload
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
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
import org.llamenos.hotline.model.BanEntry
import org.llamenos.hotline.model.createdAt
import org.llamenos.hotline.model.id

/**
 * Ban list management tab in the admin panel.
 *
 * Displays all banned identifiers (phone number hashes) with reasons.
 * Admins can add new bans via a FAB, bulk import, and remove existing bans.
 */
@Composable
fun BanListTab(
    viewModel: AdminViewModel,
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()

    // Add ban dialog
    if (uiState.showAddBanDialog) {
        AddBanDialog(
            onDismiss = { viewModel.dismissAddBanDialog() },
            onConfirm = { identifier, reason ->
                viewModel.addBan(identifier, reason)
            },
        )
    }

    // Bulk import dialog
    if (uiState.showBulkImportDialog) {
        BulkImportDialog(
            onDismiss = { viewModel.dismissBulkImportDialog() },
            onConfirm = { phones, reason ->
                viewModel.bulkImportBans(phones, reason)
            },
        )
    }

    Scaffold(
        floatingActionButton = {
            Column(
                horizontalAlignment = Alignment.End,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                // Bulk import mini-FAB
                SmallFloatingActionButton(
                    onClick = { viewModel.showBulkImportDialog() },
                    modifier = Modifier.testTag("bulk-import-fab"),
                    containerColor = MaterialTheme.colorScheme.secondaryContainer,
                ) {
                    Icon(
                        imageVector = Icons.Filled.Upload,
                        contentDescription = stringResource(R.string.ban_list_import),
                    )
                }

                // Add ban FAB
                FloatingActionButton(
                    onClick = { viewModel.showAddBanDialog() },
                    modifier = Modifier.testTag("add-ban-fab"),
                ) {
                    Icon(
                        imageVector = Icons.Filled.Add,
                        contentDescription = stringResource(R.string.ban_list_add),
                    )
                }
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
                uiState.isLoadingBans -> {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .testTag("bans-loading"),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator()
                    }
                }

                uiState.bans.isEmpty() && !uiState.isLoadingBans -> {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(32.dp)
                            .testTag("bans-empty"),
                        contentAlignment = Alignment.Center,
                    ) {
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            Icon(
                                imageVector = Icons.Filled.Block,
                                contentDescription = null,
                                modifier = Modifier.size(48.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                            )
                            Spacer(Modifier.height(12.dp))
                            Text(
                                text = stringResource(R.string.ban_list_empty),
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
                            .testTag("bans-list"),
                    ) {
                        items(
                            items = uiState.bans,
                            key = { it.id },
                        ) { ban ->
                            BanCard(
                                ban = ban,
                                onRemove = { viewModel.removeBan(ban.id) },
                            )
                        }
                    }
                }
            }

            // Error
            if (uiState.bansError != null) {
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp)
                        .testTag("bans-error"),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer,
                    ),
                ) {
                    Text(
                        text = uiState.bansError ?: "",
                        modifier = Modifier.padding(16.dp),
                        color = MaterialTheme.colorScheme.onErrorContainer,
                    )
                }
            }
        }
    }
}

/**
 * Card displaying a single ban entry with a remove button.
 */
@Composable
private fun BanCard(
    ban: BanEntry,
    onRemove: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .testTag("ban-card-${ban.id}"),
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
            Icon(
                imageVector = Icons.Filled.Block,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error,
                modifier = Modifier.size(24.dp),
            )

            Spacer(Modifier.width(12.dp))

            Column(
                modifier = Modifier.weight(1f),
            ) {
                // The server keeps no number for a ban, so the list shows only why and when.
                if (ban.reason.isNotBlank()) {
                    Text(
                        text = ban.reason,
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.testTag("ban-reason-${ban.id}"),
                    )
                    Spacer(Modifier.height(2.dp))
                }

                Text(
                    text = formatBanDate(ban.createdAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                )
            }

            IconButton(
                onClick = onRemove,
                modifier = Modifier.testTag("remove-ban-${ban.id}"),
            ) {
                Icon(
                    imageVector = Icons.Filled.Delete,
                    contentDescription = stringResource(R.string.ban_list_remove),
                    tint = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

/**
 * Dialog for adding a new ban entry.
 */
@Composable
private fun AddBanDialog(
    onDismiss: () -> Unit,
    onConfirm: (phone: String, reason: String?) -> Unit,
) {
    var identifier by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.ban_list_add)) },
        text = {
            Column {
                OutlinedTextField(
                    value = identifier,
                    onValueChange = { identifier = it },
                    label = { Text(stringResource(R.string.ban_list_phone_number)) },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("ban-identifier-input"),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = reason,
                    onValueChange = { reason = it },
                    label = { Text(stringResource(R.string.ban_list_reason)) },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("ban-reason-input"),
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onConfirm(identifier, reason) },
                enabled = identifier.isNotBlank(),
                modifier = Modifier.testTag("confirm-ban-button"),
            ) {
                Text(stringResource(R.string.ban_list_add))
            }
        },
        dismissButton = {
            TextButton(
                onClick = onDismiss,
                modifier = Modifier.testTag("cancel-ban-button"),
            ) {
                Text(stringResource(android.R.string.cancel))
            }
        },
        modifier = Modifier.testTag("add-ban-dialog"),
    )
}

/**
 * Dialog for bulk importing phone numbers to the ban list.
 */
@Composable
private fun BulkImportDialog(
    onDismiss: () -> Unit,
    onConfirm: (phones: List<String>, reason: String?) -> Unit,
) {
    var phonesText by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.ban_list_import_title)) },
        text = {
            Column {
                OutlinedTextField(
                    value = phonesText,
                    onValueChange = { phonesText = it },
                    label = { Text(stringResource(R.string.ban_list_import_hint)) },
                    minLines = 4,
                    maxLines = 8,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("bulk-import-phones-input"),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = reason,
                    onValueChange = { reason = it },
                    label = { Text(stringResource(R.string.ban_list_reason)) },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("bulk-import-reason-input"),
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    val phones = phonesText
                        .lines()
                        .map { it.trim() }
                        .filter { it.isNotBlank() }
                    onConfirm(phones, reason.takeIf { it.isNotBlank() })
                },
                enabled = phonesText.isNotBlank(),
                modifier = Modifier.testTag("confirm-bulk-import"),
            ) {
                Text(stringResource(R.string.ban_list_import))
            }
        },
        dismissButton = {
            TextButton(
                onClick = onDismiss,
                modifier = Modifier.testTag("cancel-bulk-import"),
            ) {
                Text(stringResource(android.R.string.cancel))
            }
        },
        modifier = Modifier.testTag("bulk-import-dialog"),
    )
}

/**
 * Format an ISO 8601 date string for ban display.
 */
private fun formatBanDate(isoDate: String): String {
    return try {
        val parts = isoDate.replace("T", " ").replace("Z", "").split(" ")
        if (parts.size >= 2) {
            val dateParts = parts[0].split("-")
            if (dateParts.size == 3) {
                val months = listOf(
                    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
                    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
                )
                val monthIndex = dateParts[1].toIntOrNull()?.minus(1) ?: 0
                val month = months.getOrElse(monthIndex) { "???" }
                val day = dateParts[2].toIntOrNull() ?: 0
                "$month $day, ${dateParts[0]}"
            } else {
                isoDate
            }
        } else {
            isoDate
        }
    } catch (_: Exception) {
        isoDate
    }
}
