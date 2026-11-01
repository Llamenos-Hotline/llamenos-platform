package org.llamenos.hotline.ui.calls

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
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.NoteAdd
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.PhoneDisabled
import androidx.compose.material.icons.filled.PhoneInTalk
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Voicemail
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R
import org.llamenos.hotline.model.ActiveCallResponseStatus
import org.llamenos.hotline.model.durationSeconds
import org.llamenos.hotline.model.hasRecordingFlag
import org.llamenos.hotline.ui.admin.RecordingPlayer
import org.llamenos.hotline.model.hasTranscriptionFlag
import org.llamenos.hotline.model.hasVoicemailFlag
import org.llamenos.hotline.util.DateFormatUtils

/**
 * Call history screen showing paginated list of past calls with status
 * indicators, duration, and metadata badges (voicemail, transcription, recording).
 *
 * Accessible from the Dashboard's active calls card. Supports pull-to-refresh,
 * infinite scroll pagination, and filtering by call status (all/completed/unanswered).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CallHistoryScreen(
    viewModel: CallHistoryViewModel,
    onNavigateBack: () -> Unit,
    onNavigateToNoteCreate: (callId: String) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()
    val listState = rememberLazyListState()

    // Infinite scroll — load next page when near bottom
    val shouldLoadMore by remember {
        derivedStateOf {
            val lastVisibleItem = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            lastVisibleItem >= uiState.calls.size - 5 && !uiState.isLoading && uiState.calls.size < uiState.total
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
                        text = stringResource(R.string.call_history_title),
                        modifier = Modifier.testTag("call-history-title"),
                    )
                },
                navigationIcon = {
                    IconButton(
                        onClick = onNavigateBack,
                        modifier = Modifier.testTag("call-history-back"),
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.call_history_back),
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
                // Filter chips
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp)
                        .testTag("call-history-filters"),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    CallStatusFilter.entries.forEach { filter ->
                        FilterChip(
                            selected = uiState.selectedFilter == filter,
                            onClick = { viewModel.setFilter(filter) },
                            label = {
                                Text(
                                    when (filter) {
                                        CallStatusFilter.ALL -> stringResource(R.string.filter_all)
                                        CallStatusFilter.COMPLETED -> stringResource(R.string.call_history_filter_completed)
                                        CallStatusFilter.UNANSWERED -> stringResource(R.string.call_history_filter_unanswered)
                                    },
                                )
                            },
                            modifier = Modifier.testTag("call-filter-${filter.name.lowercase()}"),
                        )
                    }
                }

                // Search bar
                OutlinedTextField(
                    value = uiState.searchQuery,
                    onValueChange = { viewModel.setSearchQuery(it) },
                    placeholder = { Text(stringResource(R.string.call_history_search)) },
                    leadingIcon = {
                        Icon(Icons.Filled.Search, contentDescription = null)
                    },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp)
                        .testTag("call-history-search"),
                )

                Spacer(Modifier.height(8.dp))

                // Date range filter
                DateRangeFilter(
                    dateFrom = uiState.dateFrom,
                    dateTo = uiState.dateTo,
                    onDateFromSelected = { viewModel.setDateFrom(it) },
                    onDateToSelected = { viewModel.setDateTo(it) },
                    onClear = { viewModel.clearDateRange() },
                )

                // Content
                when {
                    uiState.isLoading && uiState.calls.isEmpty() -> {
                        Box(
                            modifier = Modifier
                                .fillMaxSize()
                                .testTag("call-history-loading"),
                            contentAlignment = Alignment.Center,
                        ) {
                            CircularProgressIndicator()
                        }
                    }
                    uiState.calls.isEmpty() && !uiState.isLoading -> {
                        EmptyCallHistory(
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                    else -> {
                        LazyColumn(
                            state = listState,
                            modifier = Modifier
                                .fillMaxSize()
                                .testTag("call-history-list"),
                            contentPadding = androidx.compose.foundation.layout.PaddingValues(
                                horizontal = 16.dp,
                                vertical = 8.dp,
                            ),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            items(
                                items = uiState.calls,
                                key = { it.record.id },
                            ) { decryptedCall ->
                                CallHistoryRecordCard(
                                    decryptedCall = decryptedCall,
                                    onAddNote = { onNavigateToNoteCreate(decryptedCall.record.id) },
                                    loadRecording = viewModel::loadRecording,
                                )
                            }

                            // Loading indicator at bottom for pagination
                            if (uiState.calls.size < uiState.total) {
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
                        onRetry = { viewModel.loadCalls() },
                        testTag = "call-history-error",
                    )
                }
            }
        }
    }
}

/**
 * Card displaying a single call record with status icon, caller info,
 * duration, and metadata badges. Shows decrypted caller number when available.
 */
