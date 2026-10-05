package org.llamenos.hotline.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Backspace
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R

/**
 * Custom PIN pad composable with a numeric grid layout.
 *
 * Renders a 4x3 grid of digit buttons (1-9, 0) plus a backspace button.
 * Does NOT use TextField or the system keyboard — all input is through
 * direct button taps for security (prevents keyboard capture/logging).
 *
 * @param pin Current PIN string (digits entered so far)
 * @param maxLength Maximum PIN length (6-8 digits)
 * @param onPinChange Called when the PIN changes (digit added or removed)
 * @param onComplete Called when the PIN reaches maxLength
 * @param errorMessage Optional error text to display below the PIN dots
 * @param enabled Whether PIN input is enabled. Set to false during lockout.
 * @param modifier Layout modifier
 */
@Composable
fun PINPad(
    pin: String,
    maxLength: Int = 8,
    onPinChange: (String) -> Unit,
    onComplete: (String) -> Unit,
    errorMessage: String? = null,
    enabled: Boolean = true,
    modifier: Modifier = Modifier,
) {
    val buttons = listOf(
        listOf("1", "2", "3"),
        listOf("4", "5", "6"),
        listOf("7", "8", "9"),
        listOf("", "0", "backspace"),
    )
    val pinDotFilled = stringResource(R.string.pin_dot_filled)
    val pinDotEmpty = stringResource(R.string.pin_dot_empty)

    Column(
        modifier = modifier.testTag("pin-pad"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        // PIN dots
        Row(
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.testTag("pin-dots"),
        ) {
            repeat(maxLength) { index ->
                val isFilled = index < pin.length
                Box(
                    modifier = Modifier
                        .size(16.dp)
                        .clip(CircleShape)
                        .background(
                            if (isFilled) MaterialTheme.colorScheme.primary
                            else Color.Transparent
                        )
                        .border(
                            width = 2.dp,
                            color = if (errorMessage != null) {
                                MaterialTheme.colorScheme.error
                            } else {
                                MaterialTheme.colorScheme.outline
                            },
                            shape = CircleShape,
                        )
                        .semantics {
                            contentDescription = if (isFilled) pinDotFilled else pinDotEmpty
                        }
                )
            }
        }

        // Error message
        if (errorMessage != null) {
            Text(
                text = errorMessage,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.testTag("pin-error"),
            )
        }

        Spacer(Modifier.height(24.dp))

        // Number grid
        buttons.forEach { row ->
            Row(
                horizontalArrangement = Arrangement.spacedBy(24.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                row.forEach { label ->
                    when (label) {
                        "" -> {
                            // Empty spacer in bottom-left
                            Spacer(Modifier.size(72.dp))
                        }

                        "backspace" -> {
                            // Backspace button
                            IconButton(
                                onClick = {
                                    if (enabled && pin.isNotEmpty()) {
                                        onPinChange(pin.dropLast(1))
                                    }
                                },
                                enabled = enabled,
                                modifier = Modifier
                                    .size(72.dp)
                                    .testTag("pin-backspace"),
                            ) {
                                Icon(
                                    imageVector = Icons.AutoMirrored.Outlined.Backspace,
                                    contentDescription = stringResource(R.string.pin_backspace),
                                    tint = MaterialTheme.colorScheme.onSurface,
                                )
                            }
                        }

                        else -> {
                            // Digit button
                            FilledTonalButton(
                                onClick = {
                                    if (enabled && pin.length < maxLength) {
                                        val newPin = pin + label
                                        onPinChange(newPin)
                                        if (newPin.length == maxLength) {
                                            onComplete(newPin)
                                        }
                                    }
                                },
                                enabled = enabled,
                                modifier = Modifier
                                    .size(72.dp)
                                    .testTag("pin-$label"),
                                shape = CircleShape,
                            ) {
                                Text(
                                    text = label,
                                    style = MaterialTheme.typography.headlineMedium,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
