package org.llamenos.hotline.ui.providersetup

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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import org.llamenos.hotline.R
import org.llamenos.protocol.SignalRegistrationStatus

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SignalRegistrationScreen(
    onNavigateBack: () -> Unit,
    modifier: Modifier = Modifier,
    viewModel: SignalRegistrationViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val verificationCode by viewModel.verificationCode.collectAsState()
    val isLoading by viewModel.isLoading.collectAsState()
    val error by viewModel.error.collectAsState()
    val isVerifying by viewModel.isVerifying.collectAsState()
    val isUnregistering by viewModel.isUnregistering.collectAsState()

    var bridgeUrl by remember { mutableStateOf("") }
    var phoneNumber by remember { mutableStateOf("") }
    var method by remember { mutableStateOf("sms") }

    LaunchedEffect(Unit) {
        viewModel.loadStatus()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = stringResource(R.string.signal_registration_title),
                        modifier = Modifier.testTag("signal-registration-title"),
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
                actions = {
                    IconButton(onClick = { viewModel.loadStatus() }) {
                        Icon(
                            imageVector = Icons.Filled.Refresh,
                            contentDescription = stringResource(R.string.action_refresh),
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
            when {
                isLoading && state == null -> {
                    Box(
                        modifier = Modifier.fillMaxSize(),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator()
                    }
                }

                state != null -> {
                    SignalStatusPanel(
                        state = state!!,
                        verificationCode = verificationCode,
                        isVerifying = isVerifying,
                        isUnregistering = isUnregistering,
                        onVerificationCodeChange = viewModel::updateVerificationCode,
                        onVerify = viewModel::verifyCode,
                        onUnregister = viewModel::unregister,
                    )
                }

                else -> {
                    SignalRegistrationForm(
                        bridgeUrl = bridgeUrl,
                        onBridgeUrlChange = { bridgeUrl = it },
                        phoneNumber = phoneNumber,
                        onPhoneNumberChange = { phoneNumber = it },
                        method = method,
                        onMethodChange = { method = it },
                        onStartRegistration = {
                            viewModel.startRegistration(
                                bridgeUrl = bridgeUrl,
                                phoneNumber = phoneNumber,
                                method = method,
                            )
                        },
                        isLoading = isLoading,
                    )
                }
            }

            error?.let { errorMsg ->
                Spacer(modifier = Modifier.height(16.dp))
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Icon(
                        imageVector = Icons.Filled.Error,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.error,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = errorMsg,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                Spacer(modifier = Modifier.height(8.dp))
                OutlinedButton(
                    onClick = { viewModel.clearError() },
                ) {
                    Text(stringResource(R.string.dismiss))
                }
            }
        }
    }
}

@Composable
private fun SignalRegistrationForm(
    bridgeUrl: String,
    onBridgeUrlChange: (String) -> Unit,
    phoneNumber: String,
    onPhoneNumberChange: (String) -> Unit,
    method: String,
    onMethodChange: (String) -> Unit,
    onStartRegistration: () -> Unit,
    isLoading: Boolean,
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        OutlinedTextField(
            value = bridgeUrl,
            onValueChange = onBridgeUrlChange,
            label = { Text(stringResource(R.string.bridge_url_label)) },
            modifier = Modifier
                .fillMaxWidth()
                .testTag("bridge-url-field"),
            keyboardOptions = KeyboardOptions(
                imeAction = ImeAction.Next,
            ),
            singleLine = true,
        )

        Spacer(modifier = Modifier.height(12.dp))

        OutlinedTextField(
            value = phoneNumber,
            onValueChange = onPhoneNumberChange,
            label = { Text(stringResource(R.string.phone_number_label)) },
            modifier = Modifier
                .fillMaxWidth()
                .testTag("signal-phone-field"),
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Phone,
                imeAction = ImeAction.Done,
            ),
            singleLine = true,
        )

        Spacer(modifier = Modifier.height(12.dp))

        Text(
            text = stringResource(R.string.verification_method_label),
            style = MaterialTheme.typography.bodyMedium,
        )

        Row(verticalAlignment = Alignment.CenterVertically) {
            RadioButton(
                selected = method == "sms",
                onClick = { onMethodChange("sms") },
            )
            Text(stringResource(R.string.method_sms))
            Spacer(modifier = Modifier.width(16.dp))
            RadioButton(
                selected = method == "voice",
                onClick = { onMethodChange("voice") },
            )
            Text(stringResource(R.string.method_voice))
        }

        Spacer(modifier = Modifier.height(24.dp))

        Button(
            onClick = onStartRegistration,
            enabled = !isLoading && bridgeUrl.isNotBlank() && phoneNumber.isNotBlank(),
            modifier = Modifier
                .fillMaxWidth()
                .testTag("start-registration-button"),
        ) {
            if (isLoading) {
                CircularProgressIndicator(modifier = Modifier.size(16.dp))
            } else {
                Text(stringResource(R.string.start_registration))
            }
        }
    }
}

@Composable
private fun SignalStatusPanel(
    state: org.llamenos.protocol.SignalRegistrationState,
    verificationCode: String,
    isVerifying: Boolean,
    isUnregistering: Boolean,
    onVerificationCodeChange: (String) -> Unit,
    onVerify: () -> Unit,
    onUnregister: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        StatusIcon(status = state.status)

        Spacer(modifier = Modifier.height(16.dp))

        Text(
            text = stringResource(R.string.signal_status_label),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Text(
            text = state.status.value,
            style = MaterialTheme.typography.titleLarge,
            color = when (state.status) {
                SignalRegistrationStatus.Complete -> MaterialTheme.colorScheme.primary
                SignalRegistrationStatus.Failed -> MaterialTheme.colorScheme.error
                else -> MaterialTheme.colorScheme.onSurface
            },
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = state.phoneNumberMasked,
            style = MaterialTheme.typography.bodyLarge,
        )

        when (state.status) {
            SignalRegistrationStatus.Idle -> Unit

            SignalRegistrationStatus.Pending,
            SignalRegistrationStatus.Verifying -> {
                Spacer(modifier = Modifier.height(16.dp))
                CircularProgressIndicator()
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = stringResource(R.string.signal_registration_in_progress),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Spacer(modifier = Modifier.height(16.dp))

                OutlinedTextField(
                    value = verificationCode,
                    onValueChange = onVerificationCodeChange,
                    label = { Text(stringResource(R.string.verification_code_label)) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("verification-code-field"),
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Number,
                        imeAction = ImeAction.Done,
                    ),
                    singleLine = true,
                )

                Spacer(modifier = Modifier.height(8.dp))

                Button(
                    onClick = onVerify,
                    enabled = !isVerifying && verificationCode.isNotBlank(),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (isVerifying) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp))
                    } else {
                        Text(stringResource(R.string.verify_code_button))
                    }
                }
            }

            SignalRegistrationStatus.Complete -> {
                Spacer(modifier = Modifier.height(16.dp))
                Text(
                    text = stringResource(R.string.signal_registered_message),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.primary,
                )

                Spacer(modifier = Modifier.height(16.dp))

                OutlinedButton(
                    onClick = onUnregister,
                    enabled = !isUnregistering,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (isUnregistering) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp))
                    } else {
                        Text(stringResource(R.string.unregister_signal))
                    }
                }
            }

            SignalRegistrationStatus.Failed -> {
                Spacer(modifier = Modifier.height(16.dp))
                state.error?.let { error ->
                    Text(
                        text = error,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error,
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                }
                OutlinedButton(
                    onClick = onUnregister,
                    enabled = !isUnregistering,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(stringResource(R.string.retry_registration))
                }
            }

        }
    }
}

@Composable
private fun StatusIcon(status: SignalRegistrationStatus) {
    when (status) {
        SignalRegistrationStatus.Complete -> {
            Icon(
                imageVector = Icons.Filled.CheckCircle,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(64.dp),
            )
        }
        SignalRegistrationStatus.Failed -> {
            Icon(
                imageVector = Icons.Filled.Error,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error,
                modifier = Modifier.size(64.dp),
            )
        }
        else -> {
            CircularProgressIndicator(modifier = Modifier.size(64.dp))
        }
    }
}
