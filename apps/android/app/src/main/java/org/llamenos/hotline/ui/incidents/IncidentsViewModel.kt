package org.llamenos.hotline.ui.incidents

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.hub.IncidentRepository
import org.llamenos.protocol.Incident
import javax.inject.Inject

/** One incident as the banner and the incident view show it. */
data class IncidentRow(
    val incident: Incident,
    /** Name of the incident's hub when it is NOT the active hub; null for the active hub. */
    val otherHubName: String?,
    /** True when the incident is in a hub other than the active one. */
    val inOtherHub: Boolean,
)

/**
 * Presents [IncidentRepository] for the banner and the incident view. Reads the active
 * hub only to label and order rows — never to filter them, and never to change it.
 */
@HiltViewModel
class IncidentsViewModel @Inject constructor(
    private val repository: IncidentRepository,
    activeHubState: ActiveHubState,
) : ViewModel() {

    val rows: StateFlow<List<IncidentRow>> = combine(repository.state, activeHubState.activeHubId) { state, activeHubId ->
        state.incidents
            .sortedWith(compareBy<Incident>({ it.hubID != activeHubId }, { it.openedAt }))
            .map { incident ->
                val other = incident.hubID != activeHubId
                IncidentRow(
                    incident = incident,
                    otherHubName = if (other) state.hubNames[incident.hubID] else null,
                    inOtherHub = other,
                )
            }
    }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    /** The authenticated shell appeared: a new session's incidents. */
    fun beginSession() = repository.beginSession()

    /** The incident view opened (from the banner or the push): read every hub afresh. */
    fun refresh() {
        viewModelScope.launch { repository.refreshAll() }
    }
}
