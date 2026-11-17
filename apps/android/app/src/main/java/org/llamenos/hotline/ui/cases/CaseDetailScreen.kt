package org.llamenos.hotline.ui.cases

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Comment
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.LinkOff
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.outlined.PersonOff
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material.icons.filled.Upload
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R
import org.llamenos.hotline.model.EntityTypeDefinition
import org.llamenos.hotline.model.EntityFieldDefinition
import org.llamenos.protocol.Evidence
import org.llamenos.hotline.model.EvidenceClassification
import org.llamenos.protocol.Interaction
import org.llamenos.hotline.model.InteractionType
import org.llamenos.protocol.Record
import org.llamenos.protocol.RecordContact
import org.llamenos.hotline.util.DateFormatUtils

/**
 * Case detail screen showing record information across four tabs:
 * Details, Timeline, Contacts, and Evidence.
 *
 * The header shows the case number, entity type, and a status pill
 * that opens the quick status change sheet.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CaseDetailScreen(
    viewModel: CaseManagementViewModel,
    recordId: String,
    onNavigateBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()

    val isNewCase = recordId == "new"

    // Load the record on entry
    LaunchedEffect(recordId) {
        if (!isNewCase) {
            viewModel.selectRecord(recordId)
        }
    }

    var showStatusSheet by remember { mutableStateOf(false) }
    var showCommentSheet by remember { mutableStateOf(false) }

    val record = uiState.selectedRecord
    val entityType = uiState.selectedEntityType

    // Trigger decryption when the record loads
    LaunchedEffect(record?.id) {
        val r = record ?: return@LaunchedEffect
        viewModel.decryptSummary(r)
        viewModel.decryptFields(r)
    }

    // Trigger interaction decryption when interactions load
    LaunchedEffect(uiState.interactions) {
        for (interaction in uiState.interactions) {
            if (interaction.encryptedContent != null) {
                viewModel.decryptInteraction(interaction)
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = if (isNewCase && record == null) "New Case"
                            else record?.caseNumber ?: record?.id?.take(8) ?: "Case",
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.testTag("case-detail-header"),
                    )
                },
                navigationIcon = {
                    IconButton(
                        onClick = {
                            viewModel.clearSelection()
                            onNavigateBack()
                        },
                        modifier = Modifier.testTag("case-detail-back"),
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.a11y_back),
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
            uiState.isLoadingDetail && !isNewCase -> {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(paddingValues),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier
                            .size(48.dp)
                            .testTag("case-detail-loading"),
                    )
                }
            }

            uiState.detailError != null && !isNewCase -> {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(paddingValues),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = uiState.detailError ?: "Error",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.testTag("case-detail-error"),
                    )
                }
            }

            record != null || isNewCase -> {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(paddingValues),
                ) {
                    // Status pill + entity type header
                    CaseDetailHeader(
                        record = record,
                        entityType = entityType,
                        triage = uiState.triage,
                        isNewCase = isNewCase,
                        decryptedSummary = uiState.decryptedSummary,
                        onStatusClick = { showStatusSheet = true },
                    )

                    // Tab row
                    val tabs = CaseDetailTab.entries
                    val selectedTabIndex = tabs.indexOf(uiState.activeTab)

                    TabRow(
                        selectedTabIndex = selectedTabIndex,
                    ) {
                        tabs.forEach { tab ->
                            Tab(
                                selected = uiState.activeTab == tab,
                                onClick = { viewModel.setActiveTab(tab) },
                                text = {
                                    Text(
                                        text = when (tab) {
                                            CaseDetailTab.DETAILS -> "Details"
                                            CaseDetailTab.TIMELINE -> "Timeline"
                                            CaseDetailTab.CONTACTS -> "Contacts"
                                            CaseDetailTab.EVIDENCE -> "Evidence"
                                        },
                                    )
                                },
                                modifier = Modifier.testTag(
                                    when (tab) {
                                        CaseDetailTab.DETAILS -> "case-tab-details"
                                        CaseDetailTab.TIMELINE -> "case-tab-timeline"
                                        CaseDetailTab.CONTACTS -> "case-tab-contacts"
                                        CaseDetailTab.EVIDENCE -> "case-tab-evidence"
                                    },
                                ),
                            )
                        }
                    }

                    // Tab content
                    if (record != null) {
                        when (uiState.activeTab) {
                            CaseDetailTab.DETAILS -> DetailsTab(
                                record = record,
                                entityType = entityType,
                                decryptedSummary = uiState.decryptedSummary,
                                decryptedFields = uiState.decryptedFields,
                                isDecryptingFields = uiState.isDecryptingFields,
                                onAssignToMe = { viewModel.assignToMe(record.id) },
                                onUnassignFromMe = { viewModel.unassignFromMe(record.id) },
                                isAssigning = uiState.isAssigning,
                                isCurrentUserAssigned = record.assignedTo.contains(
                                    viewModel.currentUserPubkey,
                                ),
                            )
                            CaseDetailTab.TIMELINE -> TimelineTab(
                                interactions = uiState.sortedInteractions,
                                isLoading = uiState.isLoadingInteractions,
                                error = uiState.interactionsError,
                                entityType = entityType,
                                sortOrder = uiState.timelineSortOrder,
                                onToggleSort = { viewModel.toggleTimelineSort() },
                                onAddComment = { showCommentSheet = true },
                                decryptedInteractions = uiState.decryptedInteractions,
                            )
                            CaseDetailTab.CONTACTS -> ContactsTab(
                                contacts = uiState.contacts,
                                isLoading = uiState.isLoadingContacts,
                                error = uiState.contactsError,
                                entityType = entityType,
                            )
                            CaseDetailTab.EVIDENCE -> EvidenceTab(
                                evidence = uiState.evidence,
                                isLoading = uiState.isLoadingEvidence,
                                error = uiState.evidenceError,
                            )
                        }
                    } else {
                        // New case — show empty form state
                        NewCaseContent(
                            activeTab = uiState.activeTab,
                        )
                    }

                    // Error snackbar
                    if (uiState.actionError != null) {
                        Text(
                            text = uiState.actionError ?: "",
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier
                                .padding(16.dp)
                                .testTag("case-detail-action-error"),
                        )
                    }
                }
            }
        }
    }

    // Quick status change sheet
    if (showStatusSheet && record != null && entityType != null) {
        QuickStatusSheet(
            entityType = entityType,
            currentStatus = uiState.triage.statusValue(record.entityTypeID, record.statusHash),
            onStatusSelected = { status ->
                viewModel.updateStatus(record.id, status)
                showStatusSheet = false
            },
            onDismiss = { showStatusSheet = false },
        )
    }

    // Add comment sheet
    if (showCommentSheet && record != null) {
        AddCommentSheet(
            onSubmit = { comment ->
                viewModel.addComment(record.id, comment)
                showCommentSheet = false
            },
            onDismiss = { showCommentSheet = false },
            isSubmitting = uiState.isAddingComment,
        )
    }
}

// ---- Header ----

@Composable
private fun CaseDetailHeader(
    record: Record?,
    entityType: EntityTypeDefinition?,
    triage: TriageTokens,
    isNewCase: Boolean = false,
    decryptedSummary: DecryptedSummary? = null,
    onStatusClick: () -> Unit,
) {
    // statusHash is a hub-keyed blind index (#2779); an unknown token shows no label.
    val statusOption = record?.let { r ->
        val value = triage.statusValue(r.entityTypeID, r.statusHash)
        entityType?.statuses?.find { it.value == value }
    }
    val statusLabel = statusOption?.label ?: if (isNewCase) "New" else "---"
    val statusColor = statusOption?.color?.let { parseHexColor(it) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        // Top row: entity type label + status pill
        Row(
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth(),
        ) {
            // Entity type label
            if (entityType != null) {
                val typeColor = entityType.color?.let { parseHexColor(it) }
                Card(
                    colors = CardDefaults.cardColors(
                        containerColor = (typeColor ?: MaterialTheme.colorScheme.secondaryContainer)
                            .copy(alpha = 0.15f),
                    ),
                ) {
                    Text(
                        text = entityType.label,
                        style = MaterialTheme.typography.labelMedium,
                        color = typeColor ?: MaterialTheme.colorScheme.secondary,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                    )
                }
            } else if (isNewCase) {
                Text(
                    text = "New Case",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Spacer(Modifier.weight(1f))

            // Status pill button
            OutlinedButton(
                onClick = onStatusClick,
                enabled = record != null,
                modifier = Modifier.testTag("case-status-pill"),
            ) {
                if (statusColor != null) {
                    Icon(
                        imageVector = Icons.Filled.Circle,
                        contentDescription = null,
                        tint = statusColor,
                        modifier = Modifier.size(8.dp),
                    )
                    Spacer(Modifier.width(6.dp))
                }
                Text(
                    text = statusLabel,
                    style = MaterialTheme.typography.labelMedium,
                )
            }
        }

        // Decrypted title
        if (decryptedSummary?.title != null) {
            Spacer(Modifier.height(4.dp))
            Text(
                text = decryptedSummary.title,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Medium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.testTag("case-detail-title"),
            )
        }

        // Decrypted description
        if (decryptedSummary?.description != null) {
            Spacer(Modifier.height(2.dp))
            Text(
                text = decryptedSummary.description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.testTag("case-detail-description"),
            )
        }

        // Severity + assignment info
        if (record != null) {
            val severityOption = triage.severityValue(record.entityTypeID, record.severityHash)?.let { value ->
                entityType?.severities?.find { it.value == value }
            }
            if (severityOption != null || record.assignedTo.isNotEmpty()) {
                Spacer(Modifier.height(6.dp))
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (severityOption != null) {
                        val sevColor = severityOption.color?.let { parseHexColor(it) }
                        Card(
                            colors = CardDefaults.cardColors(
                                containerColor = (sevColor ?: MaterialTheme.colorScheme.errorContainer)
                                    .copy(alpha = 0.15f),
                            ),
                        ) {
                            Text(
                                text = severityOption.label,
                                style = MaterialTheme.typography.labelSmall,
                                color = sevColor ?: MaterialTheme.colorScheme.error,
                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                            )
                        }
                    }

                    if (record.assignedTo.isNotEmpty()) {
                        Text(
                            text = "${record.assignedTo.size} assigned",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                        )
                    }
                }
            }
        }
    }
}

// ---- New Case Content ----

/**
 * Placeholder content shown when creating a new case.
 * Renders the appropriate empty state for each tab.
 */