@Composable
private fun CallHistoryRecordCard(
    decryptedCall: DecryptedCallRecord,
    onAddNote: () -> Unit = {},
    loadRecording: suspend (callId: String) -> ByteArray,
    modifier: Modifier = Modifier,
) {
    val call = decryptedCall.record
    val isUnanswered = call.status == ActiveCallResponseStatus.Unanswered
    var showRecording by remember(call.id) { mutableStateOf(false) }

    Card(
        modifier = modifier
            .fillMaxWidth()
            .testTag("call-record-${call.id}"),
        colors = CardDefaults.cardColors(
            containerColor = if (isUnanswered) {
                MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.3f)
            } else {
                MaterialTheme.colorScheme.surfaceVariant
            },
        ),
    ) {
        Column {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // Status icon
                Icon(
                    imageVector = if (isUnanswered) {
                        Icons.Filled.PhoneDisabled
                    } else {
                        Icons.Filled.PhoneInTalk
                    },
                    contentDescription = null,
                    tint = if (isUnanswered) {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.primary
                    },
                    modifier = Modifier
                        .size(24.dp)
                        .testTag("call-status-icon"),
                )

                Spacer(Modifier.width(12.dp))

                // Call info
                Column(modifier = Modifier.weight(1f)) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        // The number only when the admin envelope opened; the server sends no
                        // part of it, so every other row is titled by what it is: a call.
                        val callerDisplay = decryptedCall.decryptedCallerNumber
                            ?: stringResource(R.string.badge_call)
                        Text(
                            text = callerDisplay,
                            style = MaterialTheme.typography.bodyLarge,
                            fontWeight = FontWeight.Medium,
                            modifier = Modifier.testTag("call-caller-id"),
                        )

                        if (isUnanswered) {
                            Text(
                                text = stringResource(R.string.call_history_filter_unanswered),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                    }

                    // Show decrypted answered-by volunteer name when available
                    if (decryptedCall.decryptedAnsweredBy != null) {
                        Text(
                            text = decryptedCall.decryptedAnsweredBy,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.testTag("call-answered-by"),
                        )
                    }

                    Spacer(Modifier.height(4.dp))

                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        // Timestamp
                        Text(
                            text = DateFormatUtils.formatTimestamp(call.startedAt),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.testTag("call-timestamp"),
                        )

                        // Duration
                        if (call.durationSeconds != null && call.durationSeconds!! > 0) {
                            Text(
                                text = DateFormatUtils.formatDuration(call.durationSeconds!!),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.testTag("call-duration"),
                            )
                        }
                    }

                    // Metadata badges
                    if (call.hasVoicemailFlag || call.hasTranscriptionFlag || call.hasRecordingFlag) {
                        Spacer(Modifier.height(6.dp))
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            if (call.hasVoicemailFlag) {
                                MetadataBadge(
                                    icon = Icons.Filled.Voicemail,
                                    label = stringResource(R.string.calls_voicemail),
                                    testTag = "call-voicemail-badge",
                                )
                            }
                            if (call.hasTranscriptionFlag) {
                                MetadataBadge(
                                    icon = Icons.Filled.GraphicEq,
                                    label = stringResource(R.string.calls_transcription),
                                    testTag = "call-transcription-badge",
                                )
                            }
                            if (call.hasRecordingFlag) {
                                MetadataBadge(
                                    icon = Icons.Filled.GraphicEq,
                                    label = stringResource(R.string.calls_recording),
                                    testTag = "call-recording-badge",
                                )
                            }
                        }
                    }
                }

                // Play recording — the server allows admins and the volunteer who answered;
                // anyone else gets a 403, which the player shows as a load failure.
                if (call.hasRecordingFlag) {
                    IconButton(
                        onClick = { showRecording = !showRecording },
                        modifier = Modifier.testTag("call-play-recording-${call.id}"),
                    ) {
                        Icon(
                            imageVector = Icons.Filled.PlayArrow,
                            contentDescription = stringResource(R.string.admin_recording_play),
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }

                // Add Note button
                IconButton(
                    onClick = onAddNote,
                    modifier = Modifier.testTag("call-add-note-${call.id}"),
                ) {
                    Icon(
                        imageVector = Icons.Filled.NoteAdd,
                        contentDescription = stringResource(R.string.calls_add_note),
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(20.dp),
                    )
                }
            }

            if (showRecording) {
                RecordingPlayer(
                    callId = call.id,
                    loadAudio = loadRecording,
                    modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp),
                )
            }
        }
    }
}

