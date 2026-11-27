package org.llamenos.hotline.ui.cases

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R
import org.llamenos.hotline.model.EntityTypeDefinition
import org.llamenos.hotline.model.EntityTypeDefinitionStatus

/**
 * Quick status change bottom sheet.
 *
 * Displays all available statuses from the entity type definition,
 * color-coded with the current status highlighted. Selecting a status
 * triggers [onStatusSelected] with the status value.
 *
 * Non-deprecated statuses are shown, with closed statuses visually
 * separated at the bottom with a divider.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QuickStatusSheet(
    entityType: EntityTypeDefinition,
    /** The record's status value; null while its summary is unread or cannot be opened. */
    currentStatus: String?,
    onStatusSelected: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState()

    val activeStatuses = entityType.statuses.filter { it.isDeprecated != true }
    val openStatuses = activeStatuses.filter { it.value !in entityType.closedStatuses }
    val closedStatuses = activeStatuses.filter { it.value in entityType.closedStatuses }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 32.dp),
        ) {
            // Header
            Text(
                text = "Change Status",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .padding(horizontal = 24.dp, vertical = 16.dp)
                    .testTag("status-sheet-title"),
            )

            // Open statuses
            openStatuses.forEach { status ->
                StatusOptionRow(
                    status = status,
                    isSelected = status.value == currentStatus,
                    onClick = { onStatusSelected(status.value) },
                )
            }

            // Closed statuses with divider
            if (closedStatuses.isNotEmpty()) {
                HorizontalDivider(
                    modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp),
                )
                Text(
                    text = "Closed",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                    modifier = Modifier.padding(horizontal = 24.dp, vertical = 4.dp),
                )
                closedStatuses.forEach { status ->
                    StatusOptionRow(
                        status = status,
                        isSelected = status.value == currentStatus,
                        onClick = { onStatusSelected(status.value) },
                    )
                }
            }
        }
    }
}

@Composable
private fun StatusOptionRow(
    status: EntityTypeDefinitionStatus,
    isSelected: Boolean,
    onClick: () -> Unit,
) {
    val statusColor = status.color?.let { parseHexColor(it) }

    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 24.dp, vertical = 12.dp)
            .testTag("status-option-${status.value}"),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (statusColor != null) {
                Icon(
                    imageVector = Icons.Filled.Circle,
                    contentDescription = null,
                    tint = statusColor,
                    modifier = Modifier.size(12.dp),
                )
                Spacer(Modifier.width(12.dp))
            }
            Text(
                text = status.label,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal,
                color = if (isSelected) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.onSurface
                },
            )
        }

        if (isSelected) {
            Icon(
                imageVector = Icons.Filled.Check,
                contentDescription = stringResource(R.string.a11y_current_status),
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}
