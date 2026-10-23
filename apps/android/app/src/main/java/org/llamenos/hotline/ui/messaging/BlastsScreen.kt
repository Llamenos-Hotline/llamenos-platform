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
import androidx.compose.material.icons.filled.CheckCircle
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

/**
 * Blasts screen: broadcast messages to the hub's opted-in subscribers.
 *
 * Lists the hub's blasts with status badges (drafts can be sent from their card)
 * and provides a FAB to compose a new blast for one or more channels.
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
            isSaving = uiState.isSaving,
            onDismiss = { viewModel.dismissCreateDialog() },
            onCreate = { name, message, channels, sendNow ->
                viewModel.createBlast(name, message, channels, sendNow)
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
                            BlastCard(
                                blast = blast,
                                sendEnabled = !uiState.isSaving,
                                onSend = { viewModel.sendBlast(blast.id) },
                            )
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
private fun blastStatusLabel(status: String): String = when (status) {
    "draft" -> stringResource(R.string.blasts_status_draft)
    "scheduled" -> stringResource(R.string.blasts_status_scheduled)
    "sending" -> stringResource(R.string.blasts_status_sending)
    "sent" -> stringResource(R.string.blasts_status_sent)
    "cancelled" -> stringResource(R.string.blasts_status_cancelled)
    else -> status
}

@Composable
private fun blastChannelLabel(channel: String): String = when (channel) {
    "sms" -> stringResource(R.string.blast_channel_sms)
    "whatsapp" -> stringResource(R.string.blast_channel_whatsapp)
    "signal" -> stringResource(R.string.blast_channel_signal)
    else -> channel
}

@Composable
private fun BlastCard(
    blast: BlastItem,
    sendEnabled: Boolean,
    onSend: () -> Unit,
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
                    text = blast.name,
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.testTag("blast-name-${blast.id}"),
                )
                Text(
                    text = blast.messagePreview.ifEmpty { stringResource(R.string.blast_no_content) },
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
                            "cancelled" -> MaterialTheme.colorScheme.error
                            else -> MaterialTheme.colorScheme.outline
                        },
                        modifier = Modifier.testTag("blast-status-${blast.id}"),
                    ) {
                        Text(
                            text = blastStatusLabel(blast.status),
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

            when (blast.status) {
                "draft" -> IconButton(
                    onClick = onSend,
                    enabled = sendEnabled,
                    modifier = Modifier.testTag("blast-send-${blast.id}"),
                ) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.Send,
                        contentDescription = stringResource(R.string.blasts_send_now),
                    )
                }
                "sent" -> Icon(
                    imageVector = Icons.Filled.CheckCircle,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier
                        .size(20.dp)
                        .testTag("blast-delivery-${blast.id}"),
                )
                "scheduled" -> Icon(
                    imageVector = Icons.Filled.Schedule,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.tertiary,
                    modifier = Modifier.size(20.dp),
                )
            }
        }
    }
}

/**
 * Compose a blast: a name, one message, and the channels it goes out on. Recipients are
 * the hub's opted-in subscribers on those channels — the server resolves them when the
 * blast is sent, so there is no per-person picker here.
 */
@Composable
private fun CreateBlastDialog(
    isSaving: Boolean,
    onDismiss: () -> Unit,
    onCreate: (name: String, message: String, channels: List<String>, sendNow: Boolean) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var message by remember { mutableStateOf("") }
    val selectedChannels = remember { mutableStateListOf<String>() }
    val canSubmit = !isSaving && name.isNotBlank() && message.isNotBlank() && selectedChannels.isNotEmpty()

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.blasts_create)) },
        text = {
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text(stringResource(R.string.blasts_blast_name)) },
                    placeholder = { Text(stringResource(R.string.blasts_blast_name_placeholder)) },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("blast-name-input"),
                )

                Spacer(Modifier.height(8.dp))

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
                    text = stringResource(R.string.blasts_channels),
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.testTag("blast-channels-label"),
                )

                Spacer(Modifier.height(4.dp))

                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.testTag("blast-select-all"),
                ) {
                    Checkbox(
                        checked = selectedChannels.size == BLAST_CHANNELS.size,
                        onCheckedChange = { checked ->
                            selectedChannels.clear()
                            if (checked) selectedChannels.addAll(BLAST_CHANNELS)
                        },
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.blasts_select_all))
                }

                BLAST_CHANNELS.forEach { channel ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.testTag("blast-channel-$channel"),
                    ) {
                        Checkbox(
                            checked = channel in selectedChannels,
                            onCheckedChange = { checked ->
                                if (checked) selectedChannels.add(channel)
                                else selectedChannels.remove(channel)
                            },
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(blastChannelLabel(channel))
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onCreate(name, message, selectedChannels.toList(), true) },
                enabled = canSubmit,
                modifier = Modifier.testTag("confirm-blast-send"),
            ) {
                Text(stringResource(R.string.blasts_send_now))
            }
        },
        dismissButton = {
            Row {
                TextButton(onClick = onDismiss) {
                    Text(stringResource(android.R.string.cancel))
                }
                TextButton(
                    onClick = { onCreate(name, message, selectedChannels.toList(), false) },
                    enabled = canSubmit,
                    modifier = Modifier.testTag("confirm-blast-draft"),
                ) {
                    Text(stringResource(R.string.blasts_save_draft))
                }
            }
        },
    )
}
