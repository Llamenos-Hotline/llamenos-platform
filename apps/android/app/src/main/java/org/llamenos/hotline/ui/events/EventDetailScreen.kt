package org.llamenos.hotline.ui.events

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Timeline
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R
import org.llamenos.hotline.model.EntityTypeDefinition
import org.llamenos.hotline.ui.cases.parseHexColor
import org.llamenos.hotline.ui.components.EmptyState
import org.llamenos.hotline.util.DateFormatUtils
import org.llamenos.protocol.Record

/**
 * Event detail screen showing full event information.
 *
 * Displays the event header (case number, status, entity type)
 * and a tabbed content area with Details, Sub-Events, Timeline,
 * Cases, and Reports tabs. Sub-events and linked cases are the
 * event's child records, split by whether their entity type is an
 * event. The status can be changed via status filter chips
 * if the user has permission.
 *
 * @param viewModel Shared EventsViewModel
 * @param eventId The event record ID to load
 * @param onNavigateBack Callback to navigate back
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EventDetailScreen(
    viewModel: EventsViewModel,
    eventId: String,
    onNavigateBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()
    var selectedTabIndex by rememberSaveable { mutableIntStateOf(0) }

    // Load event on first composition
    LaunchedEffect(eventId) {
        viewModel.selectEvent(eventId)
    }

    val event = uiState.selectedEvent
    val entityType = event?.let { uiState.entityTypeMap[it.entityTypeID] }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = event?.caseNumber ?: stringResource(R.string.events_detail_title),
                        modifier = Modifier.testTag("event-detail-title"),
                    )
                },
                navigationIcon = {
                    IconButton(
                        onClick = {
                            viewModel.clearSelection()
                            onNavigateBack()
                        },
                        modifier = Modifier.testTag("event-detail-back"),
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
        modifier = modifier,
    ) { paddingValues ->
        when {
            uiState.isLoadingDetail -> {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(paddingValues)
                        .testTag("event-detail-loading"),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator()
                }
            }

            uiState.detailError != null -> {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(paddingValues),
                    contentAlignment = Alignment.Center,
                ) {
                    org.llamenos.hotline.ui.components.ErrorCard(
                        error = uiState.detailError ?: "",
                        onDismiss = { viewModel.dismissError() },
                        onRetry = { viewModel.selectEvent(eventId) },
                        testTag = "event-detail-error",
                    )
                }
            }

            event != null -> {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(paddingValues),
                ) {
                    // Event header card
                    EventHeaderCard(
                        event = event,
                        entityType = entityType,
                    )

                    // Tab row
                    val tabs = listOf(
                        "details" to stringResource(R.string.events_tab_details),
                        "sub_events" to stringResource(R.string.events_tab_sub_events),
                        "timeline" to stringResource(R.string.events_tab_timeline),
                        "linked_cases" to stringResource(R.string.events_tab_cases),
                        "linked_reports" to stringResource(R.string.events_tab_reports),
                    )

                    ScrollableTabRow(
                        selectedTabIndex = selectedTabIndex,
                        edgePadding = 16.dp,
                        modifier = Modifier.testTag("event-detail-tabs"),
                    ) {
                        tabs.forEachIndexed { index, (slug, title) ->
                            Tab(
                                selected = selectedTabIndex == index,
                                onClick = { selectedTabIndex = index },
                                text = { Text(title) },
                                modifier = Modifier.testTag("event-tab-$slug"),
                            )
                        }
                    }

                    // Tab content
                    when (tabs[selectedTabIndex].first) {
                        "details" -> EventDetailsTab(event = event, entityType = entityType)
                        "sub_events" -> EventChildRecordsTab(
                            records = uiState.subEvents,
                            entityTypeMap = uiState.entityTypeMap,
                            isLoading = uiState.isLoadingChildren,
                            error = uiState.childrenError,
                            onRetry = { viewModel.loadChildRecords(eventId) },
                            onDismissError = { viewModel.dismissChildrenError() },
                            icon = Icons.Filled.Layers,
                            emptyTitle = stringResource(R.string.events_no_sub_events),
                            testTagPrefix = "event-sub-events",
                        )
                        "timeline" -> EventTimelineTab()
                        "linked_cases" -> EventChildRecordsTab(
                            records = uiState.linkedCases,
                            entityTypeMap = uiState.entityTypeMap,
                            isLoading = uiState.isLoadingChildren,
                            error = uiState.childrenError,
                            onRetry = { viewModel.loadChildRecords(eventId) },
                            onDismissError = { viewModel.dismissChildrenError() },
                            icon = Icons.Filled.Folder,
                            emptyTitle = stringResource(R.string.events_no_linked_cases),
                            testTagPrefix = "event-cases",
                        )
                        "linked_reports" -> EventLinkedReportsTab()
                    }
                }
            }

            else -> {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(paddingValues),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = stringResource(R.string.events_select_event),
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

/**
 * Header card showing event identification, status, and metadata.
 */
