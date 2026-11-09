package org.llamenos.hotline.ui.hubs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.hub.HubMembership
import org.llamenos.hotline.hub.HubRepository
import javax.inject.Inject

/**
 * Chooses the hub the unlocked app browses (#1340): once when the main screen opens,
 * and again on every dashboard refresh. See [HubRepository.selectInitialHub].
 */
@HiltViewModel
class HubSelectionViewModel @Inject constructor(
    private val hubRepository: HubRepository,
    activeHubState: ActiveHubState,
) : ViewModel() {

    /**
     * No hub is active because the hub list could not be read (#2565) — not because the
     * user belongs to none. [org.llamenos.hotline.ui.hubs.HubMembershipBanner] reports it.
     */
    val membershipUnavailable: StateFlow<Boolean> =
        combine(activeHubState.activeHubId, activeHubState.membership) { hubId, membership ->
            hubId == null && membership is HubMembership.Failed
        }.stateIn(viewModelScope, SharingStarted.Eagerly, false)

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch { hubRepository.selectInitialHub() }
    }
}
