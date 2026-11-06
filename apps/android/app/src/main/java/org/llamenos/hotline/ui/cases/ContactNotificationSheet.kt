package org.llamenos.hotline.ui.cases

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.llamenos.hotline.R
import org.llamenos.hotline.api.ApiService

data class ContactForNotification(
    val id: String,
    val displayName: String,
    val recipientHash: String,
    val availableChannels: List<String>,
)

/**
 * Bottom sheet for dispatching status notifications to linked contacts.
 *
 * Renders the notification message client-side using the status label, hub name,
 * and case number. Admin selects which contacts to notify and their preferred
 * channel. Messages are sent via POST /api/records/{recordId}/notify-contacts.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContactNotificationSheet(
    recordId: String,
    contacts: List<ContactForNotification>,
    statusLabel: String,
    caseNumber: String?,
    hubName: String,
    apiService: ApiService,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()

    val selected = remember { mutableStateMapOf<String, Boolean>() }
    val channels = remember { mutableStateMapOf<String, String>() }
    var isSending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val renderedMessage = stringResource(
        R.string.notifications_status_change_template,
        caseNumber ?: "N/A",
        hubName,
        statusLabel,
    )

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
                text = stringResource(R.string.notifications_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .padding(horizontal = 24.dp, vertical = 16.dp)
                    .testTag("notification-sheet-title"),
            )

            HorizontalDivider()

            // Message preview
            Text(
                text = renderedMessage,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .padding(horizontal = 24.dp, vertical = 12.dp)
                    .testTag("notification-message-preview"),
            )

            HorizontalDivider()

            if (contacts.isEmpty()) {
                Text(
                    text = stringResource(R.string.notifications_no_contacts),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier
                        .padding(24.dp)
                        .testTag("notification-no-contacts"),
                )
            } else {
                // Contact list
                LazyColumn(
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("notification-contacts"),
                ) {
                    items(
                        items = contacts,
                        key = { it.id },
                    ) { contact ->
                        ContactRow(
                            contact = contact,
                            isChecked = selected[contact.id] == true,
                            selectedChannel = channels[contact.id]
                                ?: contact.availableChannels.firstOrNull() ?: "sms",
                            onCheckedChange = { checked -> selected[contact.id] = checked },
                            onChannelChange = { ch -> channels[contact.id] = ch },
                        )
                        HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                    }
                }
            }

            // Error message
            if (error != null) {
                Text(
                    text = error ?: "",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier
                        .padding(horizontal = 24.dp, vertical = 4.dp)
                        .testTag("notification-error"),
                )
            }

            Spacer(Modifier.height(8.dp))

            // Action buttons
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(
                    onClick = onDismiss,
                    modifier = Modifier.testTag("notification-skip"),
                ) {
                    Text(stringResource(R.string.notifications_skip))
                }

                Spacer(Modifier.width(8.dp))

                val anySelected = selected.values.any { it }
                val sendErrorText = stringResource(R.string.notifications_send_error)
                Button(
                    onClick = {
                        scope.launch {
                            isSending = true
                            error = null
                            val notifications = contacts
                                .filter { selected[it.id] == true }
                                .map { contact ->
                                    mapOf(
                                        "recipientHash" to contact.recipientHash,
                                        "channel" to (channels[contact.id]
                                            ?: contact.availableChannels.firstOrNull() ?: "sms"),
                                        "message" to renderedMessage,
                                    )
                                }
                            try {
                                apiService.request<Map<String, Any>>(
                                    "POST",
                                    apiService.activeHubPath("/api/records/$recordId/notify-contacts"),
                                    body = mapOf("notifications" to notifications),
                                )
                                isSending = false
                                onDismiss()
                            } catch (e: Exception) {
                                error = e.message ?: sendErrorText
                                isSending = false
                            }
                        }
                    },
                    enabled = anySelected && !isSending,
                    modifier = Modifier.testTag("notification-send"),
                ) {
                    if (isSending) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            strokeWidth = 2.dp,
                            color = MaterialTheme.colorScheme.onPrimary,
                        )
                    } else {
                        Text(stringResource(R.string.notifications_send))
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ContactRow(
    contact: ContactForNotification,
    isChecked: Boolean,
    selectedChannel: String,
    onCheckedChange: (Boolean) -> Unit,
    onChannelChange: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var expanded by remember { mutableStateOf(false) }

    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .testTag("contact-row-${contact.id}"),
    ) {
        Checkbox(
            checked = isChecked,
            onCheckedChange = onCheckedChange,
            modifier = Modifier.testTag("contact-check-${contact.id}"),
        )

        Spacer(Modifier.width(8.dp))

        Text(
            text = contact.displayName,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f),
        )

        // Channel picker (only when checked and multiple channels available)
        if (isChecked && contact.availableChannels.size > 1) {
            Spacer(Modifier.width(8.dp))
            ExposedDropdownMenuBox(
                expanded = expanded,
                onExpandedChange = { expanded = it },
                modifier = Modifier.testTag("channel-picker-${contact.id}"),
            ) {
                OutlinedTextField(
                    value = selectedChannel,
                    onValueChange = {},
                    readOnly = true,
                    trailingIcon = {
                        ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded)
                    },
                    modifier = Modifier
                        .menuAnchor(MenuAnchorType.PrimaryNotEditable)
                        .width(120.dp),
                    textStyle = MaterialTheme.typography.bodySmall,
                )
                ExposedDropdownMenu(
                    expanded = expanded,
                    onDismissRequest = { expanded = false },
                ) {
                    contact.availableChannels.forEach { ch ->
                        DropdownMenuItem(
                            text = { Text(ch, style = MaterialTheme.typography.bodySmall) },
                            onClick = {
                                onChannelChange(ch)
                                expanded = false
                            },
                        )
                    }
                }
            }
        }
    }
}
