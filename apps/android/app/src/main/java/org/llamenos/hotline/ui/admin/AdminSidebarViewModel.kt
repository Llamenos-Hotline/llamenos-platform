package org.llamenos.hotline.ui.admin

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.model.MeResponse
import javax.inject.Inject

/** What the admin sidebar knows about the viewer's permissions. */
sealed interface AdminSidebarState {
    /** Not yet answered. The sidebar lists nothing until it is. */
    data object Loading : AdminSidebarState

    /** The viewer's effective permissions, as the server reports them. */
    data class Loaded(val permissions: List<String>) : AdminSidebarState

    /** The server could not be asked. The sidebar lists nothing and offers a retry. */
    data object Failed : AdminSidebarState
}

/**
 * Supplies the admin sidebar with the viewer's permissions from `GET /api/auth/me`
 * (the same endpoint and the same account-wide set the desktop client gates its
 * sidebar on). Until the server has answered, the sidebar shows nothing: an
 * unanswered permission check must not default to "may see everything".
 */
@HiltViewModel
class AdminSidebarViewModel @Inject constructor(
    private val apiService: ApiService,
) : ViewModel() {

    private val _state = MutableStateFlow<AdminSidebarState>(AdminSidebarState.Loading)
    val state: StateFlow<AdminSidebarState> = _state.asStateFlow()

    init {
        load()
    }

    fun load() {
        _state.value = AdminSidebarState.Loading
        viewModelScope.launch {
            _state.value = try {
                val me = apiService.request<MeResponse>("GET", "/api/auth/me")
                AdminSidebarState.Loaded(me.permissions)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                AdminSidebarState.Failed
            }
        }
    }
}
