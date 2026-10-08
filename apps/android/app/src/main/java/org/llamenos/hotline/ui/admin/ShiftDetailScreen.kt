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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
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
import org.llamenos.hotline.model.User
import org.llamenos.hotline.model.dayIndices
import org.llamenos.hotline.model.displayName
import org.llamenos.hotline.model.id
import org.llamenos.hotline.model.name
import org.llamenos.hotline.model.role
import org.llamenos.hotline.util.DateFormatUtils

/**
 * Shift detail screen for admins.
 *
 * Shows shift info (name, time, days) and a list of all volunteers
 * with toggles to assign/unassign them from this shift.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShiftDetailScreen(
    shiftId: String,
    onNavigateBack: () -> Unit,
    modifier: Modifier = Modifier,
    viewModel: ShiftDetailViewModel = hiltViewModel(),
) {
    val uiState by viewModel.uiState.collectAsState()

    LaunchedEffect(shiftId) {
        viewModel.loadShift(shiftId)
    }

    // Navigate back after save
    LaunchedEffect(uiState.saveSuccess) {
        if (uiState.saveSuccess) {
            onNavigateBack()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = uiState.shift?.name ?: stringResource(R.string.shifts_detail_title),
                        modifier = Modifier.testTag("shift-detail-title"),
                    )
                },
                navigationIcon = {
                    IconButton(
                        onClick = onNavigateBack,
                        modifier = Modifier.testTag("shift-detail-back"),
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
                        .testTag("shift-detail-loading"),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator()
                }
            }

            uiState.shift == null && !uiState.isLoading -> {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(paddingValues)
                        .testTag("shift-detail-not-found"),
                    contentAlignment = Alignment.Center,
                ) {
                    org.llamenos.hotline.ui.components.EmptyState(
                        icon = Icons.Filled.Schedule,
                        title = stringResource(R.string.shifts_not_found),
                        testTag = "shift-not-found",
                    )
                }
            }

            else -> {
                val shift = uiState.shift!!

                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(paddingValues),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    // Shift info card
                    item {
                        Card(
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag("shift-info-card"),
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
                                        imageVector = Icons.Filled.Schedule,
                                        contentDescription = null,
                                        tint = MaterialTheme.colorScheme.primary,
                                        modifier = Modifier.size(32.dp),
                                    )
                                    Spacer(Modifier.width(12.dp))
                                    Column {
                                        Text(
                                            text = shift.name,
                                            style = MaterialTheme.typography.titleLarge,
                                            fontWeight = FontWeight.Bold,
                                            modifier = Modifier.testTag("shift-detail-name"),
                                        )
                                        Text(
                                            text = "${shift.startTime} - ${shift.endTime}",
                                            style = MaterialTheme.typography.bodyMedium,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            modifier = Modifier.testTag("shift-detail-time"),
                                        )
                                    }
                                }

                                if (shift.dayIndices.isNotEmpty()) {
                                    Spacer(Modifier.height(8.dp))
                                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                        shift.dayIndices.forEach { day ->
                                            AssistChip(
                                                onClick = {},
                                                label = {
                                                    Text(
                                                        text = DateFormatUtils.shortDayName(day),
                                                        style = MaterialTheme.typography.labelSmall,
                                                    )
                                                },
                                                modifier = Modifier
                                                    .height(28.dp)
                                                    .testTag("shift-day-$day"),
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Section header
                    item {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.padding(top = 4.dp),
                        ) {
                            Icon(
                                imageVector = Icons.Filled.Person,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.size(20.dp),
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                text = stringResource(R.string.shifts_assign_users),
                                style = MaterialTheme.typography.titleMedium,
                            )
                            Spacer(Modifier.weight(1f))
                            Text(
                                text = "${uiState.assignedPubkeys.size} / ${uiState.allVolunteers.size}",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.testTag("shift-assigned-count"),
                            )
                        }
                    }

                    // Volunteer list with toggles
                    items(
                        items = uiState.allVolunteers,
                        key = { it.id },
                    ) { volunteer ->
                        VolunteerAssignmentCard(
                            volunteer = volunteer,
                            isAssigned = volunteer.pubkey in uiState.assignedPubkeys,
                            onToggle = { viewModel.toggleVolunteer(volunteer.pubkey) },
                        )
                    }

                    // Error card
                    if (uiState.error != null) {
                        item {
                            org.llamenos.hotline.ui.components.ErrorCard(
                                error = uiState.error ?: "",
                                onDismiss = { viewModel.dismissError() },
                                onRetry = { viewModel.loadShift(shiftId) },
                                testTag = "shift-detail-error",
                            )
                        }
                    }

                    // Save button
                    item {
                        Spacer(Modifier.height(4.dp))
                        Button(
                            onClick = { viewModel.saveAssignments() },
                            enabled = !uiState.isSaving,
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag("shift-save-assignments"),
                        ) {
                            if (uiState.isSaving) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(20.dp),
                                    strokeWidth = 2.dp,
                                    color = MaterialTheme.colorScheme.onPrimary,
                                )
                                Spacer(Modifier.width(8.dp))
                            }
                            Text(stringResource(R.string.shifts_save_assignments))
                        }
                    }
                }
            }
        }
    }
}

/**
 * Card for a single volunteer with assignment toggle.
 */
@Composable
private fun VolunteerAssignmentCard(
    volunteer: User,
    isAssigned: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        onClick = onToggle,
        modifier = modifier
            .fillMaxWidth()
            .testTag("volunteer-assign-${volunteer.id}"),
        colors = CardDefaults.cardColors(
            containerColor = if (isAssigned) {
                MaterialTheme.colorScheme.primaryContainer
            } else {
                MaterialTheme.colorScheme.surfaceVariant
            },
        ),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = if (isAssigned) Icons.Filled.CheckCircle else Icons.Filled.RadioButtonUnchecked,
                contentDescription = null,
                tint = if (isAssigned) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f)
                },
                modifier = Modifier.size(24.dp),
            )

            Spacer(Modifier.width(12.dp))

            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = volunteer.displayName ?: stringResource(R.string.users_unnamed),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (isAssigned) FontWeight.Medium else FontWeight.Normal,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = volunteer.pubkey.take(8) + "..." + volunteer.pubkey.takeLast(8),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                    maxLines = 1,
                )
            }

            // Role badge
            Text(
                text = volunteer.role.removePrefix("role-").replaceFirstChar { it.uppercase() },
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
