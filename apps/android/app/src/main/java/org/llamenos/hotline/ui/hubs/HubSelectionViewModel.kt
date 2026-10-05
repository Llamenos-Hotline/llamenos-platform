package org.llamenos.hotline.ui.hubs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.launch
import org.llamenos.hotline.hub.HubRepository
import javax.inject.Inject

/**
 * Chooses the hub the unlocked app browses (#1340): once when the main screen opens,
 * and again on every dashboard refresh. See [HubRepository.selectInitialHub].
 */
@HiltViewModel
class HubSelectionViewModel @Inject constructor(
    private val hubRepository: HubRepository,
) : ViewModel() {

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch { hubRepository.selectInitialHub() }
    }
}
