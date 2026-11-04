package org.llamenos.hotline.ui.dashboard

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.NoteAdd
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.PhoneDisabled
import androidx.compose.material.icons.filled.ReportProblem
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import org.llamenos.hotline.R
import org.llamenos.hotline.model.ActiveCall

/**
 * In-call action card shown on the dashboard when the volunteer has an active call.
 *
 * Provides:
 * - Live call timer (updates every second)
 * - Hang up button
 * - Report spam button
 * - Ban & hang up button (with optional reason dialog)
 * - Quick note button
 *
 * @param call The active call data
 * @param onHangup Callback to hang up the call
 * @param onReportSpam Callback to report the call as spam
 * @param onBanAndHangup Callback to ban caller and hang up, with optional reason
 * @param onQuickNote Callback to navigate to note creation for this call
 * @param isHangingUp Whether a hangup request is in progress
 * @param isReportingSpam Whether a spam report is in progress
 * @param isBanning Whether a ban request is in progress
 */
@Composable
fun ActiveCallCard(
    call: ActiveCall,
    onHangup: () -> Unit,
    onReportSpam: () -> Unit,
    onBanAndHangup: (String?) -> Unit,
    onQuickNote: () -> Unit,
    isHangingUp: Boolean = false,
    isReportingSpam: Boolean = false,
    isBanning: Boolean = false,
    modifier: Modifier = Modifier,
) {
    var showBanDialog by remember { mutableStateOf(false) }
    var banReason by remember { mutableStateOf("") }

    Card(
        modifier = modifier
            .fillMaxWidth()
            .testTag("active-call-card"),
        border = BorderStroke(2.dp, MaterialTheme.colorScheme.primary),
        elevation = CardDefaults.elevatedCardElevation(defaultElevation = 4.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.3f),
        ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
        ) {
            // Header: call icon + info + timer
            CallHeader(call = call)

            Spacer(Modifier.height(12.dp))
            HorizontalDivider()
            Spacer(Modifier.height(12.dp))

            // Action buttons row: Hang Up + Report Spam
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                // Hang up button
                Button(
                    onClick = onHangup,
                    enabled = !isHangingUp,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.error,
                    ),
                    modifier = Modifier
                        .weight(1f)
                        .testTag("hangup-button"),
                ) {
                    Icon(
                        imageVector = Icons.Filled.PhoneDisabled,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(Modifier.width(4.dp))
                    Text(
                        text = stringResource(R.string.calls_hang_up),
                        fontWeight = FontWeight.SemiBold,
                    )
                }

                // Report spam button
                OutlinedButton(
                    onClick = onReportSpam,
                    enabled = !isReportingSpam,
                    border = BorderStroke(
                        1.5.dp,
                        MaterialTheme.colorScheme.tertiary.copy(alpha = 0.5f),
                    ),
                    modifier = Modifier
                        .weight(1f)
                        .testTag("report-spam-button"),
                ) {
                    Icon(
                        imageVector = Icons.Filled.ReportProblem,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.tertiary,
                        modifier = Modifier.size(18.dp),
                    )
                    Spacer(Modifier.width(4.dp))
                    Text(
                        text = stringResource(R.string.calls_report_spam),
                        color = MaterialTheme.colorScheme.tertiary,
                    )
                }
            }

            Spacer(Modifier.height(8.dp))

            // Ban & Hang Up button (full width)
            OutlinedButton(
                onClick = { showBanDialog = true },
                border = BorderStroke(
                    1.5.dp,
                    MaterialTheme.colorScheme.error.copy(alpha = 0.5f),
                ),
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("ban-hangup-button"),
            ) {
                Icon(
                    imageVector = Icons.Filled.Block,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.error,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.width(4.dp))
                Text(
                    text = stringResource(R.string.call_actions_ban_and_hang_up),
                    color = MaterialTheme.colorScheme.error,
                )
            }

            Spacer(Modifier.height(8.dp))

            // Quick note button
            OutlinedButton(
                onClick = onQuickNote,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("quick-note-button"),
            ) {
                Icon(
                    imageVector = Icons.Filled.NoteAdd,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.width(4.dp))
                Text(
                    text = stringResource(R.string.calls_add_note),
                    color = MaterialTheme.colorScheme.primary,
                )
            }
        }
    }

    // Ban reason dialog
    if (showBanDialog) {
        AlertDialog(
            onDismissRequest = {
                showBanDialog = false
                banReason = ""
            },
            title = {
                Text(stringResource(R.string.call_actions_ban_and_hang_up))
            },
            text = {
                Column {
                    Text(
                        text = stringResource(R.string.call_actions_ban_and_hang_up_confirm),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Spacer(Modifier.height(12.dp))
                    OutlinedTextField(
                        value = banReason,
                        onValueChange = { banReason = it },
                        label = { Text(stringResource(R.string.call_actions_ban_reason)) },
                        singleLine = true,
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("ban-reason-input"),
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        val reason = banReason.trim().ifEmpty { null }
                        onBanAndHangup(reason)
                        showBanDialog = false
                        banReason = ""
                    },
                    enabled = !isBanning,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.error,
                    ),
                    modifier = Modifier.testTag("ban-confirm-button"),
                ) {
                    Text(stringResource(R.string.call_actions_ban_and_hang_up))
                }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        showBanDialog = false
                        banReason = ""
                    },
                ) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
            modifier = Modifier.testTag("ban-dialog"),
        )
    }
}

/**
 * Call header with phone icon, caller info, and live elapsed timer.
 */
@Composable
private fun CallHeader(call: ActiveCall) {
    // Parse startedAt ISO string to epoch millis for timer calculation
    val startedAtMillis = remember(call.startedAt) {
        try {
            java.time.Instant.parse(call.startedAt).toEpochMilli()
        } catch (_: Exception) {
            System.currentTimeMillis()
        }
    }

    // Live timer that updates every second
    var elapsedSeconds by remember { mutableLongStateOf(0L) }
    LaunchedEffect(startedAtMillis) {
        while (true) {
            elapsedSeconds = maxOf(0, (System.currentTimeMillis() - startedAtMillis) / 1000)
            delay(1000)
        }
    }

    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Phone icon in a circle
        Surface(
            shape = CircleShape,
            color = MaterialTheme.colorScheme.primary.copy(alpha = 0.15f),
            modifier = Modifier.size(44.dp),
        ) {
            Icon(
                imageVector = Icons.Filled.Phone,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier
                    .padding(10.dp)
                    .size(24.dp),
            )
        }

        Spacer(Modifier.width(12.dp))

        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = stringResource(R.string.calls_active),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.primary,
            )
        }

        // Elapsed timer
        Column(horizontalAlignment = Alignment.End) {
            Text(
                text = formatElapsedTime(elapsedSeconds),
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.testTag("call-elapsed-timer"),
            )
            Text(
                text = stringResource(R.string.calls_duration),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/**
 * Format elapsed seconds as HH:MM:SS.
 */
private fun formatElapsedTime(totalSeconds: Long): String {
    val hours = totalSeconds / 3600
    val minutes = (totalSeconds % 3600) / 60
    val seconds = totalSeconds % 60
    return "%02d:%02d:%02d".format(hours, minutes, seconds)
}
