package org.llamenos.hotline.ui.auth

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
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
 * The user-initiated ways to destroy this device's identity (its stored keys).
 *
 * In the single-device model the device key is the only key the volunteer's author
 * envelopes are sealed to, so destroying it cannot be undone — the only way back is a
 * new invite. Each action therefore asks first, with copy that names what it does.
 *
 * @property dialogTag test tag of the confirmation dialog
 * @property confirmTag test tag of the dialog's destructive button
 * @property cancelTag test tag of the dialog's cancel button
 * @property showsWarningIcon whether the dialog leads with the warning icon
 */
enum class IdentityDestruction(
    @StringRes val titleRes: Int,
    @StringRes val messageRes: Int,
    val dialogTag: String,
    val confirmTag: String,
    val cancelTag: String,
    val showsWarningIcon: Boolean,
) {
    /** Log out: clears the stored keys and returns to the login screen. */
    LOGOUT(
        titleRes = R.string.common_logout,
        messageRes = R.string.settings_logout_confirm_message,
        dialogTag = "logout-confirmation-dialog",
        confirmTag = "confirm-logout-button",
        cancelTag = "cancel-logout-button",
        showsWarningIcon = false,
    ),

    /** Emergency wipe: clears the stored keys and everything else held on the device. */
    PANIC_WIPE(
        titleRes = R.string.panic_wipe_title,
        messageRes = R.string.panic_wipe_description,
        dialogTag = "panic-wipe-dialog",
        confirmTag = "confirm-panic-wipe-button",
        cancelTag = "cancel-panic-wipe-button",
        showsWarningIcon = true,
    ),

    /** Reset identity from the PIN screen: the volunteer abandons the stored identity. */
    RESET_IDENTITY(
        titleRes = R.string.reset_identity,
        messageRes = R.string.panic_wipe_description,
        dialogTag = "reset-identity-dialog",
        confirmTag = "confirm-reset-identity-button",
        cancelTag = "cancel-reset-identity-button",
        showsWarningIcon = true,
    ),
}

/**
 * Proof that the user confirmed destroying this device's identity.
 *
 * [AuthViewModel.destroyIdentity] takes one, so no screen can destroy the key without
 * asking: there is no `destroyIdentity()` to call by mistake, and a new caller cannot
 * compile until it routes through [Dialog]. The guarantee belongs to the action, not to
 * whichever screen happened to remember to ask (#2123 — the dashboard top bar's icon
 * destroyed the key on one tap while Settings → Log Out confirmed).
 *
 * The constructor is private and only [Dialog]'s confirm button calls it, so the only way
 * to hold one is for the user to have pressed the destructive button.
 */
class DestructionConfirmed private constructor(val action: IdentityDestruction) {

    companion object {
        /**
         * Confirmation dialog for [action]. [onConfirmed] receives the [DestructionConfirmed]
         * the destructive call requires; [onDismiss] is invoked on cancel or outside tap.
         */
        @Composable
        fun Dialog(
            action: IdentityDestruction,
            onConfirmed: (DestructionConfirmed) -> Unit,
            onDismiss: () -> Unit,
            modifier: Modifier = Modifier,
        ) {
            AlertDialog(
                onDismissRequest = onDismiss,
                icon = if (action.showsWarningIcon) {
                    {
                        Icon(
                            imageVector = Icons.Filled.Warning,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.error,
                            modifier = Modifier.size(32.dp),
                        )
                    }
                } else {
                    null
                },
                title = { Text(stringResource(action.titleRes)) },
                text = { Text(stringResource(action.messageRes)) },
                confirmButton = {
                    TextButton(
                        onClick = { onConfirmed(DestructionConfirmed(action)) },
                        modifier = Modifier.testTag(action.confirmTag),
                    ) {
                        Text(
                            text = stringResource(action.titleRes),
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                },
                dismissButton = {
                    TextButton(
                        onClick = onDismiss,
                        modifier = Modifier.testTag(action.cancelTag),
                    ) {
                        Text(stringResource(android.R.string.cancel))
                    }
                },
                modifier = modifier.testTag(action.dialogTag),
            )
        }
    }
}
