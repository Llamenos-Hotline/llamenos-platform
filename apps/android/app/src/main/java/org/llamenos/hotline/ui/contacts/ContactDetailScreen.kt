package org.llamenos.hotline.ui.contacts

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
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.filled.Warning
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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R
import org.llamenos.hotline.model.ContactDetail
import org.llamenos.hotline.model.ContactIdentifier
import org.llamenos.hotline.model.ContactLinkedCase
import org.llamenos.hotline.util.DateFormatUtils

/**
 * Contact profile detail screen showing linked cases, relationships,
 * identifiers, and interaction summary.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContactDetailScreen(
    viewModel: ContactDetailViewModel,
    onNavigateBack: () -> Unit,
    onNavigateToTimeline: (String) -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    val displayId = uiState.contact?.let { contact ->
                        if (contact.last4 != null) "***${contact.last4}"
                        else contact.contactHash.take(8) + "\u2026"
                    } ?: stringResource(R.string.contact_directory_detail_title)
                    Text(
                        text = displayId,
                        modifier = Modifier.testTag("contact-detail-title"),
                    )
                },
                navigationIcon = {
                    IconButton(
                        onClick = onNavigateBack,
                        modifier = Modifier.testTag("contact-detail-back"),
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
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues),
        ) {
            when {
                uiState.isLoading && uiState.contact == null -> {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .testTag("contact-detail-loading"),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator()
                    }
                }

                uiState.error != null && uiState.contact == null -> {
                    org.llamenos.hotline.ui.components.EmptyState(
                        icon = Icons.Filled.Warning,
                        title = stringResource(R.string.contact_directory_error),
                        subtitle = uiState.error ?: "",
                        testTag = "contact-detail-error",
                        modifier = Modifier.fillMaxSize(),
                    )
                }

                uiState.contact != null -> {
                    ContactProfileContent(
                        contact = uiState.contact!!,
                        onNavigateToTimeline = { onNavigateToTimeline(uiState.contactHash) },
                    )
                }
            }
        }
    }
}

@Composable
private fun ContactProfileContent(
    contact: ContactDetail,
    onNavigateToTimeline: () -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyColumn(
        modifier = modifier
            .fillMaxSize()
            .testTag("contact-detail-content"),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        // Contact type badge
        if (contact.contactType != null) {
            item {
                Text(
                    text = contact.contactType,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.testTag("contact-type-badge"),
                )
            }
        }

        // Timestamps
        item {
            Row(
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Column {
                    Text(
                        text = stringResource(R.string.contact_directory_first_seen),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                    )
                    Text(
                        text = DateFormatUtils.formatDate(contact.firstSeen),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                Column {
                    Text(
                        text = stringResource(R.string.contact_directory_last_seen),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                    )
                    Text(
                        text = DateFormatUtils.formatDate(contact.lastSeen),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }

        // Identifiers
        val identifiers = contact.identifiers.orEmpty()
        if (identifiers.isNotEmpty()) {
            item {
                Text(
                    text = stringResource(R.string.contact_directory_identifiers),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.testTag("contact-identifiers-header"),
                )
            }
            items(identifiers) { identifier ->
                IdentifierCard(identifier = identifier)
            }
        }

        // Interaction summary
        item {
            Text(
                text = stringResource(R.string.contact_directory_interactions),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.testTag("contact-interactions-header"),
            )
        }
        item {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                InteractionStatCard(
                    icon = Icons.Filled.Phone,
                    count = contact.callCount,
                    label = stringResource(R.string.contact_directory_calls),
                    modifier = Modifier.weight(1f),
                )
                InteractionStatCard(
                    icon = Icons.Filled.Chat,
                    count = contact.conversationCount,
                    label = stringResource(R.string.contact_directory_messages),
                    modifier = Modifier.weight(1f),
                )
                InteractionStatCard(
                    icon = Icons.Filled.Description,
                    count = contact.noteCount,
                    label = stringResource(R.string.contact_directory_notes),
                    modifier = Modifier.weight(1f),
                )
                InteractionStatCard(
                    icon = Icons.Filled.Warning,
                    count = contact.reportCount,
                    label = stringResource(R.string.contact_directory_reports),
                    modifier = Modifier.weight(1f),
                )
            }
        }

        // Linked cases
        val linkedCases = contact.linkedCases.orEmpty()
        if (linkedCases.isNotEmpty()) {
            item {
                Text(
                    text = stringResource(R.string.contact_directory_linked_cases),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.testTag("contact-linked-cases-header"),
                )
            }
            items(linkedCases) { linkedCase ->
                LinkedCaseCard(linkedCase = linkedCase)
            }
        }

        // Timeline link
        item {
            Card(
                onClick = onNavigateToTimeline,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("contact-timeline-link"),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.primaryContainer,
                ),
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = Icons.Filled.Schedule,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                    )
                    Spacer(Modifier.width(12.dp))
                    Text(
                        text = stringResource(R.string.contact_directory_view_timeline),
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.Medium,
                    )
                }
            }
        }
    }
}

@Composable
private fun IdentifierCard(
    identifier: ContactIdentifier,
    modifier: Modifier = Modifier,
) {
    val icon = when (identifier.type.lowercase()) {
        "phone" -> Icons.Filled.Phone
        "email" -> Icons.Filled.Email
        "name" -> Icons.Filled.Person
        else -> Icons.Filled.Tag
    }

    Card(
        modifier = modifier
            .fillMaxWidth()
            .testTag("contact-identifier-${identifier.type}"),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(20.dp),
            )
            Spacer(Modifier.width(12.dp))
            Column {
                Text(
                    text = identifier.type.replaceFirstChar { it.uppercase() },
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                )
                Text(
                    text = identifier.value ?: (identifier.hash.take(12) + "\u2026"),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

@Composable
private fun InteractionStatCard(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    count: Int,
    label: String,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier,
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier
                .fillMaxWidth()
                .padding(8.dp),
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = count.toString(),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )
            Text(
                text = label,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
            )
        }
    }
}

@Composable
private fun LinkedCaseCard(
    linkedCase: ContactLinkedCase,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .testTag("linked-case-${linkedCase.id}"),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.Filled.Folder,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(20.dp),
            )
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = linkedCase.caseNumber ?: (linkedCase.id.take(8) + "\u2026"),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (linkedCase.role != null) {
                        Text(
                            text = linkedCase.role,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                    Text(
                        text = linkedCase.statusHash,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                    )
                }
            }
            Text(
                text = DateFormatUtils.formatDate(linkedCase.createdAt),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
            )
        }
    }
}