/**
 * Small badge showing a call metadata indicator (voicemail, transcription, recording).
 */
@Composable
private fun MetadataBadge(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
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
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(14.dp),
        )
        Spacer(Modifier.width(2.dp))
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.primary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * Date range filter row with From / To date pickers and a clear button.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DateRangeFilter(
    dateFrom: String?,
    dateTo: String?,
    onDateFromSelected: (String?) -> Unit,
    onDateToSelected: (String?) -> Unit,
    onClear: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var showFromPicker by remember { mutableStateOf(false) }
    var showToPicker by remember { mutableStateOf(false) }
    val dateFormat = remember { SimpleDateFormat("yyyy-MM-dd", Locale.US) }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .testTag("call-date-range"),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // From date button
        FilterChip(
            selected = dateFrom != null,
            onClick = { showFromPicker = true },
            label = {
                Text(
                    text = dateFrom ?: stringResource(R.string.call_history_date_from),
                    style = MaterialTheme.typography.labelSmall,
                )
            },
            leadingIcon = {
                Icon(
                    imageVector = Icons.Filled.CalendarMonth,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                )
            },
            modifier = Modifier.testTag("call-date-from"),
        )

        // To date button
        FilterChip(
            selected = dateTo != null,
            onClick = { showToPicker = true },
            label = {
                Text(
                    text = dateTo ?: stringResource(R.string.call_history_date_to),
                    style = MaterialTheme.typography.labelSmall,
                )
            },
            leadingIcon = {
                Icon(
                    imageVector = Icons.Filled.CalendarMonth,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                )
            },
            modifier = Modifier.testTag("call-date-to"),
        )

        // Clear button (only when a date is set)
        if (dateFrom != null || dateTo != null) {
            IconButton(
                onClick = onClear,
                modifier = Modifier
                    .size(32.dp)
                    .testTag("call-date-clear"),
            ) {
                Icon(
                    imageVector = Icons.Filled.Clear,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                )
            }
        }
    }

    // From date picker dialog
    if (showFromPicker) {
        val datePickerState = rememberDatePickerState()
        DatePickerDialog(
            onDismissRequest = { showFromPicker = false },
            confirmButton = {
                TextButton(
                    onClick = {
                        datePickerState.selectedDateMillis?.let { millis ->
                            onDateFromSelected(dateFormat.format(Date(millis)))
                        }
                        showFromPicker = false
                    },
                ) {
                    Text("OK")
                }
            },
            dismissButton = {
                TextButton(onClick = { showFromPicker = false }) {
                    Text("Cancel")
                }
            },
        ) {
            DatePicker(state = datePickerState)
        }
    }

    // To date picker dialog
    if (showToPicker) {
        val datePickerState = rememberDatePickerState()
        DatePickerDialog(
            onDismissRequest = { showToPicker = false },
            confirmButton = {
                TextButton(
                    onClick = {
                        datePickerState.selectedDateMillis?.let { millis ->
                            onDateToSelected(dateFormat.format(Date(millis)))
                        }
                        showToPicker = false
                    },
                ) {
                    Text("OK")
                }
            },
            dismissButton = {
                TextButton(onClick = { showToPicker = false }) {
                    Text("Cancel")
                }
            },
        ) {
            DatePicker(state = datePickerState)
        }
    }
}

/**
 * Empty state for call history.
 */
@Composable
private fun EmptyCallHistory(
    modifier: Modifier = Modifier,
) {
    org.llamenos.hotline.ui.components.EmptyState(
        icon = Icons.Filled.Phone,
        title = stringResource(R.string.call_history_empty),
        subtitle = stringResource(R.string.call_history_empty_subtitle),
        testTag = "call-history-empty",
        modifier = modifier,
    )
}

