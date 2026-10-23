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
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipboardManager
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R
import org.llamenos.hotline.model.Member
import org.llamenos.hotline.model.labelRes
import org.llamenos.hotline.ui.components.SecureWindowEffect

/**
 * Volunteers management tab in the admin panel.
 *
 * Displays a searchable list of all registered volunteers with their
 * display name, truncated pubkey, role badge, and status badge.
 * Admins can add new volunteers via FAB and delete via card actions.
 */
@Composable
fun VolunteersTab(
    viewModel: AdminViewModel,
    onNavigateToVolunteerDetail: (String) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()
    val filteredVolunteers = viewModel.filteredVolunteers()

    // One-time nsec display: consumed from Channel, held only in local ephemeral state.
    // Never stored in ViewModel state — the Channel fires once and the value is gone.
    var pendingNsec by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(viewModel) {
        viewModel.nsecEvent.collect { nsec -> pendingNsec = nsec }
    }

    // Add volunteer dialog
    if (uiState.showAddVolunteerDialog) {
        AddVolunteerDialog(
            onDismiss = { viewModel.dismissAddVolunteerDialog() },
            onConfirm = { name, phone, role ->
                viewModel.createVolunteer(name, phone, role)
            },
        )
    }

    // Delete confirmation dialog
    if (uiState.showDeleteVolunteerDialog != null) {
        val volunteerId = uiState.showDeleteVolunteerDialog!!
        val volunteer = uiState.volunteers.find { it.pubkey == volunteerId }
        AlertDialog(
            onDismissRequest = { viewModel.dismissDeleteVolunteerDialog() },
            title = { Text(stringResource(R.string.users_delete)) },
            text = {
                Text(
                    stringResource(
                        R.string.users_delete_confirm,
                    ),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = { viewModel.deleteVolunteer(volunteerId) },
                    modifier = Modifier.testTag("confirm-delete-volunteer"),
                ) {
                    Text(stringResource(R.string.users_delete))
                }
            },
            dismissButton = {
                TextButton(onClick = { viewModel.dismissDeleteVolunteerDialog() }) {
                    Text(stringResource(android.R.string.cancel))
                }
            },
            modifier = Modifier.testTag("delete-volunteer-dialog"),
        )
    }

    // Created volunteer device key card
    if (uiState.createdVolunteerDeviceKey != null) {
        DeviceKeyDisplayDialog(
            deviceKey = uiState.createdVolunteerDeviceKey!!,
            onDismiss = { viewModel.clearCreatedVolunteerDeviceKey() },
        )
    }

    Scaffold(
        floatingActionButton = {
            FloatingActionButton(
                onClick = { viewModel.showAddVolunteerDialog() },
                modifier = Modifier.testTag("add-volunteer-fab"),
            ) {
                Icon(
                    imageVector = Icons.Filled.Add,
                    contentDescription = stringResource(R.string.users_add),
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
            // Search bar
            OutlinedTextField(
                value = uiState.volunteerSearchQuery,
                onValueChange = { viewModel.setVolunteerSearchQuery(it) },
                placeholder = { Text(stringResource(R.string.search_users)) },
                leadingIcon = {
                    Icon(
                        imageVector = Icons.Filled.Search,
                        contentDescription = null,
                    )
                },
                singleLine = true,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 8.dp)
                    .testTag("volunteer-search"),
            )

            when {
                uiState.isLoadingVolunteers -> {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .testTag("volunteers-loading"),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator()
                    }
                }

                filteredVolunteers.isEmpty() -> {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(32.dp)
                            .testTag("volunteers-empty"),
                        contentAlignment = Alignment.Center,
                    ) {
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            Icon(
                                imageVector = Icons.Filled.Person,
                                contentDescription = null,
                                modifier = Modifier.size(48.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                            )
                            Spacer(Modifier.height(12.dp))
                            Text(
                                text = stringResource(R.string.users_empty),
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
                            .testTag("volunteers-list"),
                    ) {
                        items(
                            items = filteredVolunteers,
                            key = { it.pubkey },
                        ) { volunteer ->
                            VolunteerCard(
                                volunteer = volunteer,
                                onClick = { onNavigateToVolunteerDetail(volunteer.pubkey) },
                                onDelete = { viewModel.showDeleteVolunteerDialog(volunteer.pubkey) },
                            )
                        }
                    }
                }
            }

            // Error
            if (uiState.volunteersError != null) {
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp)
                        .testTag("volunteers-error"),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer,
                    ),
                ) {
                    Text(
                        text = uiState.volunteersError ?: "",
                        modifier = Modifier.padding(16.dp),
                        color = MaterialTheme.colorScheme.onErrorContainer,
                    )
                }
            }
        }
    }
}

