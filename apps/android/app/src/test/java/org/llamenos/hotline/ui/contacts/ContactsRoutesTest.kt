package org.llamenos.hotline.ui.contacts

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.llamenos.hotline.MountedRoutes
import org.llamenos.hotline.MountedRoutes.Companion.json
import org.llamenos.hotline.MountedRoutes.Route
import org.llamenos.hotline.MountedServer

/**
 * The contacts screens (#1730, #2002), against a fake that answers only what
 * `apps/worker/routes/contacts.ts` mounts under `/api/hubs/:hubId/contacts`:
 *
 *     GET /contacts        -> { contacts: [summary], total }
 *     GET /contacts/:hash  -> { notes: [row], conversations: [row] }   ← this IS the timeline
 *
 * The Android screens called `GET /contacts/:hash/timeline` and `GET /contacts/:hash/relationships`
 * (neither mounted), decoded `GET /contacts/:hash` as `{ contact }` (a key the server never sends),
 * and searched with `GET /contacts/search` — which Hono resolves to `GET /contacts/:hash` with
 * `hash = "search"` and answers 200, so a search never failed and never searched.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ContactsRoutesTest {

    private val hash = "ab".repeat(32)
    private lateinit var server: MountedServer
    private lateinit var routes: MountedRoutes

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        routes = MountedRoutes(
            Route("GET", "/api/hubs/:hubId/contacts") {
                json(
                    """{"contacts":[
                    |{"contactHash":"$hash","firstSeen":"2026-10-01T09:00:00.000Z",
                    |"lastSeen":"2026-10-20T10:05:00.000Z","callCount":0,"conversationCount":1,"noteCount":2,"reportCount":0},
                    |{"contactHash":"${"cd".repeat(32)}","firstSeen":"2026-10-02T09:00:00.000Z",
                    |"lastSeen":"2026-10-19T10:05:00.000Z","callCount":0,"conversationCount":0,"noteCount":1,"reportCount":0}
                    |],"total":2}""".trimMargin(),
                )
            },
            Route("GET", "/api/hubs/:hubId/contacts/:hash") { call ->
                if (call.params["hash"] != hash) {
                    json("""{"notes":[],"conversations":[]}""")
                } else {
                    json(
                        """{"notes":[
                        |{"id":"note-old","authorPubkey":"aa","encryptedContent":"00","createdAt":"2026-10-01T09:00:00.000Z"},
                        |{"id":"note-new","authorPubkey":"aa","encryptedContent":"00","createdAt":"2026-10-15T09:00:00.000Z"}
                        |],"conversations":[
                        |{"id":"conv-1","channelType":"sms","status":"closed","createdAt":"2026-10-20T10:00:00.000Z",
                        |"lastMessageAt":"2026-10-20T10:05:00.000Z"}
                        |]}""".trimMargin(),
                    )
                }
            },
        )
        server = MountedServer(routes)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        server.shutdown()
    }

    @Test
    fun `the timeline is built from the contact route, newest first, with no unmounted sub-path`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = ContactTimelineViewModel(server.apiService)

            vm.loadTimeline(hash)
            advanceUntilIdle()

            assertTrue(
                "expected GET /api/hubs/hub-a/contacts/$hash, saw ${routes.seen()}",
                routes.seen().contains("GET /api/hubs/hub-a/contacts/$hash"),
            )
            assertTrue(
                "/timeline is not mounted: ${routes.seen()}",
                routes.seen().none { it.endsWith("/timeline") },
            )
            assertNull(vm.uiState.value.error)
            val events = vm.uiState.value.events
            assertEquals(listOf("conv-1", "note-new", "note-old"), events.map { it.id })
            assertEquals(listOf("conversation", "note", "note"), events.map { it.type })
            val conversation = events.first()
            assertEquals("sms", conversation.summary)
            assertEquals("closed", conversation.status)
            assertEquals(3, vm.uiState.value.total)
        }

    @Test
    fun `a contact with no interactions shows an empty timeline, not an error`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = ContactTimelineViewModel(server.apiService)

            vm.loadTimeline("ef".repeat(32))
            advanceUntilIdle()

            assertNull(vm.uiState.value.error)
            assertTrue(vm.uiState.value.events.isEmpty())
        }

    @Test
    fun `the profile is derived from the contact route and asks for nothing unmounted`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = ContactDetailViewModel(server.apiService)

            vm.loadContact(hash)
            advanceUntilIdle()

            assertNull("the profile must decode, got: ${vm.uiState.value.error}", vm.uiState.value.error)
            val contact = vm.uiState.value.contact!!
            assertEquals(hash, contact.contactHash)
            assertEquals(2, contact.noteCount)
            assertEquals(1, contact.conversationCount)
            assertEquals("2026-10-01T09:00:00.000Z", contact.firstSeen)
            assertEquals("2026-10-20T10:00:00.000Z", contact.lastSeen)
            assertEquals(
                "only the contact route is requested: ${routes.seen()}",
                listOf("GET /api/hubs/hub-a/contacts/$hash"),
                routes.seen(),
            )
        }

    @Test
    fun `searching filters the loaded contacts and never calls the shadowed search path`() =
        runTest(UnconfinedTestDispatcher()) {
            val vm = ContactsViewModel(server.apiService, server.activeHubState)
            advanceUntilIdle()
            assertEquals(2, vm.uiState.value.visibleContacts.size)
            routes.requests.clear()

            vm.setSearchQuery(hash.take(6))
            advanceUntilIdle()

            assertEquals(listOf(hash), vm.uiState.value.visibleContacts.map { it.contactHash })

            // Prefix only: a fragment from inside the hash names no contact.
            vm.setSearchQuery(hash.substring(1, 7))
            advanceUntilIdle()
            assertEquals(emptyList<String>(), vm.uiState.value.visibleContacts.map { it.contactHash })
            assertTrue(
                "GET /contacts/search is answered 200 by GET /contacts/:hash — it must not be called: ${routes.seen()}",
                routes.seen().none { it.contains("/search") },
            )
        }
}
