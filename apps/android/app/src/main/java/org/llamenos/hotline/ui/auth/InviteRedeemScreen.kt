package org.llamenos.hotline.ui.auth

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R

/**
 * Last step of enrolment by invite: redeem the invite with the device keys just created
 * at PIN set, then continue to the dashboard. A failed redemption stays here with the
 * error and a retry — the keys are already stored, so retrying needs no new PIN.
 */
@Composable
fun InviteRedeemScreen(
    viewModel: InviteViewModel,
    onRedeemed: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()

    LaunchedEffect(Unit) { viewModel.redeem() }
    LaunchedEffect(uiState.stage) {
        if (uiState.stage == InviteStage.REDEEMED) onRedeemed()
    }

    Scaffold(modifier = modifier) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .padding(32.dp)
                .testTag("invite-redeem"),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(modifier = Modifier.weight(1f))
            val errorRes = uiState.errorRes
            if (errorRes == null) {
                CircularProgressIndicator(modifier = Modifier.testTag("invite-redeem-progress"))
                Spacer(modifier = Modifier.height(16.dp))
                Text(
                    text = stringResource(R.string.common_loading),
                    style = MaterialTheme.typography.bodyLarge,
                )
            } else {
                Text(
                    text = stringResource(R.string.onboarding_error_title),
                    style = MaterialTheme.typography.headlineSmall,
                    textAlign = TextAlign.Center,
                )
                Spacer(modifier = Modifier.height(12.dp))
                Text(
                    text = stringResource(errorRes),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.error,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.testTag("invite-redeem-error"),
                )
                Spacer(modifier = Modifier.height(24.dp))
                Button(
                    onClick = viewModel::redeem,
                    modifier = Modifier.testTag("invite-redeem-retry"),
                ) {
                    Text(stringResource(R.string.common_retry))
                }
            }
            Spacer(modifier = Modifier.weight(2f))
        }
    }
}
