package org.llamenos.hotline.ui.conversations

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MarkChatRead
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.NoteAdd
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Sms
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.llamenos.hotline.R
import org.llamenos.hotline.model.DecryptedMessage
import org.llamenos.hotline.model.displayName
import org.llamenos.hotline.model.role
import org.llamenos.protocol.SharedReportResponseStatus

/**
 * Conversation detail screen showing message bubbles and reply input.
 *
 * Messages are displayed as chat bubbles: inbound messages on the left with
 * surface color, outbound messages on the right with primary color. The screen
 * auto-scrolls to the bottom when new messages arrive.
 *
 * @param viewModel Shared ConversationsViewModel with the selected conversation
 * @param onNavigateBack Callback to navigate back to the conversations list
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationDetailScreen(
    viewModel: ConversationsViewModel,
    onNavigateBack: () -> Unit,
    onNavigateToNoteCreate: (conversationId: String) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()
    val conversation = uiState.selectedConversation
    var replyText by rememberSaveable { mutableStateOf("") }
    val listState = rememberLazyListState()
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    // Auto-scroll to bottom when messages change
    LaunchedEffect(uiState.messages.size) {
        if (uiState.messages.isNotEmpty()) {
            listState.animateScrollToItem(uiState.messages.size - 1)
        }
    }

    // Show send error as snackbar
    LaunchedEffect(uiState.sendError) {
        val error = uiState.sendError
        if (error != null) {
            scope.launch {
                snackbarHostState.showSnackbar(error)
                viewModel.clearSendError()
            }
        }
    }

    // Assign dialog
    if (uiState.showAssignDialog) {
        AlertDialog(
            onDismissRequest = { viewModel.dismissAssignDialog() },
            title = {
                Text(
                    stringResource(R.string.conversations_assign_title),
                    modifier = Modifier.testTag("assign-dialog-title"),
                )
            },
            text = {
                Column(
                    modifier = Modifier.testTag("assign-dialog-content"),
                ) {
                    Text(
                        text = stringResource(R.string.conversations_assign_desc),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(12.dp))

                    if (uiState.isLoadingVolunteers) {
                        Box(
                            modifier = Modifier.fillMaxWidth(),
                            contentAlignment = Alignment.Center,
                        ) {
                            CircularProgressIndicator(modifier = Modifier.size(24.dp))
                        }
                    } else if (uiState.assignableVolunteers.isEmpty()) {
                        Text(
                            text = stringResource(R.string.conversations_no_users),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else {
                        uiState.assignableVolunteers.forEach { volunteer ->
                            Card(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 2.dp)
                                    .testTag("assign-volunteer-${volunteer.pubkey}"),
                                onClick = {
                                    viewModel.assignConversation(volunteer.pubkey)
                                },
                                colors = CardDefaults.cardColors(
                                    containerColor = if (conversation?.assignedTo == volunteer.pubkey) {
                                        MaterialTheme.colorScheme.primaryContainer
                                    } else {
                                        MaterialTheme.colorScheme.surfaceVariant
                                    },
                                ),
                            ) {
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(12.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text(
                                            text = volunteer.displayName ?: volunteer.pubkey.take(12) + "\u2026",
                                            style = MaterialTheme.typography.bodyMedium,
                                        )
                                        Text(
                                            text = volunteer.role.replaceFirstChar { it.uppercase() },
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = {
                TextButton(
                    onClick = { viewModel.dismissAssignDialog() },
                    modifier = Modifier.testTag("assign-dialog-dismiss"),
                ) {
                    Text(stringResource(android.R.string.cancel))
                }
            },
            modifier = Modifier.testTag("assign-dialog"),
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (conversation != null) {
                            Icon(
                                imageVector = channelIconForType(conversation.channelType),
                                contentDescription = null,
                                modifier = Modifier.size(20.dp),
                            )
                            Spacer(Modifier.width(8.dp))
                        }
                        Text(
                            text = if (conversation != null) {
                                channelLabelForType(conversation.channelType)
                            } else {
                                stringResource(R.string.conversations_title)
                            },
                            modifier = Modifier.testTag("conversation-detail-title"),
                        )
                    }
                },
                navigationIcon = {
                    IconButton(
                        onClick = {
                            viewModel.closeConversation()
                            onNavigateBack()
                        },
                        modifier = Modifier.testTag("conversation-detail-back"),
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.nav_dashboard),
                        )
                    }
                },
                actions = {
                    if (conversation != null) {
                        // Add note button
                        IconButton(
                            onClick = { onNavigateToNoteCreate(conversation.id) },
                            modifier = Modifier.testTag("conversation-add-note-button"),
                        ) {
                            Icon(
                                imageVector = Icons.Filled.NoteAdd,
                                contentDescription = stringResource(R.string.conversations_add_note),
                            )
                        }

                        // Assign button
                        IconButton(
                            onClick = { viewModel.showAssignDialog() },
                            modifier = Modifier.testTag("assign-conversation-button"),
                        ) {
                            Icon(
                                imageVector = Icons.Filled.PersonAdd,
                                contentDescription = stringResource(R.string.conversations_assign),
                            )
                        }

                        // Close or reopen button
                        if (conversation.status == SharedReportResponseStatus.Closed) {
                            IconButton(
                                onClick = { viewModel.reopenSelectedConversation() },
                                modifier = Modifier.testTag("reopen-conversation-button"),
                            ) {
                                Icon(
                                    imageVector = Icons.Filled.Refresh,
                                    contentDescription = stringResource(R.string.conversations_reopen),
                                )
                            }
                        } else {
                            IconButton(
                                onClick = { viewModel.closeSelectedConversation() },
                                modifier = Modifier.testTag("close-conversation-button"),
                            ) {
                                Icon(
                                    imageVector = Icons.Filled.Close,
                                    contentDescription = stringResource(R.string.conversations_close),
                                    tint = MaterialTheme.colorScheme.error,
                                )
                            }
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
        modifier = modifier.imePadding(),
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues),
        ) {
            // E2EE indicator
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
                    .padding(horizontal = 16.dp, vertical = 6.dp)
                    .testTag("e2ee-indicator"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
            ) {
                Icon(
                    imageVector = Icons.Filled.Lock,
                    contentDescription = null,
                    modifier = Modifier.size(12.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.width(4.dp))
                Text(
                    text = stringResource(R.string.conversations_e2ee),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            // Messages area
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
            ) {
                when {
                    uiState.isLoadingMessages && uiState.messages.isEmpty() -> {
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .testTag("messages-loading"),
                            contentAlignment = Alignment.Center,
                        ) {
                            Column(
                                horizontalAlignment = Alignment.CenterHorizontally,
                            ) {
                                CircularProgressIndicator()
                                Spacer(Modifier.height(8.dp))
                                Text(
                                    text = stringResource(R.string.conversations_decrypting),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }

                    uiState.messages.isEmpty() && !uiState.isLoadingMessages -> {
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .testTag("messages-empty"),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                text = stringResource(R.string.conversations_empty),
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }

                    else -> {
                        LazyColumn(
                            state = listState,
                            contentPadding = PaddingValues(
                                horizontal = 16.dp,
                                vertical = 8.dp,
                            ),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                            modifier = Modifier
                                .fillMaxSize()
                                .testTag("messages-list"),
                        ) {
                            items(
                                items = uiState.messages,
                                key = { it.id },
                            ) { message ->
                                MessageBubble(message = message)
                            }
                        }
                    }
                }

                // Messages error
                if (uiState.messagesError != null) {
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp)
                            .align(Alignment.BottomCenter)
                            .testTag("messages-error"),
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.errorContainer,
                        ),
                    ) {
                        Text(
                            text = uiState.messagesError ?: "",
                            modifier = Modifier.padding(16.dp),
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
            }

            // Reply input area
            HorizontalDivider()

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 8.dp)
                    .testTag("reply-input-row"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = replyText,
                    onValueChange = { replyText = it },
                    placeholder = {
                        Text(stringResource(R.string.conversations_reply_hint))
                    },
                    modifier = Modifier
                        .weight(1f)
                        .testTag("reply-text-input"),
                    maxLines = 4,
                    shape = RoundedCornerShape(24.dp),
                )

                Spacer(Modifier.width(8.dp))

                IconButton(
                    onClick = {
                        if (replyText.isNotBlank() && !uiState.isSending) {
                            viewModel.sendReply(replyText.trim())
                            replyText = ""
                        }
                    },
                    enabled = replyText.isNotBlank() && !uiState.isSending,
                    modifier = Modifier.testTag("send-button"),
                ) {
                    if (uiState.isSending) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(24.dp),
                            strokeWidth = 2.dp,
                        )
                    } else {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.Send,
                            contentDescription = stringResource(R.string.conversation_send),
                            tint = if (replyText.isNotBlank()) {
                                MaterialTheme.colorScheme.primary
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f)
                            },
                        )
                    }
                }
            }
        }
    }
}

/**
 * Chat bubble for a single message.
 *
 * Inbound messages appear on the left with surface color.
 * Outbound messages appear on the right with primary color.
 */
