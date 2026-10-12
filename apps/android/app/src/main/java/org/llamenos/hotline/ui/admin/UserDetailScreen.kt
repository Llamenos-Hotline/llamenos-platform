package org.llamenos.hotline.ui.admin

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Security
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import org.llamenos.hotline.R
import org.llamenos.protocol.SharedEntry
import org.llamenos.hotline.model.detailsString
import org.llamenos.hotline.model.displayName
import org.llamenos.hotline.model.name
import org.llamenos.hotline.model.role
import org.llamenos.hotline.model.status
import org.llamenos.hotline.model.timestamp

/**
 * Volunteer detail/profile screen for admins.
 *
 * Shows volunteer information, role/status badges, assigned shifts,
 * and recent activity from the audit log.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UserDetailScreen(
    pubkey: String,
    onNavigateBack: () -> Unit,
    modifier: Modifier = Modifier,
    viewModel: UserDetailViewModel = hiltViewModel(),
) {
    val uiState by viewModel.uiState.collectAsState()

    LaunchedEffect(pubkey) {
        viewModel.loadUser(pubkey)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = uiState.volunteer?.displayName
                            ?: stringResource(R.string.users_detail_title),
                        modifier = Modifier.testTag("volunteer-detail-title"),
                    )
                },
                navigationIcon = {
                    IconButton(
                        onClick = onNavigateBack,
                        modifier = Modifier.testTag("volunteer-detail-back"),
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.nav_settings),
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        modifier = modifier,
    ) { paddingValues ->
        when {
            uiState.isLoading -> {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(paddingValues)
                        .testTag("volunteer-detail-loading"),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator()
                }
            }

            uiState.volunteer == null && !uiState.isLoading -> {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(paddingValues)
                        .testTag("volunteer-detail-not-found"),
                    contentAlignment = Alignment.Center,
                ) {
                    org.llamenos.hotline.ui.components.EmptyState(
                        icon = Icons.Filled.Person,
                        title = stringResource(R.string.users_not_found),
                        testTag = "volunteer-not-found",
                    )
                }
            }

            else -> {
                val volunteer = uiState.volunteer!!

                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(paddingValues)
                        .verticalScroll(rememberScrollState())
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    // Profile card
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("volunteer-info-card"),
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
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Icon(
                                    imageVector = Icons.Filled.Person,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.primary,
                                    modifier = Modifier.size(40.dp),
                                )
                                Spacer(Modifier.width(12.dp))
                                Column {
                                    Text(
                                        text = volunteer.displayName ?: volunteer.pubkey.take(16) + "...",
                                        style = MaterialTheme.typography.titleLarge,
                                        fontWeight = FontWeight.Bold,
                                        modifier = Modifier.testTag("volunteer-name"),
                                    )
                                    Text(
                                        text = volunteer.pubkey,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.testTag("volunteer-pubkey"),
                                    )
                                }
                            }

                            Spacer(Modifier.height(12.dp))

                            Row(
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                AssistChip(
                                    onClick = {},
                                    label = {
                                        Text(
                                            text = volunteer.role.removePrefix("role-").replaceFirstChar { it.uppercase() },
                                            style = MaterialTheme.typography.labelMedium,
                                        )
                                    },
                                    leadingIcon = {
                                        Icon(
                                            imageVector = Icons.Filled.Security,
                                            contentDescription = null,
                                            modifier = Modifier.size(16.dp),
                                        )
                                    },
                                    modifier = Modifier.testTag("volunteer-role-badge"),
                                )
                                AssistChip(
                                    onClick = {},
                                    label = {
                                        Text(
                                            text = volunteer.status.replaceFirstChar { it.uppercase() },
                                            style = MaterialTheme.typography.labelMedium,
                                        )
                                    },
                                    modifier = Modifier.testTag("volunteer-status-badge"),
                                )
                            }

                            Spacer(Modifier.height(8.dp))
                            Text(
                                text = stringResource(R.string.users_joined, volunteer.createdAt.take(10)),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                                modifier = Modifier.testTag("volunteer-joined"),
                            )
                        }
                    }

                    // Assigned shifts
                    if (uiState.shifts.isNotEmpty()) {
                        Card(
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag("volunteer-shifts-card"),
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.surfaceVariant,
                            ),
                        ) {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(16.dp),
                            ) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(
                                        imageVector = Icons.Filled.CalendarMonth,
                                        contentDescription = null,
                                        tint = MaterialTheme.colorScheme.primary,
                                        modifier = Modifier.size(20.dp),
                                    )
                                    Spacer(Modifier.width(8.dp))
                                    Text(
                                        text = stringResource(R.string.users_assigned_shifts),
                                        style = MaterialTheme.typography.titleMedium,
                                    )
                                }
                                Spacer(Modifier.height(8.dp))
                                uiState.shifts.forEach { shift ->
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .padding(vertical = 4.dp)
                                            .testTag("volunteer-shift-${shift.id}"),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Text(
                                            text = shift.name,
                                            style = MaterialTheme.typography.bodyMedium,
                                            modifier = Modifier.weight(1f),
                                        )
                                        Text(
                                            text = "${shift.startTime} - ${shift.endTime}",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                }
                            }
                        }
                    }

                    // Recent activity
                    Card(
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("volunteer-activity-card"),
                        colors = CardDefaults.cardColors(
                            containerColor = MaterialTheme.colorScheme.surfaceVariant,
                        ),
                    ) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(16.dp),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(
                                    imageVector = Icons.Filled.History,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.primary,
                                    modifier = Modifier.size(20.dp),
                                )
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    text = stringResource(R.string.users_recent_activity),
                                    style = MaterialTheme.typography.titleMedium,
                                )
                            }
                            Spacer(Modifier.height(8.dp))

                            if (uiState.isLoadingAudit) {
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
                            } else if (uiState.auditEntries.isEmpty()) {
                                Text(
                                    text = stringResource(R.string.users_no_activity),
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                                    modifier = Modifier.testTag("volunteer-no-activity"),
                                )
                            } else {
                                uiState.auditEntries.take(10).forEachIndexed { index, entry ->
                                    ActivityRow(entry = entry)
                                    if (index < uiState.auditEntries.size - 1 && index < 9) {
                                        HorizontalDivider(
                                            color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.3f),
                                        )
                                    }
                                }
                            }
                        }
                    }

                    // Error
                    if (uiState.error != null) {
                        org.llamenos.hotline.ui.components.ErrorCard(
                            error = uiState.error ?: "",
                            onDismiss = { viewModel.dismissError() },
                            onRetry = { viewModel.loadUser(pubkey) },
                            testTag = "volunteer-detail-error",
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ActivityRow(
    entry: SharedEntry,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp)
            .testTag("activity-${entry.id}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = entry.action.replace("_", " ").split(" ").joinToString(" ") { word ->
                    word.replaceFirstChar { it.uppercase() }
                },
                style = MaterialTheme.typography.bodyMedium,
            )
            val detailsText = entry.detailsString
            if (detailsText != null) {
                Text(
                    text = detailsText,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Text(
            text = entry.timestamp.take(10),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
        )
    }
}