@Composable
private fun NewCaseContent(
    activeTab: CaseDetailTab,
) {
    when (activeTab) {
        CaseDetailTab.DETAILS -> {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Card(
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            text = "New Case",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        Text(
                            text = "Connect to a hub to create cases",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }

                // Assign button placeholder
                Button(
                    onClick = { },
                    enabled = false,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("case-assign-btn"),
                ) {
                    Text("Assign to me")
                }
            }
        }
        CaseDetailTab.TIMELINE -> TimelineTab(
            interactions = emptyList(),
            isLoading = false,
            error = null,
            entityType = null,
            onAddComment = {},
        )
        CaseDetailTab.CONTACTS -> ContactsTab(
            contacts = emptyList(),
            isLoading = false,
            error = null,
            entityType = null,
        )
        CaseDetailTab.EVIDENCE -> EvidenceTab(
            evidence = emptyList(),
            isLoading = false,
            error = null,
        )
    }
}

// ---- Details Tab ----

@Composable
private fun DetailsTab(
    record: Record,
    entityType: EntityTypeDefinition?,
    decryptedSummary: DecryptedSummary? = null,
    decryptedFields: Map<String, String> = emptyMap(),
    isDecryptingFields: Boolean = false,
    onAssignToMe: () -> Unit = {},
    onUnassignFromMe: () -> Unit = {},
    isAssigning: Boolean = false,
    isCurrentUserAssigned: Boolean = false,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // Assign / unassign buttons
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (isCurrentUserAssigned) {
                OutlinedButton(
                    onClick = onUnassignFromMe,
                    enabled = !isAssigning,
                    modifier = Modifier.testTag("case-unassign-btn"),
                ) {
                    if (isAssigning) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(14.dp),
                            strokeWidth = 2.dp,
                        )
                        Spacer(Modifier.width(6.dp))
                    }
                    Icon(
                        imageVector = Icons.Outlined.PersonOff,
                        contentDescription = null,
                        modifier = Modifier.size(14.dp),
                    )
                    Spacer(Modifier.width(4.dp))
                    Text("Unassign", style = MaterialTheme.typography.labelSmall)
                }
            }
            Button(
                onClick = onAssignToMe,
                enabled = !isAssigning && !isCurrentUserAssigned,
                modifier = Modifier.testTag("case-assign-btn-header"),
            ) {
                if (isAssigning) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(14.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                    Spacer(Modifier.width(6.dp))
                }
                Icon(
                    imageVector = Icons.Filled.PersonAdd,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                )
                Spacer(Modifier.width(4.dp))
                Text("Assign to me", style = MaterialTheme.typography.labelSmall)
            }
        }

        // Summary section
        Card(
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
            ),
            modifier = Modifier
                .fillMaxWidth()
                .testTag("case-details-summary"),
        ) {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = "Summary",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.primary,
                )
                // Case number
                if (record.caseNumber != null) {
                    DetailRow(label = "Case Number", value = record.caseNumber)
                }
                // Decrypted title
                if (decryptedSummary?.title != null) {
                    DetailRow(label = "Title", value = decryptedSummary.title)
                }
                // Decrypted description
                if (decryptedSummary?.description != null) {
                    DetailRow(label = "Description", value = decryptedSummary.description)
                }
                // Created at
                DetailRow(label = "Created", value = DateFormatUtils.formatDateVerbose(record.createdAt))
                // Updated at
                DetailRow(label = "Updated", value = DateFormatUtils.formatDateVerbose(record.updatedAt))
                // Assignment
                if (record.assignedTo.isNotEmpty()) {
                    DetailRow(
                        label = "Assigned to",
                        value = record.assignedTo.joinToString(", ") { it.take(8) + "..." },
                    )
                }
                // Closed at
                if (record.closedAt != null) {
                    DetailRow(label = "Closed", value = DateFormatUtils.formatDateVerbose(record.closedAt))
                }
            }
        }

        // Template fields section
        if (entityType != null && entityType.fields.isNotEmpty()) {
            TemplateFieldsSection(
                fields = entityType.fields,
                record = record,
                decryptedFields = decryptedFields,
                isDecrypting = isDecryptingFields,
            )
        }

        // Counts section
        Card(
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
            ),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = "Related",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.primary,
                )
                DetailRow(label = "Interactions", value = record.interactionCount.toInt().toString())
                DetailRow(label = "Contacts", value = record.contactCount.toInt().toString())
                DetailRow(label = "Files", value = record.fileCount.toInt().toString())
                DetailRow(label = "Reports", value = record.reportCount.toInt().toString())
            }
        }
    }
}

