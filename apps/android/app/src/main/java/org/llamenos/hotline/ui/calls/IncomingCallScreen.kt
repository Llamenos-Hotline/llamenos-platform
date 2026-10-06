package org.llamenos.hotline.ui.calls

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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R
import org.llamenos.hotline.telephony.RingingCallInfo

/**
 * Full-screen incoming-call surface: caller identity plus Answer/Decline actions.
 *
 * Rendered above the whole navigation tree whenever [org.llamenos.hotline.telephony.IncomingCallTracker]
 * has a ringing call — so the screen appears whether the user tapped the notification,
 * followed the full-screen intent from the lockscreen, or never left the app.
 *
 * [isUnlocked] mirrors the notification's PII posture: while the app is locked the caller
 * identity stays generic ("Someone is calling the hotline"), matching the push path.
 *
 * [microphoneDenied] says the `RECORD_AUDIO` grant was refused, so answering would produce a
 * call the caller can be heard on and the volunteer cannot be heard on. Saying so beats letting
 * them answer into silence.
 *
 * Test tags: `incoming-caller-label`, `incoming-accept`, `incoming-decline`,
 * `incoming-microphone-denied`.
 */
@Composable
fun IncomingCallScreen(
    info: RingingCallInfo,
    isUnlocked: Boolean,
    onAccept: () -> Unit,
    onDecline: () -> Unit,
    modifier: Modifier = Modifier,
    microphoneDenied: Boolean = false,
) {
    Surface(
        modifier = modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = stringResource(R.string.incoming_call),
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(modifier = Modifier.height(16.dp))
            Text(
                text = callerLabel(info, isUnlocked),
                modifier = Modifier
                    .testTag("incoming-caller-label")
                    .padding(horizontal = 16.dp),
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.onBackground,
                textAlign = TextAlign.Center,
            )
            if (microphoneDenied) {
                Spacer(modifier = Modifier.height(16.dp))
                Text(
                    text = stringResource(R.string.incoming_call_microphone_required),
                    modifier = Modifier
                        .testTag("incoming-microphone-denied")
                        .padding(horizontal = 16.dp),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                    textAlign = TextAlign.Center,
                )
            }
            Spacer(modifier = Modifier.height(64.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // Decline
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Surface(
                        onClick = onDecline,
                        modifier = Modifier
                            .testTag("incoming-decline")
                            .size(72.dp),
                        shape = CircleShape,
                        color = Color(0xFFB3261E),
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Icon(
                                imageVector = Icons.Filled.CallEnd,
                                contentDescription = stringResource(R.string.incoming_call_decline),
                                tint = Color.White,
                                modifier = Modifier.size(36.dp),
                            )
                        }
                    }
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = stringResource(R.string.incoming_call_decline),
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onBackground,
                    )
                }
                // Answer
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Surface(
                        onClick = onAccept,
                        modifier = Modifier
                            .testTag("incoming-accept")
                            .size(72.dp),
                        shape = CircleShape,
                        color = Color(0xFF2E7D32),
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Icon(
                                imageVector = Icons.Filled.Call,
                                contentDescription = stringResource(R.string.incoming_call_answer),
                                tint = Color.White,
                                modifier = Modifier.size(36.dp),
                            )
                        }
                    }
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = stringResource(R.string.incoming_call_answer),
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onBackground,
                    )
                }
            }
        }
    }
}

@Composable
private fun callerLabel(info: RingingCallInfo, isUnlocked: Boolean): String =
    if (isUnlocked) {
        info.remoteDisplayName ?: info.remoteAddress
    } else {
        stringResource(R.string.incoming_call_body)
    }
