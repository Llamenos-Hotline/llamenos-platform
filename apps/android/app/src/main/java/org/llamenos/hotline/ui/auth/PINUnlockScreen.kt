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
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Fingerprint
import androidx.compose.material.icons.outlined.PersonOff
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.biometric.BiometricPrompt
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.delay
import org.llamenos.hotline.R
import org.llamenos.hotline.ui.components.LoadingOverlay
import org.llamenos.hotline.ui.components.PINPad
import org.llamenos.hotline.ui.components.SecureWindowEffect
import kotlin.math.max

/**
 * PIN unlock screen for returning users with stored keys.
 *
 * Accepts the user's PIN and attempts to decrypt the stored device key.
 * Shows biometric option if configured.
 * Shows error on incorrect PIN and clears the entry.
 */
@Composable
fun PINUnlockScreen(
    viewModel: AuthViewModel,
    onAuthenticated: () -> Unit,
    onResetIdentity: () -> Unit,
    modifier: Modifier = Modifier,
) {
    SecureWindowEffect()

    val uiState by viewModel.uiState.collectAsState()
    var localPin by remember { mutableStateOf("") }
    val context = LocalContext.current
    // Mutable (not a one-shot `remember`): a tap that discovers the biometric
    // key was invalidated (device biometrics changed) must hide this button
    // immediately and fall back to the PIN pad below, which is unaffected.
    var biometricAvailable by remember { mutableStateOf(viewModel.hasBiometricPIN()) }

    // Countdown ticker: fires every second while locked out
    var lockoutSecondsRemaining by remember { mutableStateOf(0L) }
    LaunchedEffect(uiState.isLockedOut, uiState.lockoutUntil) {
        if (uiState.isLockedOut && uiState.lockoutUntil > 0) {
            while (true) {
                val remaining = (uiState.lockoutUntil - System.currentTimeMillis()) / 1000L
                if (remaining <= 0) {
                    lockoutSecondsRemaining = 0
                    break
                }
                lockoutSecondsRemaining = remaining
                delay(1_000L)
            }
        } else {
            lockoutSecondsRemaining = 0
        }
    }

    // Staggered entrance animation
    var showLogo by remember { mutableStateOf(false) }
    var showPad by remember { mutableStateOf(false) }
    var showActions by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        showLogo = true
        delay(150)
        showPad = true
        delay(100)
        showActions = true
    }

    // Navigate to dashboard when authenticated
    LaunchedEffect(uiState.isAuthenticated) {
        if (uiState.isAuthenticated) {
            onAuthenticated()
        }
    }

    // Reset local pin on error
    LaunchedEffect(uiState.error) {
        if (uiState.error != null) {
            localPin = ""
        }
    }

    // Key-wipe screen: shown when brute-force limit exceeded
    if (uiState.isWiped) {
        Scaffold(modifier = modifier) { paddingValues ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(paddingValues)
                    .padding(horizontal = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Icon(
                    imageVector = Icons.Outlined.PersonOff,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.error,
                    modifier = Modifier.size(48.dp),
                )

                Spacer(Modifier.height(24.dp))

                Text(
                    text = stringResource(R.string.lock_key_wiped),
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.error,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.testTag("pin-wipe-message"),
                )

                Spacer(Modifier.height(32.dp))

                OutlinedButton(
                    onClick = {
                        viewModel.resetAuthState()
                        onResetIdentity()
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("pin-wipe-reset"),
                ) {
                    Text(stringResource(R.string.reset_identity))
                }
            }
        }
        return
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

                // Logo
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
                            text = stringResource(R.string.unlock_title),
                            style = MaterialTheme.typography.headlineMedium,
                            color = MaterialTheme.colorScheme.onSurface,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.testTag("unlock-title"),
                        )

                        Spacer(Modifier.height(8.dp))

                        Text(
                            text = stringResource(R.string.unlock_subtitle),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            textAlign = TextAlign.Center,
                        )
                    }
                }

                Spacer(Modifier.height(36.dp))

                // Lockout countdown message (replaces normal error during lockout)
                if (uiState.isLockedOut && lockoutSecondsRemaining > 0) {
                    Text(
                        text = stringResource(
                            R.string.pin_lockout_remaining,
                            max(lockoutSecondsRemaining, 1L).toInt(),
                        ),
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.testTag("pin-lockout-message"),
                    )
                    Spacer(Modifier.height(16.dp))
                }

                // PIN pad — disabled during lockout
                AnimatedVisibility(
                    visible = showPad,
                    enter = fadeIn() + slideInVertically { it / 4 },
                ) {
                    PINPad(
                        pin = localPin,
                        onPinChange = { newPin ->
                            localPin = newPin
                            viewModel.updatePin(newPin)
                        },
                        onComplete = { completedPin ->
                            viewModel.unlockWithPin(completedPin)
                        },
                        errorMessage = if (uiState.isLockedOut) null else uiState.error,
                        enabled = !uiState.isLockedOut,
                    )
                }

                Spacer(Modifier.height(24.dp))

                // Action buttons
                AnimatedVisibility(
                    visible = showActions,
                    enter = fadeIn(),
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        // Use biometric button (when biometric-protected PIN is configured)
                        if (biometricAvailable && !uiState.isLockedOut) {
                            val biometricTitle = stringResource(R.string.biometric_unlock_title)
                            val biometricSubtitle = stringResource(R.string.biometric_unlock_subtitle)
                            val usePinText = stringResource(R.string.use_pin_instead)
                            OutlinedButton(
                                onClick = {
                                    val decryptCipher = viewModel.getBiometricDecryptCipher()
                                    if (decryptCipher == null) {
                                        // Nothing enrolled, or the key was just invalidated by a
                                        // biometric change (already wiped by the view model) —
                                        // hide the button so the PIN pad is the only path forward.
                                        biometricAvailable = false
                                        return@OutlinedButton
                                    }
                                    val executor = ContextCompat.getMainExecutor(context)
                                    val biometricPrompt = BiometricPrompt(
                                        context as FragmentActivity,
                                        executor,
                                        object : BiometricPrompt.AuthenticationCallback() {
                                            override fun onAuthenticationSucceeded(
                                                result: BiometricPrompt.AuthenticationResult,
                                            ) {
                                                val cipher = result.cryptoObject?.cipher ?: return
                                                viewModel.onBiometricSuccess(cipher)
                                            }
                                            override fun onAuthenticationError(
                                                errorCode: Int,
                                                errString: CharSequence,
                                            ) {
                                                // User cancelled or hardware unavailable —
                                                // PIN pad still showing, nothing to do.
                                            }
                                            override fun onAuthenticationFailed() {
                                                // Single attempt failed — system shows retry UI.
                                            }
                                        }
                                    )
                                    val promptInfo = BiometricPrompt.PromptInfo.Builder()
                                        .setTitle(biometricTitle)
                                        .setSubtitle(biometricSubtitle)
                                        .setNegativeButtonText(usePinText)
                                        .build()
                                    biometricPrompt.authenticate(
                                        promptInfo,
                                        BiometricPrompt.CryptoObject(decryptCipher),
                                    )
                                },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(48.dp)
                                    .testTag("biometric-unlock"),
                            ) {
                                Icon(
                                    imageVector = Icons.Filled.Fingerprint,
                                    contentDescription = null,
                                    modifier = Modifier.size(18.dp),
                                )
                                Spacer(Modifier.size(8.dp))
                                Text(stringResource(R.string.use_biometric))
                            }
                        }

                        Spacer(Modifier.height(12.dp))

                        // Reset identity link
                        TextButton(
                            onClick = {
                                viewModel.resetAuthState()
                                onResetIdentity()
                            },
                            modifier = Modifier.testTag("reset-identity"),
                        ) {
                            Icon(
                                imageVector = Icons.Outlined.PersonOff,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.error,
                                modifier = Modifier.size(16.dp),
                            )
                            Spacer(Modifier.size(8.dp))
                            Text(
                                text = stringResource(R.string.reset_identity),
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                }

                Spacer(Modifier.height(32.dp))
            }

            LoadingOverlay(
                isLoading = uiState.isLoading,
                message = stringResource(R.string.decrypting_keys),
            )
        }
    }
}
