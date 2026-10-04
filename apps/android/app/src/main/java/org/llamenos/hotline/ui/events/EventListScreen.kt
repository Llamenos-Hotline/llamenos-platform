package org.llamenos.hotline.ui.events

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R
import org.llamenos.hotline.model.EntityTypeDefinition
import org.llamenos.hotline.ui.cases.parseHexColor
import org.llamenos.hotline.ui.components.EmptyState
import org.llamenos.hotline.util.DateFormatUtils
import org.llamenos.protocol.Record

/**
 * Event list screen showing CMS records of event entity types.
 *
 * Displays a searchable list of events from GET /api/records filtered
 * to entity types with category "event". Each event card shows the
 * case number, status badge, entity type, and timestamp.
 *
 * When CMS is not enabled, shows a disabled message.
 *
 * @param viewModel Hilt-injected ViewModel for events state
 * @param onNavigateBack Callback to navigate to the previous screen
 * @param onNavigateToEventDetail Callback to navigate to event detail
 * @param onNavigateToCreateEvent Callback to navigate to event creation
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EventListScreen(
    viewModel: EventsViewModel,
    onNavigateBack: () -> Unit,
    onNavigateToEventDetail: (String) -> Unit,
    onNavigateToCreateEvent: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = stringResource(R.string.events_title),
                        modifier = Modifier.testTag("events-title"),
                    )
                },
                navigationIcon = {
                    IconButton(
                        onClick = onNavigateBack,
                        modifier = Modifier.testTag("events-back"),
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.common_back),
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primaryContainer,
                    titleContentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                ),
            )
        },
        floatingActionButton = {
            if (uiState.cmsEnabled == true && uiState.eventEntityTypes.isNotEmpty()) {
                FloatingActionButton(
                    onClick = onNavigateToCreateEvent,
                    modifier = Modifier.testTag("event-create-fab"),
                ) {
                    Icon(
                        imageVector = Icons.Filled.Add,
                        contentDescription = stringResource(R.string.events_new_event),
                    )
                }
            }
        },
        modifier = modifier,
    ) { paddingValues ->
        // CMS not enabled
        if (uiState.cmsEnabled == false) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(paddingValues),
                contentAlignment = Alignment.Center,
            ) {
                EmptyState(
                    icon = Icons.Filled.CalendarMonth,
                    title = stringResource(R.string.events_cms_disabled),
                    testTag = "events-cms-disabled",
                    modifier = Modifier.fillMaxSize(),
                )
            }
            return@Scaffold
        }

        // Loading initial state
        if (uiState.cmsEnabled == null || (uiState.isLoading && uiState.events.isEmpty() && uiState.isLoadingEntityTypes)) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(paddingValues)
                    .testTag("events-loading"),
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator()
            }
            return@Scaffold
        }

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
                    placeholder = { Text(stringResource(R.string.events_search_placeholder)) },
                    leadingIcon = {
                        Icon(
                            imageVector = Icons.Filled.Search,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    },
                    singleLine = true,
                    colors = OutlinedTextFieldDefaults.colors(
                        unfocusedContainerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                    ),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp)
                        .testTag("events-search"),
                )

                // Error card
                if (uiState.error != null) {
                    org.llamenos.hotline.ui.components.ErrorCard(
                        error = uiState.error ?: "",
                        onDismiss = { viewModel.dismissError() },
                        onRetry = { viewModel.refresh() },
                        testTag = "events-error",
                    )
                }

                // Content
                when {
                    uiState.isLoading && uiState.events.isEmpty() -> {
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .testTag("events-loading-content"),
                            contentAlignment = Alignment.Center,
                        ) {
                            CircularProgressIndicator()
                        }
                    }

                    uiState.filteredEvents.isEmpty() && !uiState.isLoading -> {
                        EmptyState(
                            icon = Icons.Filled.CalendarMonth,
                            title = stringResource(R.string.events_no_events),
                            subtitle = stringResource(R.string.events_no_events_subtitle),
                            testTag = "events-empty",
                            modifier = Modifier.fillMaxSize(),
                        )
                    }

                    else -> {
                        LazyColumn(
                            modifier = Modifier
                                .fillMaxSize()
                                .testTag("events-list"),
                            contentPadding = androidx.compose.foundation.layout.PaddingValues(
                                horizontal = 16.dp,
                                vertical = 8.dp,
                            ),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            items(
                                items = uiState.filteredEvents,
                                key = { it.id },
                            ) { event ->
                                EventCard(
                                    event = event,
                                    entityType = uiState.entityTypeMap[event.entityTypeID],
                                    onClick = { onNavigateToEventDetail(event.id) },
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
 * Card displaying a single event with status indicator,
 * case number, entity type badge, and timestamp.
 */
@Composable
private fun EventCard(
    event: Record,
    entityType: EntityTypeDefinition?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val statusOption = entityType?.statuses?.find { it.value == event.statusHash }
    val statusLabel = statusOption?.label ?: event.statusHash
    val statusColor = statusOption?.color?.let { parseHexColor(it) }

    Card(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .testTag("event-card-${event.id}"),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
        ) {
            // Top row: case number + entity type
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(
                    imageVector = Icons.Filled.CalendarMonth,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(20.dp),
                )

                Spacer(Modifier.width(8.dp))

                Text(
                    text = event.caseNumber ?: event.id.take(8),
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .weight(1f)
                        .testTag("event-title"),
                )

                // Entity type badge
                if (entityType != null) {
                    val typeColor = entityType.color?.let { parseHexColor(it) }
                    Card(
                        colors = CardDefaults.cardColors(
                            containerColor = (typeColor ?: MaterialTheme.colorScheme.secondaryContainer)
                                .copy(alpha = 0.15f),
                        ),
                    ) {
                        Text(
                            text = entityType.label,
                            style = MaterialTheme.typography.labelSmall,
                            color = typeColor ?: MaterialTheme.colorScheme.secondary,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                    }
                }
            }

            Spacer(Modifier.height(8.dp))

            // Bottom row: status + counts + timestamp
            Row(
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                // Status badge
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (statusColor != null) {
                        Icon(
                            imageVector = Icons.Filled.Circle,
                            contentDescription = null,
                            tint = statusColor,
                            modifier = Modifier.size(8.dp),
                        )
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(
                        text = statusLabel,
                        style = MaterialTheme.typography.bodySmall,
                        color = statusColor ?: MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.testTag("event-status"),
                    )
                }

                // Linked counts
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (event.contactCount > 0.0) {
                        Text(
                            text = "${event.contactCount.toInt()} linked",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                            modifier = Modifier.testTag("event-linked-count"),
                        )
                    }
                }

                // Timestamp
                Text(
                    text = DateFormatUtils.formatTimestamp(event.updatedAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                    modifier = Modifier.testTag("event-timestamp"),
                )
            }
        }
    }
}
