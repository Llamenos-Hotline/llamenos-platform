package org.llamenos.hotline.ui.incidents

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R
import org.llamenos.hotline.util.DateFormatUtils

/**
 * The persistent incident banner (operator rule V). Rendered by the authenticated shell
 * above every tab, with no dismiss control: it goes away only when the server stops
 * listing the incident. Tapping it opens the incident view; it never switches hub.
 */
@Composable
fun IncidentBanner(rows: List<IncidentRow>, onOpen: () -> Unit) {
    if (rows.isEmpty()) return
    val title = stringResource(R.string.incident_title)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.errorContainer)
            .clickable(onClick = onOpen)
            .semantics { contentDescription = title }
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .testTag("incident-banner"),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        rows.forEach { row ->
            IncidentRowContent(row, MaterialTheme.colorScheme.onErrorContainer)
        }
    }
}

/** One incident: category, state, count since opening, and its hub when not the active one. */
@Composable
fun IncidentRowContent(row: IncidentRow, color: Color) {
    val incident = row.incident
    Row(
        modifier = Modifier.testTag("incident-row-${incident.id}"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Icons.Filled.Warning, contentDescription = null, tint = color, modifier = Modifier.size(16.dp))
        Column {
            Text(
                text = "${stringResource(categoryLabel(incident.category))} · ${stringResource(R.string.incident_opened)}",
                color = color,
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = stringResource(
                    R.string.incident_ongoing,
                    incident.totalCount.toString(),
                    DateFormatUtils.formatTimestamp(incident.openedAt),
                ),
                color = color,
                style = MaterialTheme.typography.bodySmall,
            )
            if (row.inOtherHub) {
                Text(
                    text = row.otherHubName?.let { stringResource(R.string.incident_in_hub, it) }
                        ?: stringResource(R.string.incident_other_hub),
                    color = color,
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.testTag("incident-hub-${incident.id}"),
                )
            }
        }
    }
}

/** The category is extensible: one this build does not know is shown under the generic title. */
fun categoryLabel(category: String): Int = when (category) {
    "spam" -> R.string.incident_category_spam
    "provider-media" -> R.string.incident_category_provider_media
    "erasure-deadline" -> R.string.incident_category_erasure_deadline
    "ban-expiry" -> R.string.incident_category_ban_expiry
    "channel-disabled" -> R.string.incident_category_channel_disabled
    "routing" -> R.string.incident_category_routing
    "provider-auth" -> R.string.incident_category_provider_auth
    else -> R.string.incident_title
}