@Composable
private fun DetailRow(label: String, value: String) {
    Row(
        horizontalArrangement = Arrangement.SpaceBetween,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(0.4f),
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.Medium,
            modifier = Modifier.weight(0.6f),
        )
    }
}

/**
 * Renders the entity type's custom fields section.
 *
 * When [decryptedFields] contains values, shows the decrypted content.
 * Otherwise, shows an "[Encrypted]" placeholder.
 */
@Composable
private fun TemplateFieldsSection(
    fields: List<EntityFieldDefinition>,
    record: Record,
    decryptedFields: Map<String, String> = emptyMap(),
    isDecrypting: Boolean = false,
) {
    val sortedFields = fields.sortedBy { it.order }
    var currentSection: String? = null

    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
        ),
        modifier = Modifier
            .fillMaxWidth()
            .testTag("case-details-fields"),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    text = "Fields",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.primary,
                )
                if (isDecrypting) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(14.dp),
                        strokeWidth = 2.dp,
                    )
                }
            }

            sortedFields.forEach { field ->
                // Section header if the section changed
                if (field.section != null && field.section != currentSection) {
                    currentSection = field.section
                    Spacer(Modifier.height(4.dp))
                    HorizontalDivider()
                    Spacer(Modifier.height(2.dp))
                    Text(
                        text = field.section,
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.secondary,
                        modifier = Modifier.testTag("case-field-section-${field.section}"),
                    )
                }

                val fieldValue = decryptedFields[field.name]
                val displayValue = when {
                    fieldValue != null && fieldValue.isNotEmpty() -> fieldValue
                    decryptedFields.isNotEmpty() -> "-" // Decrypted but no value for this field
                    record.encryptedFields != null -> "[Encrypted]"
                    else -> "-"
                }
                val valueColor = when {
                    fieldValue != null && fieldValue.isNotEmpty() ->
                        MaterialTheme.colorScheme.onSurface
                    else ->
                        MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)
                }

                Row(
                    horizontalArrangement = Arrangement.SpaceBetween,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        text = field.label,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier
                            .weight(0.4f)
                            .testTag("case-field-label-${field.name}"),
                    )
                    Text(
                        text = displayValue,
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.Medium,
                        color = valueColor,
                        modifier = Modifier
                            .weight(0.6f)
                            .testTag("case-field-value-${field.name}"),
                    )
                }
            }
        }
    }
}

