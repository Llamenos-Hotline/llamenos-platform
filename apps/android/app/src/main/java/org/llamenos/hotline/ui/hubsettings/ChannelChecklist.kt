package org.llamenos.hotline.ui.hubsettings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Message
import androidx.compose.material.icons.filled.Sms
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R
import org.llamenos.protocol.ChannelConfig

/**
 * Channel type with display info.
 */
private data class ChannelInfo(
    val key: String,
    val labelResId: Int,
    val icon: ImageVector,
    val isEnabled: (ChannelConfig) -> Boolean,
)

private val CHANNELS = listOf(
    ChannelInfo("voice", R.string.hub_onboarding_channel_voice, Icons.Filled.Call) { it.voice },
    ChannelInfo("sms", R.string.hub_onboarding_channel_sms, Icons.Filled.Sms) { it.sms },
    ChannelInfo("email", R.string.hub_onboarding_channel_email, Icons.Filled.Email) { it.email },
    ChannelInfo("signal", R.string.hub_onboarding_channel_signal, Icons.Filled.Chat) { it.signal },
    ChannelInfo("whatsapp", R.string.hub_onboarding_channel_whats_app, Icons.Filled.Chat) { it.whatsapp },
    ChannelInfo("telegram", R.string.hub_onboarding_channel_telegram, Icons.Filled.Message) { it.telegram },
    ChannelInfo("rcs", R.string.hub_onboarding_channel_rcs, Icons.Filled.Message) { it.rcs },
)

/**
 * Card with Material 3 Switch toggles for each communication channel.
 *
 * Used both in the onboarding flow and in the communications settings screen.
 */
@Composable
fun ChannelChecklist(
    channels: ChannelConfig,
    onToggle: (channel: String, enabled: Boolean) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    title: String? = null,
    description: String? = null,
    testTag: String = "channel-checklist",
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .testTag(testTag),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
        ),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
        ) {
            Text(
                text = title ?: stringResource(R.string.hub_onboarding_channel_settings_title),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.testTag("channel-checklist-title"),
            )

            if (description != null) {
                Text(
                    text = description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }

            Spacer(modifier = Modifier.height(12.dp))

            CHANNELS.forEach { channel ->
                ChannelSwitchRow(
                    label = stringResource(channel.labelResId),
                    icon = channel.icon,
                    checked = channel.isEnabled(channels),
                    onCheckedChange = { onToggle(channel.key, it) },
                    enabled = enabled,
                    testTag = "channel-switch-${channel.key}",
                )
            }
        }
    }
}

@Composable
private fun ChannelSwitchRow(
    label: String,
    icon: ImageVector,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    enabled: Boolean,
    testTag: String,
) {
    // The whole row is the toggle target (label included), so it exposes a single
    // Switch-role node with toggle state to accessibility services and tests.
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .toggleable(
                value = checked,
                enabled = enabled,
                role = Role.Switch,
                onValueChange = onCheckedChange,
            )
            .padding(vertical = 4.dp)
            .testTag(testTag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = if (checked) {
                MaterialTheme.colorScheme.primary
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
        )
        Spacer(modifier = Modifier.width(12.dp))
        Text(
            text = label,
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.weight(1f),
        )
        Switch(
            checked = checked,
            onCheckedChange = null,
            enabled = enabled,
        )
    }
}
