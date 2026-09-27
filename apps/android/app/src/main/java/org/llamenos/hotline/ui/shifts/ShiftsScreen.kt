package org.llamenos.hotline.ui.shifts

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
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R
import org.llamenos.hotline.model.dayIndices
import org.llamenos.hotline.model.displayStatus
import org.llamenos.hotline.util.DateFormatUtils
import org.llamenos.hotline.model.ShiftResponse
import org.llamenos.protocol.SharedCreateShiftJoinRequestBodyType

/**
 * Shifts screen showing clock in/out toggle and available shifts.
 *
 * The prominent clock in/out button at the top controls whether the volunteer
 * receives incoming call notifications. Below it, available shifts are grouped
 * by day of week with sign up / drop actions.
 *
 * @param viewModel Hilt-injected ShiftsViewModel
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShiftsScreen(
    viewModel: ShiftsViewModel,
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()

    // Drop confirmation dialog
    uiState.showDropConfirmation?.let { shiftId ->
        AlertDialog(
            onDismissRequest = { viewModel.dismissDropConfirmation() },
            title = { Text(stringResource(R.string.shifts_drop)) },
            text = { Text(stringResource(R.string.shifts_drop_confirm)) },
            confirmButton = {
                TextButton(
                    onClick = { viewModel.dropShift(shiftId) },
                    modifier = Modifier.testTag("confirm-drop-button"),
                ) {
                    Text(stringResource(R.string.shifts_drop))
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { viewModel.dismissDropConfirmation() },
                    modifier = Modifier.testTag("cancel-drop-button"),
                ) {
                    Text(stringResource(android.R.string.cancel))
                }
            },
            modifier = Modifier.testTag("drop-confirmation-dialog"),
        )
    }

    Scaffold(modifier = modifier) { paddingValues ->
        PullToRefreshBox(
            isRefreshing = uiState.isRefreshing,
            onRefresh = { viewModel.refresh() },
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues),
        ) {
            when {
                uiState.isLoading && uiState.shifts.isEmpty() -> {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .testTag("shifts-loading"),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator()
                    }
                }

                else -> {
                    LazyColumn(
                        contentPadding = PaddingValues(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                        modifier = Modifier
                            .fillMaxSize()
                            .testTag("shifts-list"),
                    ) {
                        // Clock in/out card
                        item {
                            ClockInOutCard(
                                isOnShift = uiState.clockedInAt != null,
                                isLoading = uiState.isClockingInOut,
                                startedAt = uiState.clockedInAt,
                                onClockIn = { viewModel.clockIn() },
                                onClockOut = { viewModel.clockOut() },
                            )
                        }

                        // Error card
                        if (uiState.error != null) {
                            item {
                                org.llamenos.hotline.ui.components.ErrorCard(
                                    error = uiState.error ?: "",
                                    onDismiss = { viewModel.clearError() },
                                    onRetry = { viewModel.loadShifts() },
                                    testTag = "shifts-error",
                                )
                            }
                        }

                        // Shifts grouped by day
                        val shiftsByDay = uiState.shifts.groupBy { shift ->
                            shift.dayIndices.firstOrNull() ?: 0
                        }.toSortedMap()

                        if (shiftsByDay.isEmpty() && !uiState.isLoading) {
                            item {
                                EmptyShiftsState()
                            }
                        }

                        shiftsByDay.forEach { (dayIndex, dayShifts) ->
                            item {
                                Text(
                                    text = DateFormatUtils.shortDayName(dayIndex),
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.Bold,
                                    modifier = Modifier
                                        .padding(top = 8.dp)
                                        .testTag("day-header-$dayIndex"),
                                )
                            }

                            items(
                                items = dayShifts,
                                key = { it.id },
                            ) { shift ->
                                ShiftCard(
                                    shift = shift,
                                    pendingRequest = uiState.pendingRequests[shift.id],
                                    onSignUp = { viewModel.signUp(shift.id) },
                                    onDrop = { viewModel.showDropConfirmation(shift.id) },
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
 * Prominent clock in/out toggle card at the top of the shifts screen.
 */