// ---- Timeline Tab ----

@Composable
private fun TimelineTab(
    interactions: List<Interaction>,
    isLoading: Boolean,
    error: String?,
    entityType: EntityTypeDefinition?,
    sortOrder: TimelineSortOrder = TimelineSortOrder.NEWEST_FIRST,
    onToggleSort: () -> Unit = {},
    onAddComment: () -> Unit,
    decryptedInteractions: Map<String, String> = emptyMap(),
) {
    Column(
        modifier = Modifier.fillMaxSize(),
    ) {
        // Sort toggle row
        Row(
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 4.dp),
        ) {
            Text(
                text = "${interactions.size} interactions",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.testTag("case-timeline-count"),
            )
            OutlinedButton(
                onClick = onToggleSort,
                modifier = Modifier.testTag("case-timeline-sort"),
            ) {
                Icon(
                    imageVector = Icons.Filled.SwapHoriz,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                )
                Spacer(Modifier.width(4.dp))
                Text(
                    text = when (sortOrder) {
                        TimelineSortOrder.NEWEST_FIRST -> "Newest first"
                        TimelineSortOrder.OLDEST_FIRST -> "Oldest first"
                    },
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }

        when {
            isLoading && interactions.isEmpty() -> {
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth(),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier
                            .size(36.dp)
                            .testTag("case-timeline-loading"),
                    )
                }
            }

            error != null && interactions.isEmpty() -> {
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth(),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = error,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }

            interactions.isEmpty() -> {
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth(),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = "No interactions yet",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.testTag("case-timeline-empty"),
                    )
                }
            }

            else -> {
                LazyColumn(
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp)
                        .testTag("case-timeline"),
                ) {
                    items(
                        items = interactions,
                        key = { it.id },
                    ) { interaction ->
                        TimelineItem(
                            interaction = interaction,
                            entityType = entityType,
                            decryptedContent = decryptedInteractions[interaction.id],
                            modifier = Modifier.testTag("timeline-item-${interaction.id}"),
                        )
                    }
                }
            }
        }

        // Comment input row at bottom
        HorizontalDivider()
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            OutlinedButton(
                onClick = onAddComment,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("case-comment-input"),
            ) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.Comment,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text("Add comment...")
            }
        }
    }
}

