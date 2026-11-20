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
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R
import org.llamenos.hotline.ui.components.SecureWindowEffect
import org.llamenos.hotline.model.RecoveryGroupInfo
import org.llamenos.hotline.model.ShareHolderLiveness

/**
 * Admin screen for configuring a recovery team.
 *
 * Two states:
 * 1. Setup — threshold/total pickers, delay/emergency floor sliders, "Set up" button
 * 2. Configured — status cards, contact health list, rotate button
 */
@Composable
fun RecoveryTeamConfigScreen(
    groupInfo: RecoveryGroupInfo?,
    isLoading: Boolean,
    error: String?,
    onSetup: (threshold: Int, total: Int, delayHours: Int, emergencyFloorHours: Int) -> Unit,
    onRotate: () -> Unit,
    modifier: Modifier = Modifier,
) {
    SecureWindowEffect()

    if (isLoading) {
        Box(
            modifier = modifier.fillMaxSize(),
            contentAlignment = Alignment.Center,
        ) {
            CircularProgressIndicator(modifier = Modifier.testTag("recovery-loading"))
        }
        return
    }

    if (groupInfo == null) {
        RecoveryTeamSetupView(
            error = error,
            onSetup = onSetup,
            modifier = modifier,
        )
    } else {
        RecoveryTeamConfiguredView(
            groupInfo = groupInfo,
            error = error,
            onRotate = onRotate,
            modifier = modifier,
        )
    }
}

@Composable
private fun RecoveryTeamSetupView(
    error: String?,
    onSetup: (threshold: Int, total: Int, delayHours: Int, emergencyFloorHours: Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    var threshold by remember { mutableIntStateOf(3) }
    var total by remember { mutableIntStateOf(5) }
    var delayHours by remember { mutableFloatStateOf(24f) }
    var emergencyFloorHours by remember { mutableFloatStateOf(4f) }

    val isValid = threshold in 2..total && total >= 3

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
    ) {
        // Header
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Icon(
                imageVector = Icons.Filled.Group,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(28.dp),
            )
            Spacer(Modifier.width(12.dp))
            Text(
                text = stringResource(R.string.recovery_group_title),
                style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.Bold),
            )
        }

        Spacer(Modifier.height(8.dp))

        Text(
            text = stringResource(R.string.recovery_group_description),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(Modifier.height(24.dp))

        // Threshold picker
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .testTag("recovery-threshold-card"),
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
            ),
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text(
                    text = stringResource(R.string.recovery_group_required_approvals),
                    style = MaterialTheme.typography.titleSmall,
                )
                Spacer(Modifier.height(8.dp))
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("recovery-threshold-picker"),
                ) {
                    IconButton(
                        onClick = { if (threshold > 2) threshold-- },
                        modifier = Modifier.testTag("threshold-decrease"),
                    ) {
                        Icon(Icons.Filled.Remove, contentDescription = null)
                    }
                    Text(
                        text = "$threshold",
                        style = MaterialTheme.typography.headlineMedium,
                        modifier = Modifier.padding(horizontal = 24.dp),
                    )
                    IconButton(
                        onClick = { if (threshold < total) threshold++ },
                        modifier = Modifier.testTag("threshold-increase"),
                    ) {
                        Icon(Icons.Filled.Add, contentDescription = null)
                    }
                }
            }
        }

        Spacer(Modifier.height(16.dp))

        // Total contacts picker
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .testTag("recovery-total-card"),
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
            ),
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text(
                    text = stringResource(R.string.recovery_group_total_contacts),
                    style = MaterialTheme.typography.titleSmall,
                )
                Spacer(Modifier.height(8.dp))
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("recovery-total-picker"),
                ) {
                    IconButton(
                        onClick = { if (total > 3) total-- },
                        modifier = Modifier.testTag("total-decrease"),
                    ) {
                        Icon(Icons.Filled.Remove, contentDescription = null)
                    }
                    Text(
                        text = "$total",
                        style = MaterialTheme.typography.headlineMedium,
                        modifier = Modifier.padding(horizontal = 24.dp),
                    )
                    IconButton(
                        onClick = { if (total < 10) total++ },
                        modifier = Modifier.testTag("total-increase"),
                    ) {
                        Icon(Icons.Filled.Add, contentDescription = null)
                    }
                }
            }
        }

        Spacer(Modifier.height(16.dp))

        // Delay slider
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
            ),
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text(
                    text = stringResource(R.string.recovery_group_delay_config),
                    style = MaterialTheme.typography.titleSmall,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "${delayHours.toInt()}h",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.primary,
                )
                Slider(
                    value = delayHours,
                    onValueChange = { delayHours = it },
                    valueRange = 1f..168f,
                    steps = 166,
                    modifier = Modifier.testTag("recovery-delay-slider"),
                )
            }
        }

        Spacer(Modifier.height(16.dp))

        // Emergency floor slider
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
            ),
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text(
                    text = stringResource(R.string.recovery_group_emergency_floor_config),
                    style = MaterialTheme.typography.titleSmall,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    text = "${emergencyFloorHours.toInt()}h",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.primary,
                )
                Slider(
                    value = emergencyFloorHours,
                    onValueChange = { emergencyFloorHours = it },
                    valueRange = 1f..48f,
                    steps = 46,
                    modifier = Modifier.testTag("recovery-emergency-floor-slider"),
                )
            }
        }

        Spacer(Modifier.height(8.dp))

        // Geo warning
        Text(
            text = stringResource(R.string.recovery_group_geo_warning),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 4.dp),
        )

        // Validation error
        if (!isValid) {
            Spacer(Modifier.height(8.dp))
            Text(
                text = stringResource(R.string.recovery_group_error_threshold_exceeds_total),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }

        // API error
        if (error != null) {
            Spacer(Modifier.height(8.dp))
            Text(
                text = error,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.testTag("recovery-setup-error"),
            )
        }

        Spacer(Modifier.height(24.dp))

        // Setup button
        Button(
            onClick = {
                onSetup(threshold, total, delayHours.toInt(), emergencyFloorHours.toInt())
            },
            enabled = isValid,
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp)
                .testTag("setup-recovery-team-button"),
        ) {
            Text(text = stringResource(R.string.recovery_group_setup))
        }
    }
}