@Composable
private fun ClockInOutCard(
    isOnShift: Boolean,
    isLoading: Boolean,
    startedAt: String?,
    onClockIn: () -> Unit,
    onClockOut: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .testTag("clock-card"),
        colors = CardDefaults.cardColors(
            containerColor = if (isOnShift) {
                MaterialTheme.colorScheme.primaryContainer
            } else {
                MaterialTheme.colorScheme.surfaceVariant
            },
        ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(
                imageVector = if (isOnShift) Icons.Filled.CheckCircle else Icons.Filled.Schedule,
                contentDescription = null,
                modifier = Modifier.size(48.dp),
                tint = if (isOnShift) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
            )

            Spacer(Modifier.height(12.dp))

            Text(
                text = if (isOnShift) {
                    stringResource(R.string.shifts_on_shift)
                } else {
                    stringResource(R.string.shifts_off_shift)
                },
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.testTag("clock-status-text"),
            )

            if (isOnShift && startedAt != null) {
                Text(
                    text = stringResource(R.string.shifts_since, DateFormatUtils.formatTimeOnly(startedAt)),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.testTag("clock-started-at"),
                )
            }

            Spacer(Modifier.height(16.dp))

            if (isLoading) {
                CircularProgressIndicator(
                    modifier = Modifier
                        .size(40.dp)
                        .testTag("clock-loading"),
                    strokeWidth = 3.dp,
                )
            } else if (isOnShift) {
                Button(
                    onClick = onClockOut,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.error,
                    ),
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("clock-out-button"),
                ) {
                    Text(stringResource(R.string.shifts_clock_out))
                }
            } else {
                Button(
                    onClick = onClockIn,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("clock-in-button"),
                ) {
                    Text(stringResource(R.string.shifts_clock_in))
                }
            }
        }
    }
}

/**
 * Individual shift card with time, status badge, and sign up/drop action.
 */
@Composable
private fun ShiftCard(
    shift: ShiftResponse,
    pendingRequest: SharedCreateShiftJoinRequestBodyType?,
    onSignUp: () -> Unit,
    onDrop: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .testTag("shift-card-${shift.id}"),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Time range
            Column(
                modifier = Modifier.weight(1f),
            ) {
                Text(
                    text = "${shift.startTime} - ${shift.endTime}",
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier.testTag("shift-time-${shift.id}"),
                )

                Spacer(Modifier.height(4.dp))

                // Days
                Text(
                    text = shift.dayIndices.joinToString(", ") { DateFormatUtils.shortDayName(it) },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Spacer(Modifier.width(12.dp))

            // Status badge + action
            Column(
                horizontalAlignment = Alignment.End,
            ) {
                // Status badge
                Text(
                    text = when (shift.displayStatus) {
                        "available" -> stringResource(R.string.shifts_available)
                        "assigned" -> stringResource(R.string.shifts_assigned)
                        else -> shift.displayStatus.replaceFirstChar { it.uppercase() }
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = when (shift.displayStatus) {
                        "available" -> MaterialTheme.colorScheme.primary
                        "assigned" -> MaterialTheme.colorScheme.tertiary
                        else -> MaterialTheme.colorScheme.onSurfaceVariant
                    },
                    modifier = Modifier.testTag("shift-status-${shift.id}"),
                )

                Spacer(Modifier.height(8.dp))

                when {
                    pendingRequest != null -> {
                        Column(
                            horizontalAlignment = Alignment.End,
                            modifier = Modifier.testTag("shift-request-pending-${shift.id}"),
                        ) {
                            Text(
                                text = stringResource(
                                    when (pendingRequest) {
                                        SharedCreateShiftJoinRequestBodyType.Join -> R.string.shifts_requests_type_join
                                        SharedCreateShiftJoinRequestBodyType.Leave -> R.string.shifts_requests_type_leave
                                    },
                                ),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(
                                text = stringResource(R.string.shifts_requests_status_pending),
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.secondary,
                            )
                        }
                    }

                    shift.displayStatus == "available" -> {
                        FilledTonalButton(
                            onClick = onSignUp,
                            modifier = Modifier.testTag("shift-signup-${shift.id}"),
                        ) {
                            Text(stringResource(R.string.shifts_sign_up))
                        }
                    }

                    shift.displayStatus == "assigned" -> {
                        OutlinedButton(
                            onClick = onDrop,
                            modifier = Modifier.testTag("shift-drop-${shift.id}"),
                        ) {
                            Text(stringResource(R.string.shifts_drop))
                        }
                    }
                }
            }
        }
    }
}

/**
 * Empty state when no shifts are available.
 */
@Composable
private fun EmptyShiftsState(
    modifier: Modifier = Modifier,
) {
    org.llamenos.hotline.ui.components.EmptyState(
        icon = Icons.Filled.CalendarMonth,
        title = stringResource(R.string.shifts_empty),
        subtitle = stringResource(R.string.shifts_empty_subtitle),
        testTag = "shifts-empty",
        modifier = modifier,
    )
}


