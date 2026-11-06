package org.llamenos.hotline.ui.conversations

import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.MarkChatRead
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Sms
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R
import org.llamenos.hotline.util.DateFormatUtils
import org.llamenos.protocol.SharedConversation
import org.llamenos.protocol.SharedReportResponseStatus

/**
 * Conversations list screen showing all E2EE messaging conversations.
 *
 * Displays conversations grouped by status with filter chips at the top.
 * Each conversation card shows the channel type icon, contact hash preview,
 * last message time, and unread badge. Tap to open the conversation detail.
 *
 * @param viewModel Shared ConversationsViewModel (scoped to the nav graph)
 * @param onNavigateToDetail Callback to navigate to conversation detail screen
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationsScreen(
    viewModel: ConversationsViewModel,
    onNavigateToDetail: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()

    Scaffold(
        modifier = modifier,
    ) { paddingValues ->
        PullToRefreshBox(
            isRefreshing = uiState.isRefreshing,
            onRefresh = { viewModel.refresh() },
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues),
        ) {
            Column(
                modifier = Modifier.fillMaxSize(),
            ) {
                // Filter chips
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp)
                        .testTag("conversation-filters"),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    ConversationFilter.entries.forEach { filter ->
                        FilterChip(
                            selected = uiState.filter == filter,
                            onClick = { viewModel.setFilter(filter) },
                            label = {
                                Text(
                                    text = when (filter) {
                                        ConversationFilter.ACTIVE -> stringResource(R.string.filter_active)
                                        ConversationFilter.WAITING -> stringResource(R.string.conversation_status_waiting)
                                        ConversationFilter.CLOSED -> stringResource(R.string.filter_closed)
                                        ConversationFilter.ALL -> stringResource(R.string.filter_all)
                                    },
                                )
                            },
                            modifier = Modifier.testTag("filter-${filter.tag}"),
                        )
                    }
                }

                // Search bar
                OutlinedTextField(
                    value = uiState.searchQuery,
                    onValueChange = { viewModel.setSearchQuery(it) },
                    placeholder = { Text(stringResource(R.string.search_conversations)) },
                    leadingIcon = {
                        Icon(Icons.Filled.Search, contentDescription = null)
                    },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp)
                        .testTag("conversation-search-input"),
                )

                val displayedConversations = viewModel.filteredConversations()
                val loadError = uiState.error

                // Rows from an earlier load are still this hub's: keep them, and say the
                // refresh failed above them.
                if (loadError != null && uiState.conversations.isNotEmpty()) {
                    org.llamenos.hotline.ui.components.ErrorCard(
                        error = loadError,
                        onDismiss = { viewModel.dismissError() },
                        onRetry = { viewModel.loadConversations() },
                        testTag = "conversations-error",
                    )
                }

                when {
                    uiState.isLoading && uiState.conversations.isEmpty() -> {
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .testTag("conversations-loading"),
                            contentAlignment = Alignment.Center,
                        ) {
                            CircularProgressIndicator()
                        }
                    }

                    // Nothing listed because the load FAILED — never the empty state, which
                    // would tell a volunteer there is no one to answer (#2118). No dismiss:
                    // dismissing would leave exactly that empty state behind.
                    loadError != null && uiState.conversations.isEmpty() -> {
                        ConversationsLoadFailed(
                            error = loadError,
                            onRetry = { viewModel.loadConversations() },
                        )
                    }

                    displayedConversations.isEmpty() && !uiState.isLoading -> {
                        Box(
                            modifier = Modifier.fillMaxSize(),
                            contentAlignment = Alignment.Center,
                        ) {
                            org.llamenos.hotline.ui.components.EmptyState(
                                icon = Icons.Filled.Chat,
                                title = stringResource(R.string.conversations_empty),
                                subtitle = stringResource(R.string.conversations_empty_subtitle),
                                testTag = "conversations-empty",
                            )
                        }
                    }

                    else -> {
                        LazyColumn(
                            contentPadding = PaddingValues(16.dp),
                            verticalArrangement = Arrangement.spacedBy(10.dp),
                            modifier = Modifier
                                .fillMaxSize()
                                .testTag("conversations-list"),
                        ) {
                            items(
                                items = displayedConversations,
                                key = { it.id },
                            ) { conversation ->
                                ConversationCard(
                                    conversation = conversation,
                                    onClick = {
                                        viewModel.openConversation(conversation)
                                        onNavigateToDetail(conversation.id)
                                    },
                                )
                            }
                        }
                    }
                }

            }
        }
    }
}

/**
 * The list could not be loaded — not "there are no conversations". Shown in place of the
 * list, with the reason and a retry.
 */
