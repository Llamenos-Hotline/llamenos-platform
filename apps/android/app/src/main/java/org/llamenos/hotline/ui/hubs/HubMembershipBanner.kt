package org.llamenos.hotline.ui.hubs

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R

/**
 * Shown above every tab while the hub list could not be read and no hub is active (#2565).
 *
 * Each hub-owned screen reports its own failure, but only this says WHY and offers the
 * retry that can fix it: re-reading the hub list, after which every screen reloads.
 * Deliberately a banner and not the desktop's full-screen stop
 * (`HubMembershipErrorScreen`): the main screen owns the relay connection and the call
 * UI, and incoming calls from every member hub must keep arriving whatever is known about
 * membership.
 */
@Composable
fun HubMembershipBanner(visible: Boolean, onRetry: () -> Unit) {
    if (!visible) return
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.errorContainer)
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .testTag("hub-membership-error-banner"),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            text = stringResource(R.string.hubs_membership_load_failed_title),
            color = MaterialTheme.colorScheme.onErrorContainer,
            style = MaterialTheme.typography.titleSmall,
            modifier = Modifier.testTag("hub-membership-error-title"),
        )
        Text(
            text = stringResource(R.string.hubs_membership_load_failed_body),
            color = MaterialTheme.colorScheme.onErrorContainer,
            style = MaterialTheme.typography.bodySmall,
        )
        TextButton(onClick = onRetry, modifier = Modifier.testTag("hub-membership-error-retry")) {
            Text(stringResource(R.string.common_retry))
        }
    }
}
