package org.llamenos.hotline.ui.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R
import org.llamenos.hotline.model.ShiftResponse
import org.llamenos.hotline.model.dayIndices
import org.llamenos.hotline.model.name
import org.llamenos.hotline.model.volunteerCount
import org.llamenos.hotline.util.DateFormatUtils

/**
 * Shift schedule administration tab in the admin panel.
 *
 * Allows admins to create, edit, and delete shifts. Each shift has a name,
 * start/end time, and assigned volunteers. This is the admin CRUD view,
 * separate from the volunteer-facing ShiftsScreen.
 */
@Composable
fun ShiftScheduleTab(
    viewModel: AdminViewModel,
    onNavigateToShiftDetail: (String) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()

    if (uiState.showCreateShiftDialog) {
        ShiftDialog(
            existingShift = uiState.editingShift,
            onDismiss = { viewModel.dismissShiftDialog() },
            onSave = { name, startTime, endTime, days ->
                val editing = uiState.editingShift
                if (editing != null) {
                    viewModel.updateShift(editing.id, name, startTime, endTime, days)
                } else {
                    viewModel.createShift(name, startTime, endTime, days)
                }
            },
        )
    }

    Scaffold(
        floatingActionButton = {
            FloatingActionButton(
                onClick = { viewModel.showCreateShiftDialog() },
                modifier = Modifier.testTag("create-shift-fab"),
            ) {
                Icon(
                    imageVector = Icons.Filled.Add,
                    contentDescription = stringResource(R.string.shifts_create),
                )
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
                uiState.isLoadingAdminShifts -> {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .testTag("admin-shifts-loading"),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator()
                    }
                }

                uiState.adminShifts.isEmpty() && !uiState.isLoadingAdminShifts -> {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(32.dp)
                            .testTag("admin-shifts-empty"),
                        contentAlignment = Alignment.Center,
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Icon(
                                imageVector = Icons.Filled.Schedule,
                                contentDescription = null,
                                modifier = Modifier.size(48.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                            )
                            Spacer(Modifier.height(12.dp))
                            Text(
                                text = stringResource(R.string.shifts_empty_scheduled),
                                style = MaterialTheme.typography.bodyLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }

                else -> {
                    LazyColumn(
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier
                            .fillMaxSize()
                            .testTag("admin-shifts-list"),
                    ) {
                        items(
                            items = uiState.adminShifts,
                            key = { it.id },
                        ) { shift ->
                            ShiftCard(
                                shift = shift,
                                onClick = { onNavigateToShiftDetail(shift.id) },
                                onEdit = { viewModel.showEditShiftDialog(shift) },
                                onDelete = { viewModel.deleteShift(shift.id) },
                            )
                        }
                    }
                }
            }

            if (uiState.adminShiftsError != null) {
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp)
                        .testTag("admin-shifts-error"),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer,
                    ),
                ) {
                    Text(
                        text = uiState.adminShiftsError ?: "",
                        modifier = Modifier.padding(16.dp),
                        color = MaterialTheme.colorScheme.onErrorContainer,
                    )
                }
            }
        }
    }
}

