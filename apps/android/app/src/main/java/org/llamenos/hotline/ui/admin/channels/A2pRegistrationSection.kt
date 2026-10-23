package org.llamenos.hotline.ui.admin.channels

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import org.llamenos.hotline.R
import androidx.compose.ui.unit.dp

@Composable
fun A2pRegistrationSection(
    viewModel: ChannelConfigViewModel,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.state.collectAsState()
    LaunchedEffect(viewModel) { viewModel.loadA2pStatus() }
    val registration = state.a2pRegistration
    val brandStatus = registration?.brandStatus ?: "not_submitted"
    val campaignStatus = registration?.campaignStatus ?: "not_submitted"
    val isApproved = brandStatus == "approved" && campaignStatus == "approved"

    Card(modifier = modifier.fillMaxWidth()) {
        Column(modifier = Modifier.fillMaxWidth().then(Modifier.Companion.run { Modifier })) {
            Text(
                stringResource(R.string.channels_a2p_title),
                style = MaterialTheme.typography.titleSmall,
            )
            Text(
                stringResource(R.string.channels_a2p_description),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(8.dp))

            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Brand: $brandStatus", style = MaterialTheme.typography.bodySmall)
                Spacer(Modifier.width(16.dp))
                Text("Campaign: $campaignStatus", style = MaterialTheme.typography.bodySmall)
            }

            registration?.error?.let { error ->
                Spacer(Modifier.height(8.dp))
                Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }

            Spacer(Modifier.height(12.dp))

            if (isApproved) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.Check, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.channels_a2p_approved_message), style = MaterialTheme.typography.bodySmall)
                }
            } else if (brandStatus == "not_submitted" || brandStatus == "failed") {
                Button(
                    onClick = { },
                    modifier = Modifier.testTag("a2p-start-brand"),
                ) {
                    Text(
                        if (brandStatus == "failed") stringResource(R.string.channels_a2p_resubmit_brand)
                        else stringResource(R.string.channels_a2p_submit_brand),
                    )
                }
                Spacer(Modifier.height(8.dp))
                TextButton(
                    onClick = { viewModel.skipA2p() },
                ) { Text(stringResource(R.string.channels_a2p_skip)) }
            } else if (brandStatus == "approved" && (campaignStatus == "not_submitted" || campaignStatus == "failed")) {
                Button(
                    onClick = { },
                    modifier = Modifier.testTag("a2p-start-campaign"),
                ) {
                    Text(
                        if (campaignStatus == "failed") stringResource(R.string.channels_a2p_resubmit_campaign)
                        else stringResource(R.string.channels_a2p_submit_campaign),
                    )
                }
            }
        }
    }
}
