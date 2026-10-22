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
import androidx.compose.material.icons.filled.MarkChatRead
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Sms
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
import org.llamenos.protocol.ConversationListResponseConversation
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
                                        ConversationFilter.CLOSED -> stringResource(R.string.filter_closed)
                                        ConversationFilter.ALL -> stringResource(R.string.filter_all)
                                    },
                                )
                            },
                            modifier = Modifier.testTag("filter-${filter.queryParam}"),
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

                // Error message
                if (uiState.error != null) {
                    org.llamenos.hotline.ui.components.ErrorCard(
                        error = uiState.error ?: "",
                        onDismiss = { viewModel.dismissError() },
                        onRetry = { viewModel.loadConversations() },
                        testTag = "conversations-error",
                    )
                }
            }
        }
    }
}

/**
 * Individual conversation card showing channel icon, contact hash, time, and unread badge.
 */
@Composable
private fun ConversationCard(
    conversation: ConversationListResponseConversation,
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