/**
 * A single timeline interaction item.
 * Shows type icon, author pubkey prefix, timestamp, and content preview.
 */
@Composable
private fun TimelineItem(
    interaction: Interaction,
    entityType: EntityTypeDefinition?,
    decryptedContent: String? = null,
    modifier: Modifier = Modifier,
) {
    val icon: ImageVector = when (interaction.interactionType) {
        InteractionType.Comment -> Icons.AutoMirrored.Filled.Comment
        InteractionType.StatusChange -> Icons.Filled.SwapHoriz
        InteractionType.Note -> Icons.Filled.Description
        InteractionType.Call -> Icons.Filled.Phone
        InteractionType.FileUpload -> Icons.Filled.Upload
        InteractionType.Referral -> Icons.Filled.LinkOff
        InteractionType.Assessment -> Icons.Filled.Description
        InteractionType.Message -> Icons.AutoMirrored.Filled.Comment
    }

    val typeLabel = when (interaction.interactionType) {
        InteractionType.Comment -> "Comment"
        InteractionType.StatusChange -> "Status changed"
        InteractionType.Note -> "Note linked"
        InteractionType.Call -> "Call linked"
        InteractionType.Message -> "Message"
        InteractionType.FileUpload -> "File uploaded"
        InteractionType.Referral -> "Referral"
        InteractionType.Assessment -> "Assessment"
    }

    // For status changes, show the status transition
    val statusChangeText = if (interaction.interactionType == InteractionType.StatusChange) {
        val prevStatus = interaction.previousStatusHash?.let { hash ->
            entityType?.statuses?.find { it.value == hash }?.label ?: hash.take(8)
        }
        val newStatus = interaction.newStatusHash?.let { hash ->
            entityType?.statuses?.find { it.value == hash }?.label ?: hash.take(8)
        }
        if (prevStatus != null && newStatus != null) {
            "$prevStatus -> $newStatus"
        } else {
            null
        }
    } else {
        null
    }

    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
        ),
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Icon(
                imageVector = icon,
                contentDescription = typeLabel,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .size(20.dp)
                    .padding(top = 2.dp),
            )
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Row(
                    horizontalArrangement = Arrangement.SpaceBetween,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        text = typeLabel,
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        text = DateFormatUtils.formatTimestamp(interaction.createdAt),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                    )
                }
                // Author
                Text(
                    text = interaction.authorPubkey.take(8) + "...",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                )
                // Status change details
                if (statusChangeText != null) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = statusChangeText,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
                // Content — decrypted or encrypted indicator
                if (decryptedContent != null) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = decryptedContent,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.testTag("timeline-content-${interaction.id}"),
                    )
                } else if (interaction.encryptedContent != null) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = "[Encrypted content]",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                    )
                }
                // Source link
                if (interaction.sourceID != null) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = "Linked: ${interaction.sourceID.take(8)}...",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                    )
                }
            }
        }
    }
}