/**
 * Card displaying a single volunteer's information with delete action.
 */
@Composable
private fun VolunteerCard(
    volunteer: Member,
    onClick: () -> Unit,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        onClick = onClick,
        modifier = modifier
            .fillMaxWidth()
            .testTag("volunteer-card-${volunteer.pubkey}"),
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
                imageVector = Icons.Filled.Person,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(32.dp),
            )

            Spacer(Modifier.width(12.dp))

            Column(
                modifier = Modifier.weight(1f),
            ) {
                // Display name or "Unnamed"
                Text(
                    text = volunteer.displayName ?: stringResource(R.string.users_unnamed),
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.testTag("volunteer-name-${volunteer.pubkey}"),
                )

                // Truncated pubkey
                Text(
                    text = volunteer.pubkey.take(8) + "..." + volunteer.pubkey.takeLast(8),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.testTag("volunteer-pubkey-${volunteer.pubkey}"),
                )
            }

            Spacer(Modifier.width(4.dp))

            // Role badge
            AssistChip(
                onClick = {},
                label = {
                    Text(
                        text = stringResource(volunteer.role.labelRes),
                        style = MaterialTheme.typography.labelSmall,
                    )
                },
                modifier = Modifier
                    .height(28.dp)
                    .testTag("volunteer-role-${volunteer.pubkey}"),
            )

            Spacer(Modifier.width(4.dp))

            // Status badge
            AssistChip(
                onClick = {},
                label = {
                    Text(
                        text = stringResource(volunteer.status.labelRes),
                        style = MaterialTheme.typography.labelSmall,
                    )
                },
                modifier = Modifier
                    .height(28.dp)
                    .testTag("volunteer-status-${volunteer.pubkey}"),
            )

            // Delete button
            IconButton(
                onClick = onDelete,
                modifier = Modifier.testTag("delete-volunteer-${volunteer.pubkey}"),
            ) {
                Icon(
                    imageVector = Icons.Filled.Delete,
                    contentDescription = stringResource(R.string.users_delete),
                    tint = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

/**
 * Dialog for adding a new volunteer.
 */
@Composable
private fun AddVolunteerDialog(
    onDismiss: () -> Unit,
    onConfirm: (name: String, phone: String, role: String) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.users_add)) },
        text = {
            Column {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("Name") },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("volunteer-name-input"),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = phone,
                    onValueChange = { phone = it },
                    label = { Text("Phone number") },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("volunteer-phone-input"),
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onConfirm(name, phone, "role-volunteer") },
                enabled = name.isNotBlank() && phone.isNotBlank(),
                modifier = Modifier.testTag("confirm-add-volunteer"),
            ) {
                Text(stringResource(R.string.users_add))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(android.R.string.cancel))
            }
        },
        modifier = Modifier.testTag("add-volunteer-dialog"),
    )
}

/**
 * Dialog displaying the one-time device key for a newly created volunteer.
 */
@Composable
private fun DeviceKeyDisplayDialog(
    deviceKey: String,
    onDismiss: () -> Unit,
) {
    val clipboardManager: ClipboardManager = LocalClipboardManager.current

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Volunteer Created") },
        text = {
            Column {
                Text(
                    text = "Share this device key with the volunteer. It will only be shown once.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Spacer(Modifier.height(12.dp))
                Card(
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.tertiaryContainer,
                    ),
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = deviceKey.take(12) + "..." + deviceKey.takeLast(8),
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier
                                .weight(1f)
                                .testTag("created-volunteer-device-key"),
                        )
                        IconButton(
                            onClick = { clipboardManager.setText(AnnotatedString(deviceKey)) },
                            modifier = Modifier.testTag("copy-device-key-button"),
                        ) {
                            Icon(Icons.Filled.ContentCopy, contentDescription = stringResource(R.string.action_copy))
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = onDismiss,
                modifier = Modifier.testTag("dismiss-device-key-dialog"),
            ) {
                Text("Done")
            }
        },
        modifier = Modifier.testTag("device-key-display-dialog"),
    )
}
