package org.llamenos.hotline.ui.providersetup

import android.net.Uri
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
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
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import org.llamenos.hotline.R

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WebhookConfirmationScreen(
    provider: String,
    phoneNumber: String,
    webhookBaseUrl: String,
    onNavigateBack: () -> Unit,
    modifier: Modifier = Modifier,
    viewModel: ProviderSetupViewModel = hiltViewModel(),
) {
    val uiState by viewModel.uiState.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = stringResource(R.string.webhook_confirmation_title),
                        modifier = Modifier.testTag("webhook-title"),
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.nav_dashboard),
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.secondaryContainer,
                    titleContentColor = MaterialTheme.colorScheme.onSecondaryContainer,
                ),
            )
        },
        modifier = modifier,
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = stringResource(R.string.webhook_description),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(modifier = Modifier.height(24.dp))

            // The mounted webhook routes (#2068): `/api/telephony/status` and
            // `/api/messaging/incoming` were never mounted, so a provider set
            // up from this screen sent call status and inbound SMS to a 404.
            // The server's table is apps/worker/lib/provider-webhook-urls.ts.
            WebhookUrlCard(
                label = stringResource(R.string.voice_incoming_webhook),
                url = "${webhookBaseUrl}/api/telephony/incoming",
            )

            Spacer(modifier = Modifier.height(12.dp))

            WebhookUrlCard(
                label = stringResource(R.string.voice_status_webhook),
                url = "${webhookBaseUrl}/api/telephony/call-status",
            )

            Spacer(modifier = Modifier.height(12.dp))

            // Inbound messages name their hub in the URL; one that names none is
            // refused (#2395), so with no hub there is no SMS URL to show.
            viewModel.activeHubId?.let { hubId ->
                WebhookUrlCard(
                    label = stringResource(R.string.sms_webhook),
                    url = "${webhookBaseUrl}/api/messaging/sms/webhook?hub=${Uri.encode(hubId)}",
                )
            }

            Spacer(modifier = Modifier.height(24.dp))

            Button(
                onClick = onNavigateBack,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.common_done))
            }
        }
    }
}

@Composable
private fun WebhookUrlCard(
    label: String,
    url: String,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
        ),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = url,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.primary,
            )
        }
    }
}
