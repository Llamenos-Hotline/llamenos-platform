package org.llamenos.hotline.ui.admin

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R

/**
 * The admin deletions that cannot be taken back from the app (#2540).
 *
 * Each has its own consequence copy rather than one generic "Delete this item?": what an
 * admin needs to be told differs per action, and for a ban removal the consequence *is* the
 * point — the caller the hub excluded can reach the hotline again, and the app keeps no
 * number to ban them with afterwards.
 *
 * @property titleRes dialog title
 * @property messageRes the consequence, in full
 * @property confirmRes label of the destructive button
 * @property slug prefix of the dialog's test tags
 */
enum class AdminDeletion(
    @StringRes val titleRes: Int,
    @StringRes val messageRes: Int,
    @StringRes val confirmRes: Int,
    val slug: String,
) {
    /** Remove a hub ban: the caller can reach the hotline again. */
    BAN(
        titleRes = R.string.ban_list_remove_confirm_title,
        messageRes = R.string.ban_list_remove_confirm_message,
        confirmRes = R.string.ban_list_remove,
        slug = "remove-ban",
    ),

    /** Remove a platform ban: the caller can reach every hub again. */
    PLATFORM_BAN(
        titleRes = R.string.platform_bans_remove_confirm_title,
        messageRes = R.string.platform_bans_remove_confirm_message,
        confirmRes = R.string.ban_list_remove,
        slug = "remove-platform-ban",
    ),

    /** Delete a shift: its hours may be left with nobody on shift. */
    SHIFT(
        titleRes = R.string.shifts_delete_confirm_title,
        messageRes = R.string.shifts_delete_confirm_message,
        confirmRes = R.string.shifts_delete,
        slug = "delete-shift",
    ),

    /** Delete a custom field definition; notes keep the values they hold. */
    CUSTOM_FIELD(
        titleRes = R.string.field_delete,
        messageRes = R.string.custom_fields_delete_confirm,
        confirmRes = R.string.field_delete,
        slug = "delete-field",
    ),

    /** Archive a report category (the server archives; it never removes the row). */
    REPORT_CATEGORY(
        titleRes = R.string.report_types_archive_title,
        messageRes = R.string.report_types_archive_confirm,
        confirmRes = R.string.report_types_archive_action,
        slug = "delete-category",
    ),
    ;

    val dialogTag get() = "$slug-dialog"
    val subjectTag get() = "$slug-subject"
    val confirmTag get() = "confirm-$slug-button"
    val cancelTag get() = "cancel-$slug-button"
}

/**
 * Proof that the user confirmed one specific admin deletion.
 *
 * The destructive [AdminViewModel] calls (`removeBan`, `removePlatformBan`, `deleteShift`,
 * `deleteCustomField`, `deleteReportCategory`) each take one, so no screen can delete without
 * asking: there is no argument-less form to call by mistake, and a new caller cannot compile
 * until it routes through [Dialog]. The guarantee belongs to the action, not to whichever
 * screen remembered to ask — the same mechanism as `DestructionConfirmed` for identity
 * destruction (#2123).
 *
 * The constructor is private and only [Dialog]'s confirm button calls it, so the only way to
 * hold one is for the user to have pressed the destructive button. It is bound to the
 * [action] *and* the [targetId] shown in the dialog, so a confirmation of one row cannot be
 * spent on another, nor a shift's confirmation on a ban ([requireFor]).
 */
class DeletionConfirmed private constructor(
    val action: AdminDeletion,
    val targetId: String,
) {
    /** Throws unless this confirmation was minted for exactly [action] on [targetId]. */
    fun requireFor(action: AdminDeletion, targetId: String) {
        require(this.action == action && this.targetId == targetId) {
            "confirmation for ${this.action} cannot authorise $action"
        }
    }

    companion object {
        /**
         * Confirmation dialog for [action] on the row [targetId]. [subject] names the row
         * (user data, so not localised); [onConfirmed] receives the [DeletionConfirmed] the
         * destructive call requires; [onDismiss] is invoked on cancel or outside tap.
         */
        @Composable
        fun Dialog(
            action: AdminDeletion,
            targetId: String,
            subject: String,
            onConfirmed: (DeletionConfirmed) -> Unit,
            onDismiss: () -> Unit,
            modifier: Modifier = Modifier,
        ) {
            AlertDialog(
                onDismissRequest = onDismiss,
                icon = {
                    Icon(
                        imageVector = Icons.Filled.Warning,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.error,
                        modifier = Modifier.size(32.dp),
                    )
                },
                title = { Text(stringResource(action.titleRes)) },
                text = {
                    Column {
                        if (subject.isNotBlank()) {
                            Text(
                                text = subject,
                                style = MaterialTheme.typography.bodyLarge,
                                fontWeight = FontWeight.SemiBold,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.testTag(action.subjectTag),
                            )
                            Spacer(Modifier.height(8.dp))
                        }
                        Text(stringResource(action.messageRes))
                    }
                },
                confirmButton = {
                    TextButton(
                        onClick = { onConfirmed(DeletionConfirmed(action, targetId)) },
                        modifier = Modifier.testTag(action.confirmTag),
                    ) {
                        Text(
                            text = stringResource(action.confirmRes),
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
