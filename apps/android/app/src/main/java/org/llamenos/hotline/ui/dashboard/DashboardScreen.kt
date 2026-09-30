package org.llamenos.hotline.ui.dashboard

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Assignment
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.filled.Business
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Assessment
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.HelpOutline
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import org.llamenos.hotline.api.WebSocketService
import org.llamenos.hotline.util.DateFormatUtils
import org.llamenos.hotline.ui.notes.DecryptedNote
import org.llamenos.hotline.ui.notes.NotesViewModel

/**
 * Enhanced dashboard screen showing shift status, connection state, active calls,
 * recent notes preview, and quick actions.
 *
 * This is the main screen after authentication, displayed in the Dashboard tab
 * of the bottom navigation. It subscribes to WebSocket events for real-time
 * updates and shows the 3 most recent notes for quick access.
 *
 * @param viewModel Hilt-injected ViewModel for dashboard state
 * @param notesViewModel Shared NotesViewModel for recent notes preview
 * @param onLock Callback to lock the app (clears key from memory, navigates to PIN unlock)
 * @param onLogout Callback to fully logout (clears stored keys, navigates to login)
 * @param onNavigateToNotes Callback to switch to the Notes tab
 * @param onNavigateToNoteDetail Callback to navigate to a specific note detail screen
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DashboardScreen(
    viewModel: DashboardViewModel,
    notesViewModel: NotesViewModel,
    onLock: () -> Unit,
    onLogout: () -> Unit,
    onNavigateToNotes: () -> Unit,
    onNavigateToNoteDetail: (String) -> Unit,
    onNavigateToCallHistory: () -> Unit,
    onNavigateToReports: () -> Unit,
    onNavigateToContacts: () -> Unit,
    onNavigateToCases: () -> Unit,
    onNavigateToBlasts: () -> Unit,
    onNavigateToHelp: () -> Unit,
    onNavigateToHubs: () -> Unit = {},
    onNavigateToEvents: () -> Unit = {},
    onNavigateToTriage: () -> Unit = {},
    /** Extra work for pull-to-refresh beyond this screen's own view models (hub selection). */
    onRefresh: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()
    val notesUiState by notesViewModel.uiState.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = stringResource(R.string.app_name),
                        modifier = Modifier.testTag("dashboard-title"),
                    )
                },
                actions = {
                    // Connection status indicator in the top bar
                    val statusColor = when (uiState.connectionState) {
                        WebSocketService.ConnectionState.CONNECTED ->
                            MaterialTheme.colorScheme.primary

                        WebSocketService.ConnectionState.CONNECTING,
                        WebSocketService.ConnectionState.RECONNECTING ->
                            MaterialTheme.colorScheme.tertiary

                        WebSocketService.ConnectionState.DISCONNECTED ->
                            MaterialTheme.colorScheme.error
                    }
                    Icon(
                        imageVector = Icons.Filled.Circle,
                        contentDescription = null,
                        tint = statusColor,
                        modifier = Modifier
                            .size(10.dp)
                            .testTag("topbar-connection-dot"),
                    )
                    Spacer(Modifier.width(8.dp))

                    // Lock button
                    IconButton(
                        onClick = onLock,
                        modifier = Modifier.testTag("lock-button"),
                    ) {
                        Icon(
                            imageVector = Icons.Filled.Lock,
                            contentDescription = stringResource(R.string.lock_app),
                            tint = MaterialTheme.colorScheme.onPrimaryContainer,
                        )
                    }
                    // Logout button
                    IconButton(
                        onClick = onLogout,
                        modifier = Modifier.testTag("logout-button"),
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ExitToApp,
                            contentDescription = stringResource(R.string.common_logout),
                            tint = MaterialTheme.colorScheme.onPrimaryContainer,
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
            onRefresh = {
                viewModel.refresh()
                notesViewModel.refresh()
                onRefresh()
            },
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .testTag("dashboard-pull-refresh"),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(16.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                // Active call card (shown above everything when on a call)
                val currentCall = uiState.currentCall
                if (currentCall != null) {
                    ActiveCallCard(
                        call = currentCall,
                        onHangup = { viewModel.hangupCall() },
                        onReportSpam = { viewModel.reportSpam() },
                        onBanAndHangup = { reason -> viewModel.banAndHangup(reason) },
                        onQuickNote = onNavigateToNotes,
                        isHangingUp = uiState.isHangingUp,
                        isReportingSpam = uiState.isReportingSpam,
                        isBanning = uiState.isBanning,
                    )
                }

                // Connection status card
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("connection-card"),
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
                        val (statusColor, statusText) = when (uiState.connectionState) {
                            WebSocketService.ConnectionState.CONNECTED ->
                                MaterialTheme.colorScheme.primary to stringResource(R.string.status_connected)

                            WebSocketService.ConnectionState.CONNECTING ->
                                MaterialTheme.colorScheme.tertiary to stringResource(R.string.status_connecting)

                            WebSocketService.ConnectionState.RECONNECTING ->
                                MaterialTheme.colorScheme.tertiary to stringResource(R.string.status_reconnecting)

                            WebSocketService.ConnectionState.DISCONNECTED ->
                                MaterialTheme.colorScheme.error to stringResource(R.string.status_disconnected)
                        }

                        Icon(
                            imageVector = Icons.Filled.Circle,
                            contentDescription = null,
                            tint = statusColor,
                            modifier = Modifier.size(12.dp),
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            text = statusText,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.testTag("connection-status"),
                        )
                    }
                }

                // Error card (dismissible)
                val errorRes = uiState.errorRes
                if (errorRes != null) {
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("dashboard-error-card"),
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.errorContainer,
                        ),
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 16.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = stringResource(errorRes),
                                modifier = Modifier
                                    .weight(1f)
                                    .testTag("dashboard-error-text"),
                                color = MaterialTheme.colorScheme.onErrorContainer,
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            IconButton(
                                onClick = { viewModel.dismissError() },
                                modifier = Modifier
                                    .size(32.dp)
                                    .testTag("dashboard-error-dismiss"),
                            ) {
                                Icon(
                                    imageVector = Icons.Filled.Close,
                                    contentDescription = stringResource(R.string.dismiss),
                                    tint = MaterialTheme.colorScheme.onErrorContainer,
                                    modifier = Modifier.size(18.dp),
                                )
                            }
                        }
                    }
                }

                // Shift status card with clock in/out quick action
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("shift-card"),
                    elevation = CardDefaults.elevatedCardElevation(
                        defaultElevation = if (uiState.isOnShift) 4.dp else 1.dp,
                    ),
                    colors = CardDefaults.cardColors(
                        containerColor = if (uiState.isOnShift) {
                            MaterialTheme.colorScheme.primaryContainer
                        } else {
                            MaterialTheme.colorScheme.surfaceVariant
                        },
                    ),
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Column {
                                Text(
                                    text = stringResource(R.string.shifts_status),
                                    style = MaterialTheme.typography.titleMedium,
                                )
                                Spacer(Modifier.height(4.dp))
                                Text(
                                    text = if (uiState.isOnShift) {
                                        stringResource(R.string.shifts_on_shift)
                                    } else {
                                        stringResource(R.string.shifts_off_shift)
                                    },
                                    style = MaterialTheme.typography.bodyLarge,
                                    fontWeight = FontWeight.Medium,
                                    color = if (uiState.isOnShift) {
                                        MaterialTheme.colorScheme.primary
                                    } else {
                                        MaterialTheme.colorScheme.onSurfaceVariant
                                    },
                                    modifier = Modifier.testTag("shift-status-text"),
                                )
                            }

                            // Quick clock in/out button
                            Button(
                                onClick = {
                                    if (uiState.isOnShift) {
                                        viewModel.clockOut()
                                    } else {
                                        viewModel.clockIn()
                                    }
                                },
                                enabled = !uiState.isClockingInOut,
                                colors = if (uiState.isOnShift) {
                                    ButtonDefaults.buttonColors(
                                        containerColor = MaterialTheme.colorScheme.error,
                                    )
                                } else {
                                    ButtonDefaults.buttonColors()
                                },
                                modifier = Modifier.testTag("dashboard-clock-button"),
                            ) {
                                Icon(
                                    imageVector = Icons.Filled.CalendarMonth,
                                    contentDescription = null,
                                    modifier = Modifier.size(18.dp),
                                )
                                Spacer(Modifier.width(4.dp))
                                Text(
                                    text = if (uiState.isOnShift) {
                                        stringResource(R.string.shifts_clock_out)
                                    } else {
                                        stringResource(R.string.shifts_clock_in)
                                    },
                                )
                            }
                        }

                        // Active shift timer
                        val startedAt = uiState.shiftStartedAt
                        if (uiState.isOnShift && startedAt != null) {
                            Spacer(Modifier.height(8.dp))
                            Text(
                                text = stringResource(R.string.active_since, DateFormatUtils.formatTimeOnly(startedAt)),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.7f),
                                modifier = Modifier.testTag("shift-timer"),
                            )
                        }

                        // Break toggle (only when on shift)
                        if (uiState.isOnShift) {
                            Spacer(Modifier.height(8.dp))
                            Button(
                                onClick = { viewModel.toggleBreak() },
                                enabled = !uiState.isTogglingBreak,
                                colors = if (uiState.isOnBreak) {
                                    ButtonDefaults.buttonColors(
                                        containerColor = MaterialTheme.colorScheme.secondary,
                                    )
                                } else {
                                    ButtonDefaults.buttonColors(
                                        containerColor = MaterialTheme.colorScheme.secondaryContainer,
                                        contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
                                    )
                                },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .testTag("dashboard-break-button"),
                            ) {
                                Text(
                                    text = if (uiState.isOnBreak) {
                                        stringResource(R.string.dashboard_end_break)
                                    } else {
                                        stringResource(R.string.dashboard_go_on_break)
                                    },
                                )
                            }
                        }
                    }
                }

                // On-break banner
                if (uiState.isOnBreak && uiState.isOnShift) {
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("break-banner"),
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.secondaryContainer,
                        ),
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = stringResource(R.string.dashboard_on_break),
                                style = MaterialTheme.typography.titleMedium,
                                color = MaterialTheme.colorScheme.onSecondaryContainer,
                                modifier = Modifier.testTag("break-banner-text"),
                            )
                        }
                    }
                }

                // Calls stats card
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("calls-card"),
                    elevation = CardDefaults.elevatedCardElevation(
                        defaultElevation = if (uiState.activeCallCount > 0) 4.dp else 1.dp,
                    ),
                    colors = CardDefaults.cardColors(
                        containerColor = if (uiState.activeCallCount > 0) {
                            MaterialTheme.colorScheme.primaryContainer
                        } else {
                            MaterialTheme.colorScheme.surfaceVariant
                        },
                    ),
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                imageVector = Icons.Filled.Phone,
                                contentDescription = null,
                                tint = if (uiState.activeCallCount > 0) {
                                    MaterialTheme.colorScheme.onPrimaryContainer
                                } else {
                                    MaterialTheme.colorScheme.primary
                                },
                            )
                            Spacer(Modifier.width(12.dp))
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = stringResource(R.string.active_calls),
                                    style = MaterialTheme.typography.titleMedium,
                                )
                                Text(
                                    text = uiState.activeCallCount.toString(),
                                    style = MaterialTheme.typography.headlineMedium,
                                    fontWeight = FontWeight.Bold,
                                    color = if (uiState.activeCallCount > 0) {
                                        MaterialTheme.colorScheme.onPrimaryContainer
                                    } else {
                                        MaterialTheme.colorScheme.primary
                                    },
                                    modifier = Modifier.testTag("active-call-count"),
                                )
                            }
                            TextButton(
                                onClick = onNavigateToCallHistory,
                                modifier = Modifier.testTag("view-call-history"),
                            ) {
                                Text(stringResource(R.string.dashboard_view_calls))
                            }
                        }

                        // Calls today
                        Spacer(Modifier.height(8.dp))
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = stringResource(R.string.dashboard_calls_today),
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                text = uiState.callsToday.toString(),
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Bold,
                                color = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.testTag("calls-today-count"),
                            )
                        }
                    }
                }

                // Personal analytics stat cards (calls today, answer rate, avg duration)
                AnalyticsStatCards(
                    callsToday = uiState.callsToday,
                    answerRate = uiState.answerRate,
                    avgDurationSeconds = uiState.avgDurationSeconds,
                )

                // Quick actions grid (2x2)
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("quick-actions-grid"),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    QuickActionCard(
                        icon = Icons.Filled.Assessment,
                        label = stringResource(R.string.reports_title),
                        onClick = onNavigateToReports,
                        tint = MaterialTheme.colorScheme.primary,
                        containerColor = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.4f),
                        testTag = "reports-card",
                        modifier = Modifier.weight(1f),
                    )
                    QuickActionCard(
                        icon = Icons.Filled.People,
                        label = stringResource(R.string.contacts_title),
                        onClick = onNavigateToContacts,
                        tint = MaterialTheme.colorScheme.primary,
                        containerColor = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.4f),
                        testTag = "contacts-card",
                        modifier = Modifier.weight(1f),
                    )
                }
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    QuickActionCard(
                        icon = Icons.Filled.Folder,
                        label = "Cases",
                        onClick = onNavigateToCases,
                        tint = MaterialTheme.colorScheme.primary,
                        containerColor = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.4f),
                        testTag = "cases-card",
                        modifier = Modifier.weight(1f),
                    )
                    QuickActionCard(
                        icon = Icons.Filled.Campaign,
                        label = stringResource(R.string.blasts_title),
                        onClick = onNavigateToBlasts,
                        tint = MaterialTheme.colorScheme.tertiary,
                        testTag = "blasts-card",
                        modifier = Modifier.weight(1f),
                    )
                }
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    QuickActionCard(
                        icon = Icons.Filled.Business,
                        label = stringResource(R.string.hubs_title),
                        onClick = onNavigateToHubs,
                        tint = MaterialTheme.colorScheme.primary,
                        containerColor = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.4f),
                        testTag = "hubs-card",
                        modifier = Modifier.weight(1f),
                    )
                    QuickActionCard(
                        icon = Icons.Filled.CalendarMonth,
                        label = stringResource(R.string.events_title),
                        onClick = onNavigateToEvents,
                        tint = MaterialTheme.colorScheme.primary,
                        containerColor = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.4f),
                        testTag = "events-card",
                        modifier = Modifier.weight(1f),
                    )
                }
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    QuickActionCard(
                        icon = Icons.Filled.HelpOutline,
                        label = stringResource(R.string.help_title),
                        onClick = onNavigateToHelp,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        testTag = "help-card",
                        modifier = Modifier.weight(1f),
                    )
                    QuickActionCard(
                        icon = Icons.AutoMirrored.Filled.Assignment,
                        label = stringResource(R.string.triage_title),
                        onClick = onNavigateToTriage,
                        tint = MaterialTheme.colorScheme.tertiary,
                        containerColor = MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.4f),
                        testTag = "triage-card",
                        modifier = Modifier.weight(1f),
                    )
                }

                // Recent notes preview
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("recent-notes-card"),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant,
                    ),
                ) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = stringResource(R.string.dashboard_recent_notes),
                                style = MaterialTheme.typography.titleMedium,
                            )
                            TextButton(
                                onClick = onNavigateToNotes,
                                modifier = Modifier.testTag("view-all-notes"),
                            ) {
                                Text(stringResource(R.string.dashboard_view_all_notes))
                            }
                        }

                        val recentNotes = notesUiState.notes.take(3)

                        if (recentNotes.isEmpty()) {
                            Spacer(Modifier.height(8.dp))
                            Text(
                                text = stringResource(R.string.dashboard_no_recent_notes),
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                                modifier = Modifier.testTag("no-recent-notes"),
                            )
                        } else {
                            recentNotes.forEach { note ->
                                RecentNoteItem(
                                    note = note,
                                    onClick = {
                                        notesViewModel.selectNote(note)
                                        onNavigateToNoteDetail(note.id)
                                    },
                                )
                            }
                        }
                    }
                }

                // Identity info
                if (uiState.signingPubkey.isNotEmpty()) {
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("identity-card"),
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                        ),
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                imageVector = Icons.Filled.Lock,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                                modifier = Modifier.size(16.dp),
                            )
                            Spacer(Modifier.width(8.dp))
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = stringResource(R.string.your_identity),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                                )
                                Text(
                                    text = uiState.signingPubkey,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurface,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.testTag("dashboard-identity"),
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
 * Compact quick action card for the 2x2 grid layout.
 */
@Composable
private fun QuickActionCard(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    onClick: () -> Unit,
    tint: androidx.compose.ui.graphics.Color,
    testTag: String,
    modifier: Modifier = Modifier,
    containerColor: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.surfaceVariant,
) {
    Card(
        modifier = modifier
            .clickable(onClick = onClick)
            .testTag(testTag),
        colors = CardDefaults.cardColors(
            containerColor = containerColor,
        ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 20.dp, horizontal = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = tint,
                modifier = Modifier.size(32.dp),
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = label,
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/**
 * Compact note preview for the dashboard recent notes section.
 */
@Composable
private fun RecentNoteItem(
    note: DecryptedNote,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .clickable(onClick = onClick)
            .testTag("recent-note-${note.id}"),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface,
        ),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = note.text,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Spacer(Modifier.width(8.dp))
            Text(
                text = DateFormatUtils.formatTimeOnly(note.createdAt),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
            )
        }
    }
}