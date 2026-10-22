package org.llamenos.hotline.ui.messaging

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
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Badge
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
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
import androidx.hilt.navigation.compose.hiltViewModel
import org.llamenos.hotline.R
import org.llamenos.hotline.model.Member

/**
 * Blasts screen for sending broadcast messages to volunteers.
 *
 * Lists existing blasts with status badges and provides a FAB
 * to create new blasts with recipient selection.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BlastsScreen(
    onNavigateBack: () -> Unit,
    modifier: Modifier = Modifier,
    viewModel: BlastsViewModel = hiltViewModel(),
) {
    val uiState by viewModel.uiState.collectAsState()

    if (uiState.showCreateDialog) {
        CreateBlastDialog(
            volunteers = uiState.users,
            onDismiss = { viewModel.dismissCreateDialog() },
            onSend = { message, recipientIds, scheduled ->
                viewModel.sendBlast(message, recipientIds, scheduled)
            },
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = stringResource(R.string.blasts_title),
                        modifier = Modifier.testTag("blasts-title"),
                    )
                },
                navigationIcon = {
                    IconButton(
                        onClick = onNavigateBack,
                        modifier = Modifier.testTag("blasts-back"),
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.nav_dashboard),
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        floatingActionButton = {
            FloatingActionButton(
                onClick = { viewModel.showCreateDialog() },
                modifier = Modifier.testTag("create-blast-fab"),
            ) {
                Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.blasts_create))
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
                uiState.isLoading && uiState.blasts.isEmpty() -> {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .testTag("blasts-loading"),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator()
                    }
                }

                uiState.blasts.isEmpty() && !uiState.isLoading -> {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(32.dp)
                            .testTag("blasts-empty"),
                        contentAlignment = Alignment.Center,
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Icon(
                                imageVector = Icons.Filled.Campaign,
                                contentDescription = null,
                                modifier = Modifier.size(48.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                            )
                            Spacer(Modifier.height(12.dp))
                            Text(
                                text = stringResource(R.string.blasts_empty),
                                style = MaterialTheme.typography.bodyLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }

                else -> {
                    LazyColumn(
                        contentPadding = PaddingValues(16.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                        modifier = Modifier
                            .fillMaxSize()
                            .testTag("blasts-list"),
                    ) {
                        items(
                            items = uiState.blasts,
                            key = { it.id },
                        ) { blast ->
                            BlastCard(blast = blast)
                        }
                    }
                }
            }

            if (uiState.error != null) {
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp)
                        .testTag("blasts-error"),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer,
                    ),
                ) {
                    Text(
                        text = uiState.error ?: "",
                        modifier = Modifier.padding(16.dp),
                        color = MaterialTheme.colorScheme.onErrorContainer,
                    )
                }
            }
        }
    }
}

@Composable
private fun BlastCard(
    blast: BlastItem,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .testTag("blast-card-${blast.id}"),
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
                    text = blast.message,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.testTag("blast-message-${blast.id}"),
                )
                Spacer(Modifier.height(4.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Badge(
                        containerColor = when (blast.status) {
                            "sent" -> MaterialTheme.colorScheme.primary
                            "scheduled" -> MaterialTheme.colorScheme.tertiary
                            "failed" -> MaterialTheme.colorScheme.error
                            else -> MaterialTheme.colorScheme.outline
                        },
                        modifier = Modifier.testTag("blast-status-${blast.id}"),
                    ) {
                        Text(
                            text = blast.status.replaceFirstChar { it.uppercase() },
                            style = MaterialTheme.typography.labelSmall,
                        )
                    }
                    AssistChip(
                        onClick = {},
                        label = {
                            Text(
                                if (blast.recipientCount == 1) {
                                    stringResource(R.string.blasts_recipient_count_one)
                                } else {
                                    stringResource(R.string.blasts_recipient_count, blast.recipientCount)
                                },
                                style = MaterialTheme.typography.labelSmall,
                            )
                        },
                        modifier = Modifier.height(24.dp),
                    )
                }
            }

            if (blast.status == "sent") {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.Send,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier
                        .size(20.dp)
                        .testTag("blast-delivery-${blast.id}"),
                )
            } else if (blast.status == "scheduled") {
                Icon(
                    imageVector = Icons.Filled.Schedule,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.tertiary,
                    modifier = Modifier.size(20.dp),
                )
            }
        }
    }
}

@Composable
private fun CreateBlastDialog(
    volunteers: List<Member>,
    onDismiss: () -> Unit,
    onSend: (message: String, recipientIds: List<String>, scheduled: Boolean) -> Unit,
) {
    var message by remember { mutableStateOf("") }
    var selectAll by remember { mutableStateOf(false) }
    val selectedIds = remember { mutableStateListOf<String>() }
    var scheduleForLater by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.blasts_create)) },
        text = {
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                OutlinedTextField(
                    value = message,
                    onValueChange = { message = it },
                    label = { Text(stringResource(R.string.blasts_message_hint)) },
                    maxLines = 4,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("blast-message-input"),
                )

                Spacer(Modifier.height(12.dp))

                Text(
                    text = stringResource(R.string.blasts_recipients),
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.testTag("blast-recipients-label"),
                )

                Spacer(Modifier.height(4.dp))

                // Select all checkbox
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.testTag("blast-select-all"),
                ) {
                    Checkbox(
                        checked = selectAll,
                        onCheckedChange = {
                            selectAll = it
                            if (it) {
                                selectedIds.clear()
                                selectedIds.addAll(volunteers.map { v -> v.pubkey })
                            } else {
                                selectedIds.clear()
                            }
                        },
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.blasts_select_all))
                }

                // Individual volunteer checkboxes
                volunteers.forEach { vol ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.testTag("blast-recipient-${vol.pubkey}"),
                    ) {
                        Checkbox(
                            checked = vol.pubkey in selectedIds,
                            onCheckedChange = { checked ->
                                if (checked) selectedIds.add(vol.pubkey)
                                else selectedIds.remove(vol.pubkey)
                            },
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(vol.displayName ?: vol.pubkey.take(12) + "...")
                    }
                }

                Spacer(Modifier.height(8.dp))

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.testTag("blast-schedule-toggle"),
                ) {
                    Checkbox(
                        checked = scheduleForLater,
                        onCheckedChange = { scheduleForLater = it },
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.blasts_schedule_later))
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onSend(message, selectedIds.toList(), scheduleForLater) },
                enabled = message.isNotBlank() && selectedIds.isNotEmpty(),
                modifier = Modifier.testTag("confirm-blast-send"),
            ) {
                Text(
                    if (scheduleForLater) stringResource(R.string.blasts_schedule)
                    else stringResource(R.string.blasts_send_now),
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(android.R.string.cancel))
            }
        },
    )
}