@Composable
private fun RecoveryTeamConfiguredView(
    groupInfo: RecoveryGroupInfo,
    error: String?,
    onRotate: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var showRotateDialog by remember { mutableStateOf(false) }

    if (showRotateDialog) {
        AlertDialog(
            onDismissRequest = { showRotateDialog = false },
            title = { Text(stringResource(R.string.recovery_group_rotate)) },
            text = {
                Text(
                    stringResource(R.string.recovery_group_description),
                    style = MaterialTheme.typography.bodyMedium,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        showRotateDialog = false
                        onRotate()
                    },
                    modifier = Modifier.testTag("confirm-rotate-button"),
                ) {
                    Text(stringResource(R.string.recovery_group_rotate))
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { showRotateDialog = false },
                    modifier = Modifier.testTag("cancel-rotate-button"),
                ) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
            modifier = Modifier.testTag("rotate-confirmation-dialog"),
        )
    }

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
    ) {
        // Header
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Icon(
                imageVector = Icons.Filled.Group,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(28.dp),
            )
            Spacer(Modifier.width(12.dp))
            Text(
                text = stringResource(R.string.recovery_group_title),
                style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.Bold),
            )
        }

        Spacer(Modifier.height(16.dp))

        // Status card
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .testTag("recovery-status-card"),
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.primaryContainer,
            ),
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Row {
                    Text(
                        text = stringResource(R.string.recovery_group_required_approvals),
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        text = "${groupInfo.threshold} / ${groupInfo.totalShares}",
                        style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold),
                    )
                }
                Spacer(Modifier.height(8.dp))
                Row {
                    Text(
                        text = stringResource(R.string.recovery_group_delay_config),
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        text = "${groupInfo.delayHours}h",
                        style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.Bold),
                    )
                }
                if (groupInfo.rotatedAt != null) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = "${stringResource(R.string.recovery_group_last_rotated)}: ${groupInfo.rotatedAt}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.7f),
                    )
                }
            }
        }

        Spacer(Modifier.height(16.dp))

        // Contact health section
        Text(
            text = stringResource(R.string.recovery_group_contact_health),
            style = MaterialTheme.typography.titleMedium,
        )

        Spacer(Modifier.height(8.dp))

        groupInfo.shareHolderLiveness.forEach { holder ->
            ShareHolderHealthCard(holder = holder)
            Spacer(Modifier.height(8.dp))
        }

        // Error
        if (error != null) {
            Spacer(Modifier.height(8.dp))
            Text(
                text = error,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.testTag("recovery-config-error"),
            )
        }

        Spacer(Modifier.height(24.dp))

        // Rotate button
        OutlinedButton(
            onClick = { showRotateDialog = true },
            modifier = Modifier
                .fillMaxWidth()
                .height(48.dp)
                .testTag("rotate-recovery-team-button"),
        ) {
            Icon(
                imageVector = Icons.Filled.Refresh,
                contentDescription = null,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.width(8.dp))
            Text(text = stringResource(R.string.recovery_group_rotate))
        }
    }
}

@Composable
private fun ShareHolderHealthCard(
    holder: ShareHolderLiveness,
    modifier: Modifier = Modifier,
) {
    val isHealthy = holder.lastLivenessProof != null
    // A proof that failed verification (#2782) reads as a failure, not as merely overdue.
    val hasFailed = !isHealthy && holder.lastLivenessFailure != null

    Card(
        modifier = modifier
            .fillMaxWidth()
            .testTag("share-holder-card-${holder.holderPubkey.take(8)}"),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
        ),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(12.dp),
        ) {
            Icon(
                imageVector = if (isHealthy) Icons.Filled.CheckCircle else Icons.Filled.Warning,
                contentDescription = null,
                tint = if (isHealthy) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.error
                },
                modifier = Modifier.size(20.dp),
            )
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = holder.holderPubkey.take(16) + "...",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    text = when {
                        isHealthy -> stringResource(R.string.recovery_group_liveness_ok)
                        hasFailed -> stringResource(R.string.recovery_group_liveness_failed)
                        else -> stringResource(R.string.recovery_group_liveness_stale)
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = if (isHealthy) {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    } else {
                        MaterialTheme.colorScheme.error
                    },
                )
            }
        }
    }
}
