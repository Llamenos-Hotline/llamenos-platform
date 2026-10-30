package org.llamenos.hotline.hub

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.SerializationException
import org.llamenos.hotline.api.ApiException
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.api.WebSocketService
import org.llamenos.hotline.di.ApplicationScope
import org.llamenos.hotline.model.LlamenosEvent
import org.llamenos.protocol.Incident
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Every open hub incident the user is responsible for, across EVERY hub they are a
 * member of (B-INCIDENTS-CLIENTS, operator rule V).
 *
 * - The source of truth is the permission-filtered `GET /hubs/:hubId/incidents?open=true`,
 *   one per member hub. What the server returns is what is shown; a member it returns
 *   nothing to sees nothing. Reach is never decided here.
 * - `KIND_HUB_INCIDENT` is a doorbell: it re-reads THAT hub's list, once. The event's
 *   own `{incidentId, state}` is never stored or shown.
 * - Multi-hub axiom: nothing here reads or changes the active hub.
 */
@Singleton
class IncidentRepository @Inject constructor(
    private val apiService: ApiService,
    private val webSocketService: WebSocketService,
    @ApplicationScope private val scope: CoroutineScope,
) {

    data class State(
        /** hubId → that hub's open incidents, exactly as the server listed them. */
        val byHub: Map<String, List<Incident>> = emptyMap(),
        /** hubId → hub name, for labelling an incident in a hub other than the active one. */
        val hubNames: Map<String, String> = emptyMap(),
    ) {
        val incidents: List<Incident> get() = byHub.values.flatten()
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    private var listening = false

    /**
     * Start a session's view: forget the previous session's incidents, load every member
     * hub's list, and (once per process) listen for the doorbell and for relay reconnects.
     */
    fun beginSession() {
        _state.value = State()
        startListening()
        scope.launch { refreshAll() }
    }

    @Synchronized
    private fun startListening() {
        if (listening) return
        listening = true
        scope.launch {
            webSocketService.typedEvents.collect { attributed ->
                if (attributed.event is LlamenosEvent.HubIncidentChanged) refresh(attributed.hubId)
            }
        }
        // Doorbells published while the socket was down are not replayed to this client,
        // so a reconnect re-reads every hub.
        scope.launch {
            webSocketService.connectionState
                .drop(1)
                .filter { it == WebSocketService.ConnectionState.CONNECTED }
                .collect { refreshAll() }
        }
    }

    /** Re-read the member-hub list and every member hub's open incidents. */
    suspend fun refreshAll() {
        val hubs = try {
            apiService.getHubs().hubs
        } catch (e: ApiException) {
            Log.w(TAG, "hub list unavailable (HTTP ${e.code}); incidents unchanged")
            return
        } catch (e: IOException) {
            Log.w(TAG, "hub list unavailable (${e.message}); incidents unchanged")
            return
        }
        val fetched = coroutineScope {
            hubs.map { hub -> async { hub.id to fetch(hub.id) } }.awaitAll()
        }
        _state.update { current ->
            State(
                // A hub whose read failed keeps what it last showed: an incident must not
                // vanish because one request did.
                byHub = fetched.mapNotNull { (hubId, list) ->
                    (list ?: current.byHub[hubId])?.let { hubId to it }
                }.toMap(),
                hubNames = hubs.associate { it.id to it.name },
            )
        }
    }

    /** Re-read one hub's open incidents — the response to that hub's doorbell. */
    suspend fun refresh(hubId: String) {
        val list = fetch(hubId) ?: return
        _state.update { it.copy(byHub = it.byHub + (hubId to list)) }
    }

    private suspend fun fetch(hubId: String): List<Incident>? = try {
        apiService.getOpenIncidents(hubId).incidents
    } catch (e: ApiException) {
        Log.w(TAG, "incidents for $hubId unavailable (HTTP ${e.code})")
        null
    } catch (e: IOException) {
        Log.w(TAG, "incidents for $hubId unavailable (${e.message})")
        null
    } catch (e: SerializationException) {
        Log.w(TAG, "incidents for $hubId unreadable: ${e.message}")
        null
    }

    private companion object {
        const val TAG = "IncidentRepository"
    }
}
