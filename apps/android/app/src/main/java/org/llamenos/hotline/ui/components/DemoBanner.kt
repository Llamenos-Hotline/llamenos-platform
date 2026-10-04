package org.llamenos.hotline.ui.components

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R

/** Matches the "Deploy your own" link target in src/client/components/demo-banner.tsx. */
private const val DEMO_DEPLOY_URL = "https://llamenos-platform.com/docs/getting-started"

/**
 * Banner displayed at the top of the main screen when the server reports demo
 * mode (`GET /api/config` → `demoMode`) -- the same signal the desktop client
 * reads via `useConfig().demoMode`. Mirrors `src/client/components/demo-banner.tsx`.
 *
 * Renders the `demo.*` i18n keys (never platform-local strings): the body
 * disclaimer text (`demo.bannerText` / `demo.bannerTextSchedule`), a
 * "Deploy your own" link (`demo.getStarted`), and a dismiss action
 * (`demo.dismiss`).
 *
 * @param demoResetSchedule When non-null, shows the schedule-specific body text
 *   instead of the generic "resets daily" copy -- same branching as desktop.
 */
@Composable
fun DemoBanner(
    onDismiss: () -> Unit,
    demoResetSchedule: String? = null,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.tertiaryContainer)
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .testTag("demo-banner"),
    ) {
        Text(
            text = if (demoResetSchedule != null) {
                stringResource(R.string.demo_banner_text_schedule, demoResetSchedule)
            } else {
                stringResource(R.string.demo_banner_text)
            },
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onTertiaryContainer,
            modifier = Modifier.testTag("demo-banner-text"),
        )

        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            TextButton(
                onClick = {
                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(DEMO_DEPLOY_URL)))
                },
                modifier = Modifier.testTag("demo-deploy-link"),
            ) {
                Text(
                    text = stringResource(R.string.demo_get_started),
                    style = MaterialTheme.typography.labelSmall,
                )
            }

            TextButton(
                onClick = onDismiss,
                modifier = Modifier.testTag("demo-dismiss-button"),
            ) {
                Text(
                    text = stringResource(R.string.demo_dismiss),
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }
    }
}
