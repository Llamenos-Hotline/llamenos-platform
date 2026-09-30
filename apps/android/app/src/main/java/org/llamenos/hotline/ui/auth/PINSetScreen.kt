package org.llamenos.hotline.ui.auth

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import org.llamenos.hotline.R
import org.llamenos.hotline.ui.components.LoadingOverlay
import org.llamenos.hotline.ui.components.PINPad
import org.llamenos.hotline.ui.components.SecureWindowEffect

/**
 * PIN set screen with enter + confirm flow.
 *
 * Two phases:
 * 1. "Enter a PIN" — user enters 6-8 digit PIN
 * 2. "Confirm your PIN" — user re-enters the same PIN
 *
 * On mismatch, shows error and resets to confirmation phase.
 * On match, encrypts the key with the PIN and navigates to dashboard.
 */
@Composable
fun PINSetScreen(
    viewModel: AuthViewModel,
    onAuthenticated: () -> Unit,
    modifier: Modifier = Modifier,
) {
    SecureWindowEffect()

    val uiState by viewModel.uiState.collectAsState()
    var localPin by remember { mutableStateOf("") }

    // Staggered entrance animation
    var showLogo by remember { mutableStateOf(false) }
    var showPad by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        showLogo = true
        delay(150)
        showPad = true
    }

    // Navigate to dashboard when authenticated
    LaunchedEffect(uiState.isAuthenticated) {
        if (uiState.isAuthenticated) {
            onAuthenticated()
        }
    }

    // Reset local pin when switching between phases
    LaunchedEffect(uiState.isConfirmingPin) {
        localPin = ""
    }

    // Reset local pin on mismatch
    LaunchedEffect(uiState.pinMismatch) {
        if (uiState.pinMismatch) {
            localPin = ""
        }
    }

    Scaffold(modifier = modifier) { paddingValues ->
        Box(modifier = Modifier.fillMaxSize()) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(paddingValues)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Spacer(Modifier.height(32.dp))

                // Logo + title
                AnimatedVisibility(
                    visible = showLogo,
                    enter = fadeIn() + slideInVertically { -it / 3 },
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Image(
                            painter = painterResource(R.drawable.logo_mark),
                            contentDescription = stringResource(R.string.app_name),
                            modifier = Modifier.size(72.dp),
                        )

                        Spacer(Modifier.height(16.dp))

                        Text(
                            text = if (uiState.isConfirmingPin) {
                                stringResource(R.string.pin_confirm_title)
                            } else {
                                stringResource(R.string.pin_set_title)
                            },
                            style = MaterialTheme.typography.headlineMedium,
                            color = MaterialTheme.colorScheme.onSurface,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.testTag("pin-title"),
                        )

                        Spacer(Modifier.height(8.dp))

                        Text(
                            text = if (uiState.isConfirmingPin) {
                                stringResource(R.string.pin_confirm_subtitle)
                            } else {
                                stringResource(R.string.pin_set_subtitle)
                            },
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            textAlign = TextAlign.Center,
                        )
                    }
                }

                Spacer(Modifier.height(36.dp))

                // PIN pad
                AnimatedVisibility(
                    visible = showPad,
                    enter = fadeIn() + slideInVertically { it / 4 },
                ) {
                    PINPad(
                        pin = localPin,
                        onPinChange = { newPin ->
                            localPin = newPin
                        },
                        onComplete = { completedPin ->
                            viewModel.onPinSetComplete(completedPin)
                        },
                        errorMessage = when {
                            uiState.pinMismatch -> stringResource(R.string.pin_mismatch)
                            uiState.error != null -> uiState.error
                            else -> null
                        },
                    )
                }

                Spacer(Modifier.height(32.dp))
            }

            LoadingOverlay(
                isLoading = uiState.isLoading,
                message = stringResource(R.string.encrypting_keys),
            )
        }
    }
}