@Composable
private fun ShiftCard(
    shift: ShiftResponse,
    onClick: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        onClick = onClick,
        modifier = modifier
            .fillMaxWidth()
            .testTag("shift-card-${shift.id}"),
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
                    text = shift.name,
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.testTag("shift-name-${shift.id}"),
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "${shift.startTime} - ${shift.endTime}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.testTag("shift-time-${shift.id}"),
                )
                Spacer(Modifier.height(4.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (shift.dayIndices.isNotEmpty()) {
                        AssistChip(
                            onClick = {},
                            label = {
                                Text(
                                    text = formatDays(shift.dayIndices),
                                    style = MaterialTheme.typography.labelSmall,
                                )
                            },
                            modifier = Modifier.height(24.dp),
                        )
                    }
                    AssistChip(
                        onClick = {},
                        label = {
                            Text(
                                text = "${shift.volunteerCount} volunteer${if (shift.volunteerCount != 1) "s" else ""}",
                                style = MaterialTheme.typography.labelSmall,
                            )
                        },
                        modifier = Modifier.height(24.dp),
                    )
                }
            }

            IconButton(
                onClick = onEdit,
                modifier = Modifier.testTag("edit-shift-${shift.id}"),
            ) {
                Icon(Icons.Filled.Edit, contentDescription = stringResource(R.string.shifts_edit))
            }

            IconButton(
                onClick = onDelete,
                modifier = Modifier.testTag("delete-shift-${shift.id}"),
            ) {
                Icon(
                    Icons.Filled.Delete,
                    contentDescription = stringResource(R.string.shifts_delete),
                    tint = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

/**
 * Format day-of-week integers (0=Sun..6=Sat, matching the wire format in
 * `Shift.dayIndices`) into a compact display string.
 */
private fun formatDays(days: List<Int>): String {
    return days.sorted().joinToString(", ") { DateFormatUtils.shortDayName(it) }
}

/** Default recurrence for a brand-new shift: Mon-Fri (0=Sun..6=Sat). */
private val DEFAULT_SHIFT_DAYS = listOf(1, 2, 3, 4, 5)

/** Day-of-week picker labels, 0=Sun..6=Sat — matches the wire format (`Shift.dayIndices`). */
private val DAY_LABELS = listOf(
    0 to R.string.shifts_days_sunday,
    1 to R.string.shifts_days_monday,
    2 to R.string.shifts_days_tuesday,
    3 to R.string.shifts_days_wednesday,
    4 to R.string.shifts_days_thursday,
    5 to R.string.shifts_days_friday,
    6 to R.string.shifts_days_saturday,
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ShiftDialog(
    existingShift: ShiftResponse?,
    onDismiss: () -> Unit,
    onSave: (name: String, startTime: String, endTime: String, days: List<Int>) -> Unit,
) {
    var name by remember { mutableStateOf(existingShift?.name ?: "") }
    var startTime by remember { mutableStateOf(existingShift?.startTime ?: "") }
    var endTime by remember { mutableStateOf(existingShift?.endTime ?: "") }
    // Recurrence, pre-filled from the shift being edited so saving never silently
    // rewrites it (issue #1149) — for a new shift, defaults to Mon-Fri.
    var selectedDays by remember {
        mutableStateOf((existingShift?.dayIndices?.takeIf { it.isNotEmpty() } ?: DEFAULT_SHIFT_DAYS).toSet())
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                if (existingShift != null) stringResource(R.string.shifts_edit)
                else stringResource(R.string.shifts_create),
            )
        },
        text = {
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text(stringResource(R.string.shifts_name)) },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("shift-name-input"),
                )

                Spacer(Modifier.height(8.dp))

                OutlinedTextField(
                    value = startTime,
                    onValueChange = { startTime = it },
                    label = { Text(stringResource(R.string.shifts_start_time)) },
                    placeholder = { Text("09:00") },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("shift-start-input"),
                )

                Spacer(Modifier.height(8.dp))

                OutlinedTextField(
                    value = endTime,
                    onValueChange = { endTime = it },
                    label = { Text(stringResource(R.string.shifts_end_time)) },
                    placeholder = { Text("17:00") },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("shift-end-input"),
                )

                Spacer(Modifier.height(8.dp))

                Text(
                    text = stringResource(R.string.shifts_recurring),
                    style = MaterialTheme.typography.labelLarge,
                )
                Spacer(Modifier.height(4.dp))
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    modifier = Modifier.testTag("shift-days-picker"),
                ) {
                    DAY_LABELS.forEach { (dayIndex, labelRes) ->
                        FilterChip(
                            selected = dayIndex in selectedDays,
                            onClick = {
                                selectedDays = if (dayIndex in selectedDays) {
                                    selectedDays - dayIndex
                                } else {
                                    selectedDays + dayIndex
                                }
                            },
                            label = { Text(stringResource(labelRes)) },
                            modifier = Modifier.testTag("shift-day-chip-$dayIndex"),
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onSave(name, startTime, endTime, selectedDays.sorted()) },
                enabled = name.isNotBlank() && startTime.isNotBlank() && endTime.isNotBlank() &&
                    selectedDays.isNotEmpty(),
                modifier = Modifier.testTag("confirm-shift-save"),
            ) {
                Text(stringResource(R.string.action_save))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(android.R.string.cancel))
            }
        },
    )
}
