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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Shield
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.serialization.Serializable
import org.llamenos.hotline.R
import org.llamenos.hotline.api.ApiService
import org.llamenos.protocol.Record

// ---------------------------------------------------------------------------
// Evidence Custody Chain Screen
// ---------------------------------------------------------------------------

@Serializable
data class CustodyChainEntry(
    val id: String,
    val action: String,
    val actorPubkey: String,
    val timestamp: String,
)

@Serializable
data class CustodyChainResponse(
    val custodyChain: List<CustodyChainEntry>,
    val total: Int,
)

/**
 * Screen that displays the chain of custody for a single evidence item.
 *
 * Loaded by evidenceId from GET /evidence/:id/custody.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EvidenceCustodyChainScreen(
    evidenceId: String,
    apiService: ApiService,
    onNavigateBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var entries by remember { mutableStateOf<List<CustodyChainEntry>>(emptyList()) }
    var isLoading by remember { mutableStateOf(true) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(evidenceId) {
        isLoading = true
        try {
            val response = apiService.request<CustodyChainResponse>(
                "GET",
                apiService.activeHubPath("/api/evidence/$evidenceId/custody"),
            )
            entries = response.custodyChain
        } catch (e: Exception) {
            errorMessage = e.message
        } finally {
            isLoading = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Chain of Custody") },
                navigationIcon = {
                    androidx.compose.material3.IconButton(onClick = onNavigateBack) {
                        Icon(Icons.Filled.Shield, contentDescription = stringResource(R.string.a11y_back))
                    }
                },
            )
        },
        modifier = modifier,
    ) { paddingValues ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues),
            contentAlignment = Alignment.Center,
        ) {
            when {
                isLoading -> CircularProgressIndicator(
                    modifier = Modifier
                        .size(48.dp)
                        .testTag("custody-loading"),
                )
                errorMessage != null -> Text(
                    text = errorMessage ?: "Error loading custody chain",
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier
                        .padding(32.dp)
                        .testTag("custody-error"),
                )
                entries.isEmpty() -> Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    modifier = Modifier
                        .padding(32.dp)
                        .testTag("custody-empty"),
                ) {
                    Icon(
                        imageVector = Icons.Filled.Shield,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f),
                        modifier = Modifier.size(64.dp),
                    )
                    Spacer(Modifier.height(16.dp))
                    Text(
                        text = "No custody entries recorded",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                else -> LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(horizontal = 16.dp, vertical = 8.dp)
                        .testTag("custody-chain"),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(entries.withIndex().toList(), key = { it.value.id }) { (index, entry) ->
                        CustodyEntryCard(
                            index = index + 1,
                            entry = entry,
                            modifier = Modifier.testTag("custody-entry-${entry.id}"),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun CustodyEntryCard(
    index: Int,
    entry: CustodyChainEntry,
    modifier: Modifier = Modifier,
) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(12.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Text(
                text = "#$index",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.width(24.dp),
            )
            Spacer(Modifier.width(8.dp))
            Column(modifier = Modifier.weight(1f)) {
                Row(
                    horizontalArrangement = Arrangement.SpaceBetween,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        text = entry.action.replaceFirstChar { it.uppercase() },
                        style = MaterialTheme.typography.titleSmall,
                    )
                    Text(
                        text = entry.timestamp.take(10),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.height(4.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        imageVector = Icons.Filled.Lock,
                        contentDescription = null,
                        modifier = Modifier.size(12.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.width(4.dp))
                    Text(
                        text = entry.actorPubkey.take(16) + "…",
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Entity Calendar Content
// ---------------------------------------------------------------------------

/**
 * Calendar-style view that groups records by month and displays them in sections.
 */
@Composable
fun EntityCalendarContent(
    records: List<Record>,
    onRecordClick: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (records.isEmpty()) {
        Box(modifier = modifier, contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(
                    imageVector = Icons.Filled.DateRange,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f),
                    modifier = Modifier.size(48.dp),
                )
                Spacer(Modifier.height(12.dp))
                Text(
                    text = "No records",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        return
    }

    // Group by YYYY-MM
    val grouped = records
        .groupBy { it.createdAt.take(7) }
        .entries
        .sortedByDescending { it.key }

    LazyColumn(
        verticalArrangement = Arrangement.spacedBy(4.dp),
        modifier = modifier.padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        grouped.forEach { (month, recs) ->
            item(key = "header-$month") {
                Text(
                    text = month,
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 8.dp),
                )
                HorizontalDivider()
            }
            items(recs, key = { it.id }) { record ->
                CalendarRecordRow(
                    record = record,
                    onClick = { onRecordClick(record.id) },
                    modifier = Modifier.testTag("calendar-record-${record.id}"),
                )
            }
        }
    }
}

@Composable
private fun CalendarRecordRow(
    record: Record,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        onClick = onClick,
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = record.createdAt.take(10),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = record.id.take(8) + "…",
                    style = MaterialTheme.typography.bodyMedium,
                    fontFamily = FontFamily.Monospace,
                )
            }
            Text(
                text = record.statusHash?.take(6) ?: "",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Entity Timeline Content
// ---------------------------------------------------------------------------

/**
 * Timeline view showing records in newest-first order with a vertical line.
 */
@Composable
fun EntityTimelineContent(
    records: List<Record>,
    onRecordClick: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val sorted = remember(records) { records.sortedByDescending { it.createdAt } }

    if (sorted.isEmpty()) {
        Box(modifier = modifier, contentAlignment = Alignment.Center) {
            Text(
                text = "No records",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        return
    }

    LazyColumn(
        verticalArrangement = Arrangement.spacedBy(4.dp),
        modifier = modifier.padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        items(sorted, key = { it.id }) { record ->
            TimelineRecordRow(
                record = record,
                onClick = { onRecordClick(record.id) },
                modifier = Modifier.testTag("timeline-record-${record.id}"),
            )
        }
    }
}

@Composable
private fun TimelineRecordRow(
    record: Record,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        onClick = onClick,
        modifier = modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = record.createdAt.take(16).replace("T", " "),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    text = record.id.take(16) + "…",
                    style = MaterialTheme.typography.bodyMedium,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (record.statusHash != null) {
                Text(
                    text = record.statusHash.take(6),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
