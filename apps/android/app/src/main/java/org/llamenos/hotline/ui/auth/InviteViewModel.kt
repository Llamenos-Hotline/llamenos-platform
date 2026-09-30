package org.llamenos.hotline.ui.auth

import android.net.Uri
import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.llamenos.hotline.R
import org.llamenos.hotline.api.InviteRepository
import org.llamenos.protocol.ErrorEnum
import java.io.IOException
import java.util.UUID
import javax.inject.Inject

/** Where an invite is in the enrolment flow: Login → PIN set → redeem → dashboard. */
enum class InviteStage { NONE, VALIDATING, VALID, REDEEMING, REDEEMED }

data class InviteUiState(
    /** What the user typed or pasted: a bare invite code or a whole invite link. */
    val input: String = "",
    /** The invite code parsed out of [input], once it has been validated. */
    val code: String? = null,
    val stage: InviteStage = InviteStage.NONE,
    @StringRes val errorRes: Int? = null,
)

/**
 * Enrolment by invite (#1345).
 *
 * Scoped to the auth NavHost so the invite survives Login → PIN set → redeem. The
 * invite is validated before the user chooses a PIN, and redeemed once the new device
 * keys exist (redemption signs with them). Redemption registers the identity with the
 * server; hub membership is granted by a hub admin, and the app picks the hub up by
 * itself once it exists.
 */
@HiltViewModel
class InviteViewModel @Inject constructor(
    private val inviteRepository: InviteRepository,
) : ViewModel() {

    private val _uiState = MutableStateFlow(InviteUiState())
    val uiState: StateFlow<InviteUiState> = _uiState.asStateFlow()

    /** Whether the user is enrolling with an invite (as opposed to creating a bare identity). */
    val hasInvite: Boolean get() = _uiState.value.input.isNotBlank()

    fun updateInput(input: String) {
        _uiState.value = InviteUiState(input = input)
    }

    /**
     * Validate the entered invite against the configured hub. On success the stage
     * becomes [InviteStage.VALID], which is the signal to continue to PIN set.
     */
    fun validate() {
        val code = parseInvite(_uiState.value.input)?.code
        if (code == null) {
            _uiState.update { it.copy(stage = InviteStage.NONE, errorRes = R.string.onboarding_invalid_code) }
            return
        }
        _uiState.update { it.copy(stage = InviteStage.VALIDATING, errorRes = null) }
        viewModelScope.launch {
            val errorRes = try {
                val result = inviteRepository.validate(code)
                when {
                    result.valid -> null
                    result.error == ErrorEnum.Expired -> R.string.onboarding_expired
                    result.error == ErrorEnum.AlreadyUsed -> R.string.onboarding_already_used
                    else -> R.string.onboarding_invalid_code
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: IOException) {
                R.string.connection_failed
            } catch (_: Exception) {
                R.string.onboarding_invalid_code
            }
            _uiState.update {
                if (errorRes == null) it.copy(code = code, stage = InviteStage.VALID)
                else it.copy(stage = InviteStage.NONE, errorRes = errorRes)
            }
        }
    }

    /** Redeem the validated invite with the device keys created at PIN set. */
    fun redeem() {
        val code = _uiState.value.code ?: return
        if (_uiState.value.stage == InviteStage.REDEEMING || _uiState.value.stage == InviteStage.REDEEMED) return
        _uiState.update { it.copy(stage = InviteStage.REDEEMING, errorRes = null) }
        viewModelScope.launch {
            val errorRes = try {
                inviteRepository.redeem(code)
                null
            } catch (e: CancellationException) {
                throw e
            } catch (_: IOException) {
                R.string.connection_failed
            } catch (_: Exception) {
                R.string.onboarding_redeem_failed
            }
            _uiState.update {
                if (errorRes == null) it.copy(stage = InviteStage.REDEEMED)
                else it.copy(stage = InviteStage.VALID, errorRes = errorRes)
            }
        }
    }

    data class ParsedInvite(val code: String, val hubUrl: String?)

    companion object {
        /**
         * Accept either a bare invite code or an invite link carrying it as `?code=`.
         * A link also names the hub it came from (its http(s) origin).
         */
        fun parseInvite(input: String): ParsedInvite? {
            val trimmed = input.trim()
            if (trimmed.isEmpty()) return null
            asInviteCode(trimmed)?.let { return ParsedInvite(it, hubUrl = null) }
            val uri = runCatching { Uri.parse(trimmed) }.getOrNull() ?: return null
            val code = uri.getQueryParameter("code")?.let(::asInviteCode) ?: return null
            val hubUrl = if (uri.scheme == "https" || uri.scheme == "http") {
                uri.authority?.let { "${uri.scheme}://$it" }
            } else {
                null
            }
            return ParsedInvite(code, hubUrl)
        }

        private fun asInviteCode(value: String): String? =
            runCatching { UUID.fromString(value) }.getOrNull()
                ?.toString()
                ?.takeIf { it.equals(value, ignoreCase = true) }
    }
}
