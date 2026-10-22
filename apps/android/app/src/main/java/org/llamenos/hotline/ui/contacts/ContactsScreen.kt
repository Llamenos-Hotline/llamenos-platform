package org.llamenos.hotline.ui.contacts

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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R
import org.llamenos.hotline.model.ContactSummary
import org.llamenos.hotline.util.DateFormatUtils

/**
 * Contacts screen showing a paginated list of contact summaries with
 * aggregated interaction counts (calls, messages, notes, reports).
 *
 * Each contact is identified by their hashed phone number. Only admins
 * can see the last 4 digits. Tapping a contact navigates to the detail view.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContactsScreen(
    viewModel: ContactsViewModel,
    onNavigateBack: () -> Unit,
    onNavigateToTimeline: (String) -> Unit = {},
    onNavigateToDetail: (String) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()
    val listState = rememberLazyListState()

    // Infinite scroll
    val shouldLoadMore by remember {
        derivedStateOf {
            val lastVisibleItem = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            lastVisibleItem >= uiState.contacts.size - 5 && !uiState.isLoading && uiState.contacts.size < uiState.total
        }
    }
    LaunchedEffect(shouldLoadMore) {
        if (shouldLoadMore) viewModel.loadNextPage()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = stringResource(R.string.contacts_title),
                        modifier = Modifier.testTag("contacts-title"),
                    )
                },
                navigationIcon = {
                    IconButton(
                        onClick = onNavigateBack,
                        modifier = Modifier.testTag("contacts-back"),
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.contacts_back),
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primaryContainer,
                    titleContentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                ),
            )
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
                    placeholder = { Text(stringResource(R.string.contacts_search)) },
                    leadingIcon = {
                        Icon(Icons.Filled.Search, contentDescription = null)
                    },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp)
                        .testTag("contacts-search"),
                )

                // Contact type filter chips
                if (uiState.contactTypes.isNotEmpty()) {
                    LazyRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        contentPadding = PaddingValues(horizontal = 16.dp),
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("contacts-type-filters"),
                    ) {
                        item {
                            FilterChip(
                                selected = uiState.selectedContactType == null,
                                onClick = { viewModel.setContactTypeFilter(null) },
                                label = { Text(stringResource(R.string.contact_directory_filter_all)) },
                                modifier = Modifier.testTag("contacts-filter-all"),
                            )
                        }
                        items(uiState.contactTypes) { contactType ->
                            FilterChip(
                                selected = uiState.selectedContactType == contactType,
                                onClick = { viewModel.setContactTypeFilter(contactType) },
                                label = { Text(contactType) },
                                modifier = Modifier.testTag("contacts-filter-$contactType"),
                            )
                        }
                    }
                    Spacer(Modifier.height(4.dp))
                }

                when {
                uiState.isLoading && uiState.contacts.isEmpty() -> {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .testTag("contacts-loading"),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator()
                    }
                }
                uiState.visibleContacts.isEmpty() && !uiState.isLoading -> {
                    EmptyContacts(modifier = Modifier.fillMaxSize())
                }
                else -> {
                    LazyColumn(
                        state = listState,
                        modifier = Modifier
                            .fillMaxSize()
                            .testTag("contacts-list"),
                        contentPadding = PaddingValues(
                            horizontal = 16.dp,
                            vertical = 8.dp,
                        ),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        items(
                            items = uiState.visibleContacts,
                            key = { it.contactHash },
                        ) { contact ->
                            ContactCard(
                                contact = contact,
                                onClick = { onNavigateToDetail(contact.contactHash) },
                            )
                        }

                        // Pagination loader
                        if (uiState.contacts.size < uiState.total) {
                            item {
                                Box(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(16.dp),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(24.dp),
                                    )
                                }
                            }
                        }
                    }
                }
                }

                // Error card
                if (uiState.error != null) {
                    org.llamenos.hotline.ui.components.ErrorCard(
                        error = uiState.error ?: "",
                        onDismiss = { viewModel.dismissError() },
                        onRetry = { viewModel.loadContacts() },
                        testTag = "contacts-error",
                    )
                }
            }
        }
    }
}

/**
 * Card displaying a contact summary with identifier, interaction counts,
 * and first/last seen timestamps.
 */
@Composable
private fun ContactCard(
    contact: ContactSummary,
    onClick: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    Card(
        onClick = onClick,
        modifier = modifier
            .fillMaxWidth()
            .testTag("contact-card-${contact.contactHash.take(8)}"),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
        ) {
            // Contact identifier
            Text(
                text = if (contact.last4 != null) {
                    "***${contact.last4}"
                } else {
                    contact.contactHash.take(12) + "\u2026"
                },
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.testTag("contact-identifier"),
            )

            Spacer(Modifier.height(8.dp))

            // Interaction count badges
            Row(
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                if (contact.callCount > 0) {
                    CountBadge(
                        icon = Icons.Filled.Phone,
                        count = contact.callCount,
                        testTag = "contact-calls-count",
                    )
                }
                if (contact.conversationCount > 0) {
                    CountBadge(
                        icon = Icons.Filled.Chat,
                        count = contact.conversationCount,
                        testTag = "contact-conversations-count",
                    )
                }
                if (contact.noteCount > 0) {
                    CountBadge(
                        icon = Icons.Filled.Description,
                        count = contact.noteCount,
                        testTag = "contact-notes-count",
                    )
                }
            }

            Spacer(Modifier.height(6.dp))

            // Timestamps
            Row(
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text(
                    text = stringResource(R.string.contacts_first_seen, DateFormatUtils.formatDate(contact.firstSeen)),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                    modifier = Modifier.testTag("contact-first-seen"),
                )
                Text(
                    text = stringResource(R.string.contacts_last_seen, DateFormatUtils.formatDate(contact.lastSeen)),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                    modifier = Modifier.testTag("contact-last-seen"),
                )
            }
        }
    }
}

/**
 * Small icon + count badge for interaction counts.
 */
@Composable
private fun CountBadge(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    count: Int,
    testTag: String,
    modifier: Modifier = Modifier,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier.testTag(testTag),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(14.dp),
        )
        Spacer(Modifier.width(4.dp))
        Text(
            text = count.toString(),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * Empty state for contacts.
 */
@Composable
private fun EmptyContacts(
    modifier: Modifier = Modifier,
) {
    org.llamenos.hotline.ui.components.EmptyState(
        icon = Icons.Filled.People,
        title = stringResource(R.string.contacts_empty),
        subtitle = stringResource(R.string.contacts_empty_subtitle),
        testTag = "contacts-empty",
        modifier = modifier,
    )
}
