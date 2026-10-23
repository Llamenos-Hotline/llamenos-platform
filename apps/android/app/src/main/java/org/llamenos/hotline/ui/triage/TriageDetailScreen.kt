package org.llamenos.hotline.ui.triage

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R
import org.llamenos.hotline.model.Report
import org.llamenos.hotline.util.DateFormatUtils

/**
 * Triage report detail screen with "Convert to Case" functionality.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TriageDetailScreen(
    viewModel: TriageViewModel,
    reportId: String,
    onNavigateBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()
    val report = uiState.reports.find { it.id == reportId }
    var showConvertDialog by remember { mutableStateOf(false) }
    // The conversion route needs the case type to create (`entityTypeId`); a hub with
    // exactly one needs no choice.
    var chosenTypeId by remember { mutableStateOf<String?>(null) }
    val entityTypeId = chosenTypeId ?: uiState.entityTypes.singleOrNull()?.id

    // Convert confirmation dialog
    if (showConvertDialog && report != null) {
        AlertDialog(
            onDismissRequest = { showConvertDialog = false },
            title = { Text(stringResource(R.string.triage_convert_confirm_title)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.triage_convert_confirm_message))
                    if (uiState.entityTypes.isEmpty()) {
                        Text(
                            text = stringResource(R.string.cases_no_entity_types_hint),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                            modifier = Modifier.testTag("triage-convert-no-types"),
                        )
                    } else {
                        Text(
                            text = stringResource(R.string.cases_select_type),
                            style = MaterialTheme.typography.labelMedium,
                        )
                        uiState.entityTypes.forEach { type ->
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .selectable(
                                        selected = entityTypeId == type.id,
                                        onClick = { chosenTypeId = type.id },
                                        role = Role.RadioButton,
                                    )
                                    .testTag("triage-convert-type-${type.id}"),
                            ) {
                                RadioButton(selected = entityTypeId == type.id, onClick = null)
                                Text(
                                    text = type.label.ifBlank { type.name },
                                    modifier = Modifier.padding(start = 8.dp),
                                )
                            }
                        }
                    }
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        val typeId = entityTypeId ?: return@Button
                        showConvertDialog = false
                        viewModel.convertToEntity(report, typeId)
                        onNavigateBack()
                    },
                    enabled = !uiState.isConverting && entityTypeId != null,
                ) {
                    if (uiState.isConverting) {
                        CircularProgressIndicator(
                            modifier = Modifier.padding(end = 8.dp),
                            strokeWidth = 2.dp,
                        )
                    }
                    Text(stringResource(R.string.triage_convert_confirm_action))
                }
            },
            dismissButton = {
                TextButton(onClick = { showConvertDialog = false }) {
                    Text(stringResource(R.string.cancel))
                }
            },
            modifier = Modifier.testTag("triage-convert-dialog"),
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = stringResource(R.string.triage_detail_title),
                        modifier = Modifier.testTag("triage-detail-title"),
                    )
                },
                navigationIcon = {
                    IconButton(
                        onClick = onNavigateBack,
                        modifier = Modifier.testTag("triage-detail-back"),
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.contacts_back),
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
        if (report == null && uiState.isLoading) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(paddingValues),
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator(
                    modifier = Modifier.testTag("triage-detail-loading"),
                )
            }
            return@Scaffold
        }

        if (report == null) {
            org.llamenos.hotline.ui.components.EmptyState(
                icon = Icons.Filled.FolderOpen,
                title = stringResource(R.string.triage_report_not_found),
                subtitle = "",
                testTag = "triage-not-found",
                modifier = Modifier
                    .fillMaxSize()
                    .padding(paddingValues),
            )
            return@Scaffold
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // Title
            Text(
                text = report.metadata?.reportTitle ?: stringResource(R.string.triage_untitled),
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.testTag("triage-detail-report-title"),
            )

            // Status + type row
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = report.status.replaceFirstChar { it.uppercase() },
                    style = MaterialTheme.typography.labelMedium,
                    color = when (report.status) {
                        "waiting" -> MaterialTheme.colorScheme.tertiary
                        "active" -> MaterialTheme.colorScheme.primary
                        "closed" -> MaterialTheme.colorScheme.outline
                        else -> MaterialTheme.colorScheme.onSurfaceVariant
                    },
                    modifier = Modifier.testTag("triage-detail-status"),
                )

                val typeLabel = viewModel.reportTypeLabel(report.metadata?.reportTypeId)
                if (typeLabel != null) {
                    Text(
                        text = typeLabel,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.testTag("triage-detail-type"),
                    )
                }
            }

            // Metadata card
            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("triage-detail-metadata"),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant,
                ),
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    MetadataRow(
                        label = stringResource(R.string.triage_detail_created),
                        value = DateFormatUtils.formatTimestamp(report.createdAt),
                    )

                    if (report.assignedTo != null) {
                        MetadataRow(
                            label = stringResource(R.string.triage_detail_assigned),
                            value = report.assignedTo.take(16) + "\u2026",
                        )
                    }

                    MetadataRow(
                        label = stringResource(R.string.triage_detail_messages),
                        value = report.messageCount.toString(),
                    )

                    if (report.updatedAt != null) {
                        MetadataRow(
                            label = stringResource(R.string.triage_detail_updated),
                            value = DateFormatUtils.formatTimestamp(report.updatedAt),
                        )
                    }
                }
            }

            Spacer(Modifier.height(8.dp))

            // Convert to case button
            if (report.status != "closed") {
                Button(
                    onClick = { showConvertDialog = true },
                    enabled = !uiState.isConverting,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("triage-convert-button"),
                ) {
                    if (uiState.isConverting) {
                        CircularProgressIndicator(
                            modifier = Modifier.padding(end = 8.dp),
                            strokeWidth = 2.dp,
                        )
                    }
                    Icon(
                        imageVector = Icons.Filled.FolderOpen,
                        contentDescription = null,
                        modifier = Modifier.padding(end = 8.dp),
                    )
                    Text(stringResource(R.string.triage_convert_to_case))
                }
            }

            // Error
            if (uiState.error != null) {
                org.llamenos.hotline.ui.components.ErrorCard(
                    error = uiState.error ?: "",
                    onDismiss = { viewModel.dismissError() },
                    onRetry = { viewModel.loadTriageQueue() },
                    testTag = "triage-detail-error",
                )
            }
        }
    }
}

@Composable
private fun MetadataRow(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}
