package org.llamenos.hotline.service

/**
 * Wraps a real-time event with the hub ID it originated from.
 *
 * ViewModels receive [AttributedHubEvent] from [org.llamenos.hotline.api.WebSocketService].
 * [hubId] comes from the server event envelope — the authoritative origin of the
 * event, independent of which hub is active in the UI. Per the multi-hub routing
 * axiom, subscribers must not discard or relabel events from non-active hubs;
 * the active hub controls browsing context only.
 *
 * @param T the underlying event type (e.g. [org.llamenos.hotline.model.LlamenosEvent])
 * @property hubId the originating hub ID from the server envelope
 * @property event the underlying event payload
 */
data class AttributedHubEvent<out T>(
    val hubId: String,
    val event: T,
)