@Composable
private fun MessageBubble(
    message: DecryptedMessage,
    modifier: Modifier = Modifier,
) {
    val isOutbound = message.direction == "outbound"

    Row(
        modifier = modifier
            .fillMaxWidth()
            .testTag("message-bubble-${message.id}"),
        horizontalArrangement = if (isOutbound) Arrangement.End else Arrangement.Start,
    ) {
        Box(
            modifier = Modifier
                .widthIn(max = 280.dp)
                .clip(
                    RoundedCornerShape(
                        topStart = 16.dp,
                        topEnd = 16.dp,
                        bottomStart = if (isOutbound) 16.dp else 4.dp,
                        bottomEnd = if (isOutbound) 4.dp else 16.dp,
                    ),
                )
                .background(
                    color = if (isOutbound) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.surfaceVariant
                    },
                )
                .padding(12.dp),
        ) {
            Column {
                Text(
                    text = message.text,
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (isOutbound) {
                        MaterialTheme.colorScheme.onPrimary
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                    modifier = Modifier.testTag("message-text-${message.id}"),
                )

                Spacer(Modifier.height(4.dp))

                Text(
                    text = formatMessageTime(message.createdAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = if (isOutbound) {
                        MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.7f)
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)
                    },
                    modifier = Modifier
                        .align(Alignment.End)
                        .testTag("message-time-${message.id}"),
                )
            }
        }
    }
}

/**
 * Map a channel type string to its Material icon for the detail screen.
 */
private fun channelIconForType(channelType: String) = when (channelType) {
    "sms" -> Icons.Filled.Sms
    "whatsapp" -> Icons.Filled.Chat
    "signal" -> Icons.Filled.MarkChatRead
    else -> Icons.Filled.Chat
}

/**
 * Map a channel type string to its display label for the detail screen.
 */
private fun channelLabelForType(channelType: String) = when (channelType) {
    "sms" -> "SMS"
    "whatsapp" -> "WhatsApp"
    "signal" -> "Signal"
    else -> channelType.replaceFirstChar { it.uppercase() }
}

/**
 * Format an ISO 8601 date string for message timestamp display.
 */
private fun formatMessageTime(isoDate: String): String {
    return try {
        val parts = isoDate.replace("T", " ").replace("Z", "").split(" ")
        if (parts.size >= 2) parts[1].take(5) else isoDate
    } catch (_: Exception) {
        isoDate
    }
}
