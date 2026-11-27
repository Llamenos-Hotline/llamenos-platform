package org.llamenos.hotline.ui.notes

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
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Sms
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R
import org.llamenos.hotline.util.DateFormatUtils

/**
 * Notes list screen showing all decrypted notes with pull-to-refresh.
 *
 * Notes are fetched from the API, decrypted client-side using the volunteer's
 * private key, and displayed in reverse chronological order. A FAB navigates
 * to the note creation screen.
 *
 * @param viewModel Shared NotesViewModel (scoped to the nav graph)
 * @param onNavigateToCreate Callback to navigate to note creation screen
 * @param onNavigateToDetail Callback to navigate to note detail screen
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NotesScreen(
    viewModel: NotesViewModel,
    onNavigateToCreate: () -> Unit,
    onNavigateToDetail: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()
    val listState = rememberLazyListState()
    val filteredNotes = uiState.filteredNotes

    // Paginate when reaching the end of the list
    val shouldLoadMore by remember {
        derivedStateOf {
            val lastVisibleItem = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            lastVisibleItem >= uiState.filteredNotes.size - 3 && uiState.hasMorePages && !uiState.isLoading
        }
    }

    LaunchedEffect(shouldLoadMore) {
        if (shouldLoadMore) {
            viewModel.loadNextPage()
        }
    }

    Scaffold(
        floatingActionButton = {
            FloatingActionButton(
                onClick = onNavigateToCreate,
                modifier = Modifier.testTag("create-note-fab"),
            ) {
                Icon(
                    imageVector = Icons.Filled.Add,
                    contentDescription = stringResource(R.string.notes_create),
                )
            }
        },
        modifier = modifier,
    ) { paddingValues ->
        PullToRefreshBox(
            isRefreshing = uiState.isRefreshing,
            onRefresh = { viewModel.refresh() },
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues),
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                // Search bar
                OutlinedTextField(
                    value = uiState.searchQuery,
                    onValueChange = { viewModel.setSearchQuery(it) },
                    placeholder = { Text(stringResource(R.string.notes_search)) },
                    leadingIcon = {
                        Icon(
                            imageVector = Icons.Filled.Search,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    },
                    trailingIcon = {
                        if (uiState.searchQuery.isNotEmpty()) {
                            IconButton(
                                onClick = { viewModel.setSearchQuery("") },
                                modifier = Modifier.testTag("notes-search-clear"),
                            ) {
                                Icon(
                                    imageVector = Icons.Filled.Clear,
                                    contentDescription = stringResource(R.string.dismiss),
                                )
                            }
                        }
                    },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp)
                        .testTag("notes-search-input"),
                )

            when {
                uiState.isLoading && uiState.notes.isEmpty() -> {
                    // Loading state
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .testTag("notes-loading"),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator()
                    }
                }

                uiState.notes.isEmpty() && !uiState.isLoading && uiState.error == null -> {
                    Box(
                        modifier = Modifier.fillMaxSize(),
                        contentAlignment = Alignment.Center,
                    ) {
                        org.llamenos.hotline.ui.components.EmptyState(
                            icon = Icons.Filled.Description,
                            title = stringResource(R.string.notes_empty),
                            subtitle = stringResource(R.string.notes_empty_subtitle),
                            testTag = "notes-empty",
                        )
                    }
                }

                else -> {
                    LazyColumn(
                        state = listState,
                        contentPadding = PaddingValues(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                        modifier = Modifier
                            .fillMaxSize()
                            .testTag("notes-list"),
                    ) {
                        items(
                            items = filteredNotes,
                            key = { it.id },
                        ) { note ->
                            NoteCard(
                                note = note,
                                onClick = {
                                    viewModel.selectNote(note)
                                    onNavigateToDetail(note.id)
                                },
                            )
                        }

                        // Loading indicator at the bottom for pagination
                        if (uiState.hasMorePages) {
                            item {
                                Box(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(16.dp),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(24.dp),
                                        strokeWidth = 2.dp,
                                    )
                                }
                            }
                        }
                    }
                }
            }
            } // Close Column

            // Error message
            if (uiState.error != null) {
                org.llamenos.hotline.ui.components.ErrorCard(
                    error = uiState.error ?: "",
                    onDismiss = { viewModel.dismissError() },
                    onRetry = { viewModel.loadNotes() },
                    testTag = "notes-error",
                    modifier = Modifier.align(Alignment.BottomCenter),
                )
            }
        }
    }
}

/**
 * Individual note card showing truncated text, date, and context badges.
 */
@Composable
private fun NoteCard(
    note: DecryptedNote,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .testTag("note-card-${note.id}"),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
        ) {
            // Note text preview
            Text(
                text = note.text,
                style = MaterialTheme.typography.bodyLarge,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.testTag("note-text-${note.id}"),
            )

            Spacer(Modifier.height(8.dp))

            // Metadata row
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // Date
                    Text(
                        text = DateFormatUtils.formatTimestamp(note.createdAt),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                        modifier = Modifier.testTag("note-date-${note.id}"),
                    )

                    // Reply count badge
                    if (note.replyCount > 0) {
                        Text(
                            text = "${note.replyCount} \u21A9",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.testTag("note-reply-badge-${note.id}"),
                        )
                    }
                }

                // Context badges
                Row(
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    if (note.callId != null) {
                        AssistChip(
                            onClick = {},
                            label = {
                                Text(
                                    text = stringResource(R.string.badge_call),
                                    style = MaterialTheme.typography.labelSmall,
                                )
                            },
                            leadingIcon = {
                                Icon(
                                    imageVector = Icons.Filled.Phone,
                                    contentDescription = null,
                                    modifier = Modifier.size(14.dp),
                                )
                            },
                            modifier = Modifier
                                .height(28.dp)
                                .testTag("note-call-badge-${note.id}"),
                        )
                    }
                    if (note.conversationId != null) {
                        AssistChip(
                            onClick = {},
                            label = {
                                Text(
                                    text = stringResource(R.string.badge_chat),
                                    style = MaterialTheme.typography.labelSmall,
                                )
                            },
                            leadingIcon = {
                                Icon(
                                    imageVector = Icons.Filled.Sms,
                                    contentDescription = null,
                                    modifier = Modifier.size(14.dp),
                                )
                            },
                            modifier = Modifier
                                .height(28.dp)
                                .testTag("note-chat-badge-${note.id}"),
                        )
                    }
                }
            }
        }
    }
}