// ---- Contacts Tab ----

@Composable
private fun ContactsTab(
    contacts: List<RecordContact>,
    isLoading: Boolean,
    error: String?,
    entityType: EntityTypeDefinition?,
) {
    when {
        isLoading && contacts.isEmpty() -> {
            Box(
                modifier = Modifier.fillMaxSize(),
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator(
                    modifier = Modifier
                        .size(36.dp)
                        .testTag("case-contacts-loading"),
                )
            }
        }

        error != null && contacts.isEmpty() -> {
            Box(
                modifier = Modifier.fillMaxSize(),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = error,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }

        contacts.isEmpty() -> {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .testTag("case-contacts-tab"),
                contentAlignment = Alignment.Center,
            ) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Icon(
                        imageVector = Icons.Filled.People,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                        modifier = Modifier.size(48.dp),
                    )
                    Spacer(Modifier.height(12.dp))
                    Text(
                        text = "No contacts linked",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        else -> {
            LazyColumn(
                verticalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 16.dp, vertical = 8.dp)
                    .testTag("case-contacts-tab"),
            ) {
                items(
                    items = contacts,
                    key = { it.contactID },
                ) { contact ->
                    ContactItem(
                        contact = contact,
                        entityType = entityType,
                    )
                }
            }
        }
    }
}

@Composable
private fun ContactItem(
    contact: RecordContact,
    entityType: EntityTypeDefinition?,
) {
    val roleLabel = entityType?.contactRoles?.find { it.value == contact.role }?.label
        ?: contact.role.replaceFirstChar { it.uppercase() }

    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
        ),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
        ) {
            Icon(
                imageVector = Icons.Filled.Person,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(32.dp),
            )
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = contact.contactID.take(12) + "...",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                )
                Text(
                    text = DateFormatUtils.formatTimestamp(contact.addedAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                )
            }
            // Role badge
            Card(
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.secondaryContainer,
                ),
            ) {
                Text(
                    text = roleLabel,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSecondaryContainer,
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                )
            }
        }
    }
}

