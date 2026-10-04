package org.llamenos.hotline.ui.events

import org.junit.Assert.assertEquals
import org.junit.Test
import org.llamenos.hotline.model.EntityTypeDefinition
import org.llamenos.protocol.Record
import org.llamenos.protocol.SharedDefaultAccessLevel
import org.llamenos.protocol.SharedEntityTypeDefinitionCategory

/**
 * An event's child records split into sub-events (children whose entity type is an event)
 * and linked cases (every other child), matching the two event detail tabs.
 */
class EventsUiStateTest {

    private fun entityType(id: String, category: SharedEntityTypeDefinitionCategory) = EntityTypeDefinition(
        id = id,
        hubID = "hub-001",
        name = id,
        label = id,
        labelPlural = id,
        description = "",
        category = category,
        defaultAccessLevel = SharedDefaultAccessLevel.Assigned,
    )

    private fun record(id: String, entityTypeId: String) = Record(
        assignedTo = emptyList(),
        blindIndexes = emptyMap(),
        contactCount = 0.0,
        createdAt = "2026-09-01T00:00:00Z",
        createdBy = "pubkey",
        encryptedSummary = "",
        entityTypeID = entityTypeId,
        eventIDS = emptyList(),
        fileCount = 0.0,
        hubID = "hub-001",
        id = id,
        interactionCount = 0.0,
        parentRecordID = "event-parent",
        reportCount = 0.0,
        reportIDS = emptyList(),
        statusHash = "open",
        summaryEnvelopes = emptyList(),
        updatedAt = "2026-09-01T00:00:00Z",
    )

    private val state = EventsUiState(
        entityTypes = listOf(
            entityType("et-event", SharedEntityTypeDefinitionCategory.Event),
            entityType("et-case", SharedEntityTypeDefinitionCategory.Case),
        ),
        childRecords = listOf(
            record("child-event", "et-event"),
            record("child-case", "et-case"),
            record("child-unknown", "et-missing"),
        ),
    )

    @Test
    fun `sub-events are the children whose entity type is an event`() {
        assertEquals(listOf("child-event"), state.subEvents.map { it.id })
    }

    @Test
    fun `linked cases are every child that is not an event`() {
        assertEquals(listOf("child-case", "child-unknown"), state.linkedCases.map { it.id })
    }
}