@Composable
private fun EventHeaderCard(
    event: Record,
    entityType: EntityTypeDefinition?,
    modifier: Modifier = Modifier,
) {
    val statusOption = entityType?.statuses?.find { it.value == event.statusHash }
    val statusLabel = statusOption?.label ?: event.statusHash
    val statusColor = statusOption?.color?.let { parseHexColor(it) }

    Card(
        modifier = modifier
            .fillMaxWidth()
            .padding(16.dp)
            .testTag("event-header-card"),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
        ) {
            // Case number + entity type
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(
                    imageVector = Icons.Filled.CalendarMonth,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(24.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    text = event.caseNumber ?: event.id.take(8),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier
                        .weight(1f)
                        .testTag("event-header-number"),
                )
            }

            Spacer(Modifier.height(12.dp))

            // Status row
            Row(
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // Status badge
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (statusColor != null) {
                        Icon(
                            imageVector = Icons.Filled.Circle,
                            contentDescription = null,
                            tint = statusColor,
                            modifier = Modifier.size(10.dp),
                        )
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(
                        text = statusLabel,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                        color = statusColor ?: MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.testTag("event-header-status"),
                    )
                }

                // Entity type
                if (entityType != null) {
                    Text(
                        text = entityType.label,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.secondary,
                    )
                }
            }

            Spacer(Modifier.height(8.dp))

            // Timestamps
            Row(
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text(
                    text = stringResource(R.string.events_created_at, DateFormatUtils.formatTimestamp(event.createdAt)),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                    modifier = Modifier.testTag("event-header-created"),
                )
                Text(
                    text = stringResource(R.string.events_updated_at, DateFormatUtils.formatTimestamp(event.updatedAt)),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                    modifier = Modifier.testTag("event-header-updated"),
                )
            }

            // Counts
            if (event.interactionCount > 0.0 || event.contactCount > 0.0 || event.assignedTo.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (event.assignedTo.isNotEmpty()) {
                        Text(
                            text = "${event.assignedTo.size} assigned",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                        )
                    }
                    if (event.interactionCount > 0.0) {
                        Text(
                            text = "${event.interactionCount.toInt()} interactions",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                        )
                    }
                    if (event.contactCount > 0.0) {
                        Text(
                            text = "${event.contactCount.toInt()} contacts",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                        )
                    }
                }
            }
        }
    }
}

/**
 * Details tab showing custom fields for the event entity type.
 */
@Composable
private fun EventDetailsTab(
    event: Record,
    entityType: EntityTypeDefinition?,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp)
            .verticalScroll(rememberScrollState())
            .testTag("event-details-tab"),
    ) {
        if (entityType == null || entityType.fields.isEmpty()) {
            EmptyState(
                icon = Icons.Filled.Description,
                title = stringResource(R.string.events_no_fields),
                testTag = "event-details-empty",
                modifier = Modifier.fillMaxWidth(),
            )
        } else {
            // Show field definitions (values would need decryption)
            entityType.fields.forEach { field ->
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 4.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surface,
                    ),
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(12.dp),
                    ) {
                        Text(
                            text = field.label,
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = stringResource(R.string.events_encrypted_field),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                        )
                    }
                }
            }
        }
    }
}

/**
 * Timeline tab placeholder.
 */
@Composable
private fun EventTimelineTab(
    modifier: Modifier = Modifier,
) {
    EmptyState(
        icon = Icons.Filled.Timeline,
        title = stringResource(R.string.events_no_timeline),
        testTag = "event-timeline-empty",
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp),
    )
}

/**
 * Lists child records of the event: sub-events on the Sub-Events tab,
 * everything else on the Cases tab.
 */
@Composable
private fun EventChildRecordsTab(
    records: List<Record>,
    entityTypeMap: Map<String, EntityTypeDefinition>,
    isLoading: Boolean,
    error: String?,
    onRetry: () -> Unit,
    onDismissError: () -> Unit,
    icon: ImageVector,
    emptyTitle: String,
    testTagPrefix: String,
    modifier: Modifier = Modifier,
) {
    when {
        isLoading -> {
            Box(
                modifier = modifier
                    .fillMaxSize()
                    .padding(16.dp)
                    .testTag("$testTagPrefix-loading"),
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator()
            }
        }

        error != null -> {
            org.llamenos.hotline.ui.components.ErrorCard(
                error = error,
                onDismiss = onDismissError,
                onRetry = onRetry,
                testTag = "$testTagPrefix-error",
                modifier = modifier,
            )
        }

        records.isEmpty() -> {
            EmptyState(
                icon = icon,
                title = emptyTitle,
                testTag = "$testTagPrefix-empty",
                modifier = modifier
                    .fillMaxSize()
                    .padding(16.dp),
            )
        }

        else -> {
            LazyColumn(
                modifier = modifier
                    .fillMaxSize()
                    .padding(horizontal = 16.dp)
                    .testTag("$testTagPrefix-list"),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(records, key = { it.id }) { record ->
                    EventChildRecordCard(
                        record = record,
                        entityType = entityTypeMap[record.entityTypeID],
                        icon = icon,
                        testTag = "$testTagPrefix-item",
                    )
                }
            }
        }
    }
}

@Composable
private fun EventChildRecordCard(
    record: Record,
    entityType: EntityTypeDefinition?,
    icon: ImageVector,
    testTag: String,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .testTag(testTag),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface,
        ),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.width(10.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = record.caseNumber ?: record.id.take(8),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                )
                Text(
                    text = stringResource(R.string.events_created_at, DateFormatUtils.formatTimestamp(record.createdAt)),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (entityType != null) {
                Text(
                    text = entityType.label,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.secondary,
                )
            }
        }
    }
}

/**
 * Linked reports tab placeholder.
 */
@Composable
private fun EventLinkedReportsTab(
    modifier: Modifier = Modifier,
) {
    EmptyState(
        icon = Icons.Filled.Link,
        title = stringResource(R.string.events_no_linked_reports),
        testTag = "event-reports-empty",
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp),
    )
}