// ---- Evidence Tab ----

@Composable
private fun EvidenceTab(
    evidence: List<Evidence>,
    isLoading: Boolean,
    error: String?,
) {
    when {
        isLoading && evidence.isEmpty() -> {
            Box(
                modifier = Modifier.fillMaxSize(),
                contentAlignment = Alignment.Center,
            ) {
                CircularProgressIndicator(
                    modifier = Modifier
                        .size(36.dp)
                        .testTag("case-evidence-loading"),
                )
            }
        }

        error != null && evidence.isEmpty() -> {
            Box(
                modifier = Modifier.fillMaxSize(),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = error,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }

        evidence.isEmpty() -> {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .testTag("case-evidence-tab"),
                contentAlignment = Alignment.Center,
            ) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Icon(
                        imageVector = Icons.Filled.AttachFile,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                        modifier = Modifier.size(48.dp),
                    )
                    Spacer(Modifier.height(12.dp))
                    Text(
                        text = "No evidence files",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        else -> {
            LazyColumn(
                verticalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 16.dp, vertical = 8.dp)
                    .testTag("case-evidence-tab"),
            ) {
                items(
                    items = evidence,
                    key = { it.id },
                ) { item ->
                    EvidenceCard(item = item)
                }
            }
        }
    }
}

@Composable
private fun EvidenceCard(
    item: Evidence,
) {
    val classificationIcon: ImageVector = when (item.classification) {
        EvidenceClassification.Photo -> Icons.Filled.AttachFile
        EvidenceClassification.Video -> Icons.Filled.AttachFile
        EvidenceClassification.Document -> Icons.Filled.Description
        EvidenceClassification.Audio -> Icons.Filled.AttachFile
        EvidenceClassification.Other -> Icons.Filled.AttachFile
    }

    val classificationLabel = item.classification.value.replaceFirstChar { it.uppercase() }
    val sizeText = formatFileSize(item.sizeBytes.toLong())

    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
        ),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
        ) {
            Icon(
                imageVector = classificationIcon,
                contentDescription = classificationLabel,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(32.dp),
            )
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = item.filename,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        text = sizeText,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                    )
                    Text(
                        text = item.mimeType,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                    )
                }
                Text(
                    text = DateFormatUtils.formatTimestamp(item.uploadedAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                )
            }
            // Classification badge
            Card(
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.tertiaryContainer,
                ),
            ) {
                Text(
                    text = classificationLabel,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onTertiaryContainer,
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                )
            }
        }
    }
}

/**
 * Format a file size in bytes to a human-readable string.
 */
private fun formatFileSize(bytes: Long): String {
    return when {
        bytes >= 1_073_741_824 -> "%.1f GB".format(bytes / 1_073_741_824.0)
        bytes >= 1_048_576 -> "%.1f MB".format(bytes / 1_048_576.0)
        bytes >= 1024 -> "%.1f KB".format(bytes / 1024.0)
        else -> "$bytes B"
    }
}