@Composable
private fun ConversationsLoadFailed(
    error: String,
    onRetry: () -> Unit,
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp)
            .testTag("conversations-error"),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(
                imageVector = Icons.Filled.ErrorOutline,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error,
                modifier = Modifier.size(48.dp),
            )
            Spacer(Modifier.height(12.dp))
            Text(
                text = stringResource(R.string.conversations_error_title),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.testTag("conversations-error-title"),
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = error,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.testTag("conversations-error-message"),
            )
            Spacer(Modifier.height(16.dp))
            Button(
                onClick = onRetry,
                modifier = Modifier.testTag("conversations-error-retry"),
            ) {
                Text(stringResource(R.string.common_retry))
            }
        }
    }
}

/**
 * Individual conversation card showing channel icon, contact hash, time, and unread badge.
 */
@Composable
private fun ConversationCard(
    conversation: SharedConversation,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .testTag("conversation-card-${conversation.id}"),
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
            // Channel type icon
            Icon(
                imageVector = channelIcon(conversation.channelType),
                contentDescription = channelLabel(conversation.channelType),
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier
                    .size(32.dp)
                    .testTag("channel-icon-${conversation.id}"),
            )

            Spacer(Modifier.width(12.dp))

            // Conversation info
            Column(
                modifier = Modifier.weight(1f),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = channelLabel(conversation.channelType),
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.testTag("conversation-channel-${conversation.id}"),
                    )

                    // Status badge
                    Text(
                        text = conversation.status?.value.orEmpty().replaceFirstChar { it.uppercase() },
                        style = MaterialTheme.typography.labelSmall,
                        color = when (conversation.status) {
                            SharedReportResponseStatus.Active -> MaterialTheme.colorScheme.primary
                            SharedReportResponseStatus.Waiting -> MaterialTheme.colorScheme.tertiary
                            else -> MaterialTheme.colorScheme.onSurfaceVariant
                        },
                        modifier = Modifier.testTag("conversation-status-${conversation.id}"),
                    )
                }

                Spacer(Modifier.height(4.dp))

                // Contact hash (truncated)
                Text(
                    text = conversation.contactIdentifierHash.take(12) + "...",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.testTag("conversation-contact-${conversation.id}"),
                )

                // Last message time
                val lastTime = conversation.lastMessageAt
                if (lastTime != null) {
                    Spacer(Modifier.height(2.dp))
                    Text(
                        text = DateFormatUtils.formatTimestamp(lastTime),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                        modifier = Modifier.testTag("conversation-time-${conversation.id}"),
                    )
                }
            }
        }
    }
}

/**
 * Map a channel type string to its Material icon.
 */
private fun channelIcon(channelType: String) = when (channelType) {
    "sms" -> Icons.Filled.Sms
    "whatsapp" -> Icons.Filled.Chat
    "signal" -> Icons.Filled.MarkChatRead
    else -> Icons.Filled.Chat
}

/**
 * Map a channel type string to a display label.
 */
@Composable
private fun channelLabel(channelType: String) = when (channelType) {
    "sms" -> stringResource(R.string.conversations_sms)
    "whatsapp" -> stringResource(R.string.conversations_whatsapp)
    "signal" -> stringResource(R.string.conversations_signal)
    else -> channelType.replaceFirstChar { it.uppercase() }
}