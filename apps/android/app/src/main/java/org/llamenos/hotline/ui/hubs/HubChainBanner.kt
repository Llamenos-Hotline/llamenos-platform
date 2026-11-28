package org.llamenos.hotline.ui.hubs

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.StateFlow
import org.llamenos.hotline.R
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.hub.HubChainService
import javax.inject.Inject

/** The active hub and every hub's chain verdict, for [HubChainBanner] (#2963). */
@HiltViewModel
class HubChainViewModel @Inject constructor(
    private val hubChain: HubChainService,
    activeHubState: ActiveHubState,
) : ViewModel() {
    val activeHubId: StateFlow<String?> = activeHubState.activeHubId
    val statuses: StateFlow<Map<String, HubChainService.Status>> = hubChain.statuses

    /** Verify the hub's chain in Rust when none is known yet; a fetch failure keeps the last verdict. */
    suspend fun ensureLoaded(hubId: String) {
        if (statuses.value[hubId] == null) runCatching { hubChain.load(hubId) }
    }
}

/**
 * The active hub's authority-chain alerts (#2963): a fork or a refused
 * (unauthorised or invalid) chain — sealing in the hub has stopped — and the
 * advisory stale-signer finding (D13). The verdict itself gates sealing for every
 * hub, active or not ([HubChainService.assertSealable]).
 */
@Composable
fun HubChainBanner(viewModel: HubChainViewModel) {
    val hubId by viewModel.activeHubId.collectAsState()
    val statuses by viewModel.statuses.collectAsState()
    LaunchedEffect(hubId) { hubId?.let { viewModel.ensureLoaded(it) } }
    val status = hubId?.let { statuses[it] } ?: return
    when (status) {
        is HubChainService.Status.Fork -> StoppedBanner(R.string.hub_chain_alert_fork_title, "fork")
        is HubChainService.Status.Refused -> StoppedBanner(
            R.string.hub_chain_alert_refused_title,
            if (status.code == "chain_unauthorised_signer") "unauthorised" else "invalid",
        )
        is HubChainService.Status.Verified -> if (status.staleSigners > 0) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.tertiaryContainer)
                    .padding(horizontal = 16.dp, vertical = 8.dp)
                    .testTag("hub-chain-alert-stale_signer"),
            ) {
                Text(
                    text = stringResource(R.string.hub_chain_alert_stale_signer, status.staleSigners.toString()),
                    color = MaterialTheme.colorScheme.onTertiaryContainer,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
        HubChainService.Status.None -> Unit
    }
}

@Composable
private fun StoppedBanner(titleRes: Int, kind: String) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.errorContainer)
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .testTag("hub-chain-alert-$kind"),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            text = stringResource(titleRes),
            color = MaterialTheme.colorScheme.onErrorContainer,
            style = MaterialTheme.typography.titleSmall,
        )
        Text(
            text = stringResource(R.string.hub_chain_alert_sealing_stopped),
            color = MaterialTheme.colorScheme.onErrorContainer,
            style = MaterialTheme.typography.bodySmall,
        )
    }
}
